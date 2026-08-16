import { mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import { Document, Packer, Paragraph } from "docx";

import { scanPaths } from "./scan-secrets";

const localZipEntry = (
  name: string,
  content: Buffer,
  declaredUncompressed = content.length,
): Buffer => {
  const compressed = deflateRawSync(content);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(declaredUncompressed, 22);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([header, Buffer.from(name), compressed]);
};

const testCrc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

interface TestZipEntry {
  readonly name: string;
  readonly content: Buffer;
  readonly method?: number;
  readonly localFlags?: number;
  readonly centralFlags?: number;
  readonly localName?: string;
  readonly centralName?: string;
  readonly localCrc?: number;
  readonly centralCrc?: number;
  readonly localCompressedSize?: number;
  readonly centralCompressedSize?: number;
  readonly localUncompressedSize?: number;
  readonly centralUncompressedSize?: number;
  readonly centralLocalOffset?: number;
}

const strictZip = (entries: readonly TestZipEntry[]): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const compressed =
      method === 0 ? entry.content : deflateRawSync(entry.content);
    const crc = testCrc32(entry.content);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const centralName = Buffer.from(entry.centralName ?? entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.localFlags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.localCrc ?? crc, 14);
    local.writeUInt32LE(entry.localCompressedSize ?? compressed.length, 18);
    local.writeUInt32LE(
      entry.localUncompressedSize ?? entry.content.length,
      22,
    );
    local.writeUInt16LE(localName.length, 26);
    const localRecord = Buffer.concat([local, localName, compressed]);
    localParts.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.centralFlags ?? entry.localFlags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entry.centralCrc ?? entry.localCrc ?? crc, 16);
    central.writeUInt32LE(
      entry.centralCompressedSize ??
        entry.localCompressedSize ??
        compressed.length,
      20,
    );
    central.writeUInt32LE(
      entry.centralUncompressedSize ??
        entry.localUncompressedSize ??
        entry.content.length,
      24,
    );
    central.writeUInt16LE(centralName.length, 28);
    central.writeUInt32LE(entry.centralLocalOffset ?? localOffset, 42);
    centralParts.push(Buffer.concat([central, centralName]));
    localOffset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

