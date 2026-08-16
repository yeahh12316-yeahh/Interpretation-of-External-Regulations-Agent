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
});
