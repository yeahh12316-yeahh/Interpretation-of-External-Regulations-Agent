import { inflateRawSync } from "node:zlib";

export const MAX_DOCX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 256;
export const MAX_DOCX_ENTRY_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const MAX_DOCX_TOTAL_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_DOCX_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
export const MAX_DOCX_COMPRESSION_RATIO = 200;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const ALLOWED_COMMON_FLAGS = 0x0800;
const ALLOWED_DEFLATE_FLAGS = ALLOWED_COMMON_FLAGS | 0x0006;

interface CentralEntry {
  readonly name: string;
  readonly nameBytes: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

interface LocalEntry {
  readonly central: CentralEntry;
  readonly start: number;
  readonly dataStart: number;
  readonly end: number;
}

const checkedEnd = (
  start: number,
  lengths: readonly number[],
  limit: number,
  label: string,
): number => {
  let end = start;
  for (const length of lengths) {
    if (!Number.isSafeInteger(length) || length < 0 || end > limit - length)
      throw new Error(`DOCX ZIP ${label} exceeds archive bounds`);
    end += length;
  }
  return end;
};

const addWithinLimit = (
  current: number,
  value: number,
  limit: number,
  label: string,
): number => {
  if (!Number.isSafeInteger(value) || value < 0 || current > limit - value)
    throw new Error(`DOCX ZIP ${label} limit exceeded`);
  return current + value;
};

const assertSupportedFlags = (flags: number, method: number): void => {
  if ((flags & 0x0001) !== 0)
    throw new Error("DOCX ZIP encrypted entries are unsupported");
  if ((flags & 0x0008) !== 0)
    throw new Error("DOCX ZIP data descriptors are unsupported");
  const allowed = method === 8 ? ALLOWED_DEFLATE_FLAGS : ALLOWED_COMMON_FLAGS;
  if ((flags & ~allowed) !== 0)
    throw new Error(`DOCX ZIP unsupported flags: 0x${flags.toString(16)}`);
};

const assertNoZip64Extra = (extra: Buffer): void => {
  let offset = 0;
  while (offset < extra.length) {
    if (offset > extra.length - 4)
      throw new Error("DOCX ZIP truncated extra field");
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset > extra.length - size)
      throw new Error("DOCX ZIP truncated extra field data");
    if (id === ZIP64_EXTRA_ID) throw new Error("DOCX ZIP64 is unsupported");
    offset += size;
  }
};

const decodeEntryName = (nameBytes: Buffer): string => {
  const name = nameBytes.toString("utf8");
  if (
    !name ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    name.split(/[\\/]/u).includes("..")
  )
    throw new Error("DOCX ZIP entry name is unsafe");
  return name;
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const findEndRecord = (bytes: Buffer): number => {
  if (bytes.length < 22) throw new Error("DOCX ZIP end record is truncated");
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== END_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error("DOCX ZIP end record is missing or truncated");
};

const parseCentralEntries = (
  bytes: Buffer,
  centralOffset: number,
  centralSize: number,
  entryCount: number,
): CentralEntry[] => {
  const centralEnd = checkedEnd(
    centralOffset,
    [centralSize],
    bytes.length,
    "central directory",
  );
  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      checkedEnd(offset, [46], centralEnd, "central header") > centralEnd ||
      bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    )
      throw new Error("DOCX ZIP central directory is truncated or corrupt");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      diskStart === 0xffff
    )
      throw new Error("DOCX ZIP64 is unsupported");
    if (diskStart !== 0)
      throw new Error("DOCX ZIP multi-disk entries are unsupported");
    if (method !== 0 && method !== 8)
      throw new Error(`unsupported DOCX compression method: ${method}`);
    assertSupportedFlags(flags, method);
    const recordEnd = checkedEnd(
      offset,
      [46, nameLength, extraLength, commentLength],
      centralEnd,
      "central entry",
    );
    const nameStart = offset + 46;
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = decodeEntryName(nameBytes);
    if (names.has(name)) throw new Error("DOCX ZIP duplicate entry name");
    names.add(name);
    assertNoZip64Extra(
      bytes.subarray(
        nameStart + nameLength,
        nameStart + nameLength + extraLength,
      ),
    );
    if (compressedSize > MAX_DOCX_ENTRY_COMPRESSED_BYTES)
      throw new Error("DOCX ZIP single compressed entry limit exceeded");
    if (uncompressedSize > MAX_DOCX_ENTRY_UNCOMPRESSED_BYTES)
      throw new Error("DOCX ZIP entry uncompressed size limit exceeded");
    totalCompressed = addWithinLimit(
      totalCompressed,
      compressedSize,
      MAX_DOCX_TOTAL_COMPRESSED_BYTES,
      "total compressed size",
    );
    totalUncompressed = addWithinLimit(
      totalUncompressed,
      uncompressedSize,
      MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES,
      "total uncompressed size",
    );
    if (
      (compressedSize === 0 && uncompressedSize > 0) ||
      (compressedSize > 0 &&
        uncompressedSize / compressedSize > MAX_DOCX_COMPRESSION_RATIO)
    )
      throw new Error("DOCX ZIP compression ratio limit exceeded");
    entries.push({
      name,
      nameBytes: Buffer.from(nameBytes),
      flags,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = recordEnd;
  }
  if (offset !== centralEnd)
    throw new Error("DOCX ZIP central directory size mismatch");
  return entries;
};

