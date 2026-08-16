import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanDirectory, scanText } from "./scan-build-secrets.mjs";

describe("build secret scanner", () => {
  it("reports API key patterns with stable line numbers", () => {
    expect(scanText('const key="sk-test-secret"')).toEqual([
      { type: "api-key-pattern", line: 1 },
    ]);
    expect(scanText("safe line\nconst value = 'sk-another-secret'")).toEqual([
      { type: "api-key-pattern", line: 2 },
    ]);
    expect(scanText("\nsk-leading-line-secret")).toEqual([
      { type: "api-key-pattern", line: 2 },
    ]);
  });

  it("accepts ordinary product copy", () => {
    expect(scanText("外规解读agent")).toEqual([]);
  });

  it("does not skip NUL-containing build assets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-secret-scan-"));
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "bundle.bin"),
      Buffer.from("prefix\0sk-binary-secret\0suffix", "utf8"),
    );

    await expect(scanDirectory(root)).resolves.toEqual([
      expect.objectContaining({
        file: "assets/bundle.bin",
        line: 1,
        type: "api-key-pattern",
      }),
    ]);
  });

  it("rejects uploaded fixtures and synthetic model material in dist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-fixture-scan-"));
    await mkdir(path.join(root, "uploads"));
    await writeFile(
      path.join(root, "uploads", "regulation.txt"),
      "第一条 示例银行应当建立管理机制。",
    );

    await expect(scanDirectory(root)).resolves.toEqual([
      {
        file: "uploads/regulation.txt",
        line: 1,
        type: "forbidden-build-artifact",
      },
      {
        file: "uploads/regulation.txt",
        line: 1,
        type: "test-fixture-content",
      },
    ]);
  });

  it("fails closed when the required build directory is missing", async () => {
    const root = path.join(
      os.tmpdir(),
      `missing-build-secret-scan-${process.pid}-${Date.now()}`,
    );
    await expect(scanDirectory(root)).rejects.toThrow(
      /required build directory is missing/u,
    );
  });

  it("fails closed on symbolic links in build output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-symlink-scan-"));
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "safe");
    await mkdir(path.join(root, "dist"));
    await symlink(outside, path.join(root, "dist", "linked.txt"));
    await expect(scanDirectory(path.join(root, "dist"))).rejects.toThrow(
      /symbolic links are not allowed/u,
    );
  });

  it("fails closed before reading an oversized file or aggregate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-bounds-scan-"));
    await writeFile(path.join(root, "one.bin"), Buffer.alloc(6));
    await expect(
      scanDirectory(root, { maxFileBytes: 5, maxTotalBytes: 100 }),
    ).rejects.toThrow(/file size limit/u);

    await writeFile(path.join(root, "one.bin"), Buffer.alloc(5));
    await writeFile(path.join(root, "two.bin"), Buffer.alloc(5));
    await expect(
      scanDirectory(root, { maxFileBytes: 10, maxTotalBytes: 9 }),
    ).rejects.toThrow(/total size limit/u);
  });

  it("detects nested generic model responses even when gzip-compressed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-response-scan-"));
    await mkdir(path.join(root, "assets", "cache"), { recursive: true });
    const response = JSON.stringify({
      envelope: {
        result: {
          choices: [
            { message: { content: "model-authored fixture response" } },
          ],
        },
      },
    });
    await writeFile(
      path.join(root, "assets", "cache", "payload.json.gz"),
      gzipSync(response),
    );

    await expect(scanDirectory(root)).resolves.toEqual([
      {
        file: "assets/cache/payload.json.gz",
        line: 1,
        type: "test-response-content",
      },
    ]);
  });

  it("detects nested uploaded source records without relying on names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-upload-scan-"));
    await writeFile(
      path.join(root, "state.json"),
      JSON.stringify({
        cache: {
          source: {
            sourceType: "regulatory_text",
            fileName: "customer-regulation.pdf",
            fileHash: "a".repeat(64),
            content: "private uploaded body",
          },
        },
      }),
    );
    await expect(scanDirectory(root)).resolves.toEqual([
      {
        file: "state.json",
        line: 1,
        type: "uploaded-sample-content",
      },
    ]);
  });

  it("detects Brotli-compressed generic responses and UTF-16LE secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-encoding-scan-"));
    const response = JSON.stringify({
      nested: {
        choices: [{ message: { content: "compressed response" } }],
      },
    });
    await writeFile(
      path.join(root, "response.json.br"),
      brotliCompressSync(response),
    );
    await writeFile(
      path.join(root, "credential.bin"),
      Buffer.from(`\ufeffsk-utf16le-secret`, "utf16le"),
    );
    await expect(scanDirectory(root)).resolves.toEqual([
      {
        file: "credential.bin",
        line: 1,
        type: "api-key-pattern",
      },
      {
        file: "response.json.br",
        line: 1,
        type: "test-response-content",
      },
    ]);
  });

  it("fails closed on an unsupported compressed container", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-container-scan-"));
    await writeFile(
      path.join(root, "opaque.zip"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
    );
    await expect(scanDirectory(root)).rejects.toThrow(
      /unsupported compressed build artifact/u,
    );
  });

  it("does not treat an arbitrary traineddata suffix as an opaque allowlist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-opaque-scan-"));
    await writeFile(
      path.join(root, "untrusted.traineddata.gz"),
      Buffer.from("not gzip"),
    );
    await expect(scanDirectory(root)).rejects.toThrow(
      /gzip build artifact is invalid/u,
    );
  });
});