describe("scanPaths", () => {
  it("reports exact forbidden needles and credential-shaped values reproducibly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-scan-"));
    await writeFile(path.join(root, "safe.js"), "const value = 'safe';\n");
    expect(await scanPaths([root], ["private-endpoint.example"])).toEqual([]);

    await writeFile(
      path.join(root, "leak.js"),
      "const key = 'sk-abcdefghijklmnopqrstuvwxyz123456';\nconst endpoint = 'private-endpoint.example';\n",
    );
    expect(await scanPaths([root], ["private-endpoint.example"])).toEqual([
      expect.stringMatching(/leak\.js:credential_pattern/u),
      expect.stringMatching(/leak\.js:forbidden_needle/u),
    ]);
  });

  it("scans NUL-containing binaries, PDF bytes, and compressed DOCX entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-binary-"));
    const validPdf = await readFile(
      path.resolve("tests/fixtures/benchmark/sources/regulatory-scan.pdf"),
    );
    await writeFile(
      path.join(root, "nul.pdf"),
      Buffer.concat([
        validPdf,
        Buffer.from("\n%", "ascii"),
        Buffer.from([0, 1, 2]),
        Buffer.from("private-endpoint.example\n", "ascii"),
      ]),
    );
    const docx = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [new Paragraph("sk-abcdefghijklmnopqrstuvwxyz123456")],
          },
        ],
      }),
    );
    await writeFile(path.join(root, "compressed.docx"), docx);

    await expect(
      scanPaths([root], ["private-endpoint.example"]),
    ).resolves.toEqual([
      expect.stringMatching(/compressed\.docx:credential_pattern/u),
      expect.stringMatching(/nul\.pdf:forbidden_needle/u),
    ]);
  });

  it("fails closed when a required scan root is missing and accepts clean assets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-clean-"));
    await writeFile(path.join(root, "clean.bin"), Buffer.from([0, 1, 2, 3]));
    await expect(scanPaths([root])).resolves.toEqual([]);
    await expect(scanPaths([path.join(root, "missing-dist")])).rejects.toThrow(
      /required scan root/u,
    );
  });

  it("bounds DOCX entry count, declared size, output size, and compression ratio", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-zip-bounds-"));
    const cases = [
      [
        "declared.docx",
        localZipEntry("word/document.xml", Buffer.from("safe"), 200_000_000),
      ],
      [
        "ratio.docx",
        localZipEntry("word/document.xml", Buffer.alloc(2_000_000, 65)),
      ],
      [
        "flood.docx",
        Buffer.concat(
          Array.from({ length: 300 }, (_, index) =>
            localZipEntry(`word/item-${index}.xml`, Buffer.from("safe")),
          ),
        ),
      ],
    ] as const;
    for (const [name, bytes] of cases) {
      const file = path.join(root, name);
      await writeFile(file, bytes);
      await expect(scanPaths([file])).rejects.toThrow(
        /DOCX|ZIP|limit|ratio|size|entries/u,
      );
    }
  });

  it("rejects DOCX CRC corruption, local/central mismatch, truncation, duplicates, and unsafe flags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-zip-integrity-"));
    const content = Buffer.from("<w:document>safe</w:document>");
    const valid = strictZip([{ name: "word/document.xml", content }]);
    const corrupt = Buffer.from(valid);
    const nameLength = corrupt.readUInt16LE(26);
    corrupt[30 + nameLength + 1] ^= 0xff;
    const cases = [
      [
        "crc-zero.docx",
        strictZip([
          {
            name: "word/document.xml",
            content,
            localCrc: 0,
            centralCrc: 0,
          },
        ]),
      ],
      ["corrupt.docx", corrupt],
      [
        "metadata-mismatch.docx",
        strictZip([
          {
            name: "word/document.xml",
            localName: "word/local.xml",
            content,
          },
        ]),
      ],
      [
        "crc-metadata-mismatch.docx",
        strictZip([
          {
            name: "word/document.xml",
            content,
            centralCrc: (testCrc32(content) + 1) >>> 0,
          },
        ]),
      ],
      [
        "size-metadata-mismatch.docx",
        strictZip([
          {
            name: "word/document.xml",
            content,
            centralUncompressedSize: content.length + 1,
          },
        ]),
      ],
      ["truncated.docx", valid.subarray(0, valid.length - 8)],
      [
        "duplicate.docx",
        strictZip([
          { name: "word/document.xml", content },
          { name: "word/document.xml", content },
        ]),
      ],
      [
        "encrypted.docx",
        strictZip([{ name: "word/document.xml", content, localFlags: 1 }]),
      ],
      [
        "descriptor.docx",
        strictZip([{ name: "word/document.xml", content, localFlags: 8 }]),
      ],
      [
        "unsupported-method.docx",
        strictZip([{ name: "word/document.xml", content, method: 9 }]),
      ],
      [
        "zip64-marker.docx",
        strictZip([
          {
            name: "word/document.xml",
            content,
            localCompressedSize: 0xffffffff,
          },
        ]),
      ],
      [
        "overlap-offset.docx",
        strictZip([
          { name: "word/first.xml", content },
          {
            name: "word/second.xml",
            content,
            centralLocalOffset: 0,
          },
        ]),
      ],
    ] as const;
    for (const [name, bytes] of cases) {
      const file = path.join(root, name);
      await writeFile(file, bytes);
      await expect(scanPaths([file]), name).rejects.toThrow(
        /DOCX|ZIP|CRC|central|local|truncat|duplicate|flag|encrypt|descriptor|corrupt/u,
      );
    }
  });

  it("enforces whole-file, single/total compressed, ratio, entry, and expanded-size bounds before allocation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-zip-limits-"));
    const small = Buffer.from("safe");
    const cases = [
      [
        "single-compressed.docx",
        strictZip([
          {
            name: "word/document.xml",
            content: small,
            localCompressedSize: 20 * 1024 * 1024,
          },
        ]),
      ],
      [
        "total-compressed.docx",
        strictZip(
          Array.from({ length: 3 }, (_, index) => ({
            name: `word/item-${index}.xml`,
            content: small,
            localCompressedSize: 12 * 1024 * 1024,
          })),
        ),
      ],
      [
        "ratio.docx",
        strictZip([
          {
            name: "word/document.xml",
            content: small,
            localUncompressedSize: 10 * 1024 * 1024,
          },
        ]),
      ],
      [
        "single-expanded.docx",
        strictZip([
          {
            name: "word/document.xml",
            content: small,
            localUncompressedSize: 40 * 1024 * 1024,
          },
        ]),
      ],
      [
        "total-expanded.docx",
        strictZip(
          Array.from({ length: 5 }, (_, index) => ({
            name: `word/expanded-${index}.xml`,
            content: small,
            localUncompressedSize: 30 * 1024 * 1024,
          })),
        ),
      ],
      [
        "expanded-mismatch.docx",
        strictZip([
          {
            name: "word/document.xml",
            content: small,
            localUncompressedSize: small.length + 1,
          },
        ]),
      ],
      [
        "entry-flood.docx",
        strictZip(
          Array.from({ length: 257 }, (_, index) => ({
            name: `word/item-${index}.xml`,
            content: small,
          })),
        ),
      ],
    ] as const;
    for (const [name, bytes] of cases) {
      const file = path.join(root, name);
      await writeFile(file, bytes);
      await expect(scanPaths([file]), name).rejects.toThrow(
        /DOCX|ZIP|limit|ratio|size|entries|mismatch|bounds/u,
      );
    }

    const oversized = path.join(root, "whole-file.docx");
    await writeFile(oversized, "PK");
    await truncate(oversized, 70 * 1024 * 1024);
    await expect(scanPaths([oversized])).rejects.toThrow(
      /file|input|DOCX|size|limit/u,
    );
  });

  it("accepts a legitimate clean DOCX with a complete central directory and valid CRC", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-valid-docx-"));
    const docx = await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph("合成且无敏感信息")] }],
      }),
    );
    const file = path.join(root, "valid.docx");
    await writeFile(file, docx);
    await expect(scanPaths([file])).resolves.toEqual([]);
  });

  it("returns a controlled CLI exit 1 for a corrupt DOCX instead of silently succeeding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-cli-corrupt-"));
    const file = path.join(root, "corrupt.docx");
    await writeFile(file, Buffer.from("PK truncated"));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("scripts/scan-secrets.ts"),
        "--root",
        file,
      ],
      { cwd: path.resolve(), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SECRET SCAN ERROR.*DOCX ZIP/su);
    expect(result.stdout).not.toContain("SECRET SCAN PASS");
  });
});