export const readStrictDocxEntries = (bytes: Buffer): Map<string, Buffer> => {
  if (bytes.length > MAX_DOCX_FILE_BYTES)
    throw new Error("DOCX input file size limit exceeded");
  const endOffset = findEndRecord(bytes);
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount)
    throw new Error("DOCX ZIP multi-disk archives are unsupported");
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  )
    throw new Error("DOCX ZIP64 is unsupported");
  if (entryCount > MAX_DOCX_ENTRIES)
    throw new Error("DOCX ZIP entries limit exceeded");
  if (entryCount === 0) throw new Error("DOCX ZIP contains no entries");
  if (
    checkedEnd(centralOffset, [centralSize], endOffset, "central directory") !==
    endOffset
  )
    throw new Error("DOCX ZIP central directory offset or size mismatch");
  const centralEntries = parseCentralEntries(
    bytes,
    centralOffset,
    centralSize,
    entryCount,
  );
  const localEntries: LocalEntry[] = [];
  for (const entry of centralEntries) {
    const offset = entry.localOffset;
    if (
      checkedEnd(offset, [30], centralOffset, "local header") > centralOffset ||
      bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE
    )
      throw new Error(`DOCX ZIP local header is missing: ${entry.name}`);
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const crc = bytes.readUInt32LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      throw new Error("DOCX ZIP64 is unsupported");
    assertSupportedFlags(flags, method);
    const dataStart = checkedEnd(
      offset,
      [30, nameLength, extraLength],
      centralOffset,
      "local entry",
    );
    const dataEnd = checkedEnd(
      dataStart,
      [compressedSize],
      centralOffset,
      "compressed data",
    );
    const localNameStart = offset + 30;
    const localName = bytes.subarray(
      localNameStart,
      localNameStart + nameLength,
    );
    assertNoZip64Extra(
      bytes.subarray(
        localNameStart + nameLength,
        localNameStart + nameLength + extraLength,
      ),
    );
    if (
      flags !== entry.flags ||
      method !== entry.method ||
      crc !== entry.crc32 ||
      compressedSize !== entry.compressedSize ||
      uncompressedSize !== entry.uncompressedSize ||
      !localName.equals(entry.nameBytes)
    )
      throw new Error(
        `DOCX ZIP local/central metadata mismatch: ${entry.name}`,
      );
    localEntries.push({
      central: entry,
      start: offset,
      dataStart,
      end: dataEnd,
    });
  }
  localEntries.sort((left, right) => left.start - right.start);
  if (
    localEntries[0]?.start !== 0 ||
    localEntries.at(-1)?.end !== centralOffset
  )
    throw new Error("DOCX ZIP local directory coverage is incomplete");
  for (let index = 1; index < localEntries.length; index += 1) {
    if (localEntries[index].start !== localEntries[index - 1].end)
      throw new Error("DOCX ZIP local entries overlap or contain gaps");
  }

  const expandedEntries = new Map<string, Buffer>();
  for (const local of localEntries) {
    const entry = local.central;
    const { method, uncompressedSize } = entry;
    const compressed = bytes.subarray(local.dataStart, local.end);
    let expanded: Buffer;
    try {
      expanded =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, {
              maxOutputLength: Math.max(1, uncompressedSize),
            });
    } catch {
      throw new Error(`DOCX ZIP compressed data is corrupt: ${entry.name}`);
    }
    if (expanded.length !== uncompressedSize)
      throw new Error(
        `DOCX ZIP declared and actual sizes differ: ${entry.name}`,
      );
    if (crc32(expanded) !== entry.crc32)
      throw new Error(`DOCX ZIP CRC mismatch: ${entry.name}`);
    if (!entry.name.endsWith("/")) expandedEntries.set(entry.name, expanded);
  }
  return expandedEntries;
};
