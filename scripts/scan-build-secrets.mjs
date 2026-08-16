import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_JSON_BYTES = 8 * 1024 * 1024;

const PATTERNS = [
  {
    type: "api-key-pattern",
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/gu,
  },
  {
    type: "aws-access-key-pattern",
    pattern: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/gu,
  },
  {
    type: "private-key-pattern",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  },
  {
    type: "authorization-token-pattern",
    pattern: /\bAuthorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  },
  {
    type: "bundled-secret-assignment",
    pattern:
      /\b(?:VITE_[A-Z0-9_]*(?:KEY|SECRET|TOKEN)|API_KEY|ACCESS_TOKEN)\s*[:=]\s*["'][^"'\s]{8,}["']/gu,
  },
  {
    type: "test-fixture-content",
    pattern:
      /synthetic-(?:session-key|production-smoke-key|model)|SYNTHETIC-(?:REG|OFFICIAL)|第一条 示例银行应当建立管理机制。|官方说明：第一条用于说明年度实施口径。/giu,
  },
];

const FORBIDDEN_BUILD_PATH =
  /(?:^|\/)(?:fixtures?|uploads?|mock-responses?|test-data)(?:\/|$)/iu;

const lineAt = (text, offset) => {
  let line = 1;
  for (let index = 0; index < offset; index += 1)
    if (text.charCodeAt(index) === 10) line += 1;
  return line;
};

const structuredArtifactTypes = (value) => {
  const findings = new Set();
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || item.depth > 32 || visited > 100_000) continue;
    visited += 1;
    const current = item.value;
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const child of current)
        pending.push({ value: child, depth: item.depth + 1 });
      continue;
    }
    if (
      Array.isArray(current.choices) &&
      current.choices.some(
        (choice) =>
          choice &&
          typeof choice === "object" &&
          choice.message &&
          typeof choice.message === "object" &&
          typeof choice.message.content === "string",
      )
    )
      findings.add("test-response-content");
    if (
      (current.sourceType === "regulatory_text" ||
        current.sourceType === "official_interpretation") &&
      typeof current.fileName === "string" &&
      typeof current.fileHash === "string" &&
      typeof current.content === "string"
    )
      findings.add("uploaded-sample-content");
    for (const child of Object.values(current))
      pending.push({ value: child, depth: item.depth + 1 });
  }
  return [...findings].sort();
};

const structuredFindings = (file, jsonBytes) => {
  if (!/\.json$/iu.test(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    throw new Error(`JSON build artifact is invalid: ${file}`);
  }
  return structuredArtifactTypes(parsed);
};

const startsWith = (bytes, signature) =>
  signature.every((value, index) => bytes[index] === value);

const isUnsupportedContainer = (file, bytes) =>
  /\.(?:zip|7z|rar|tar|tgz|bz2|xz|cab)$/iu.test(file) ||
  [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x52, 0x61, 0x72, 0x21],
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
    [0x42, 0x5a, 0x68],
  ].some((signature) => startsWith(bytes, signature));

const expandedArtifact = (file, bytes) => {
  if (isUnsupportedContainer(file, bytes))
    throw new Error(`unsupported compressed build artifact: ${file}`);
  if (
    /^ocr\/tesseract-7\.0\.0-data-1\.0\.0\/lang\/(?:chi_sim|eng)\.traineddata\.gz$/u.test(
      file,
    )
  )
    return { logicalFile: file, bytes };
  if (/\.gz$/iu.test(file)) {
    try {
      return {
        logicalFile: file.replace(/\.gz$/iu, ""),
        bytes: gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_JSON_BYTES }),
      };
    } catch {
      throw new Error(`gzip build artifact is invalid or too large: ${file}`);
    }
  }
  if (/\.br$/iu.test(file)) {
    try {
      return {
        logicalFile: file.replace(/\.br$/iu, ""),
        bytes: brotliDecompressSync(bytes, {
          maxOutputLength: MAX_EXPANDED_JSON_BYTES,
        }),
      };
    } catch {
      throw new Error(`Brotli build artifact is invalid or too large: ${file}`);
    }
  }
  return { logicalFile: file, bytes };
};

const textSurfaces = (bytes) => {
  const surfaces = [bytes.toString("utf8")];
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    surfaces.push(bytes.subarray(2).toString("utf16le"));
  return surfaces;
};

export const scanText = (text) => {
  const findings = [];
  for (const { type, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      findings.push({ type, line: lineAt(text, match.index ?? 0) });
    }
  }
  return findings.sort(
    (left, right) =>
      left.line - right.line || left.type.localeCompare(right.type),
  );
};

const filesUnder = async (directory, rootRealPath) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const candidate = path.join(directory, entry.name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink())
      throw new Error(
        `symbolic links are not allowed in build output: ${candidate}`,
      );
    const canonical = await realpath(candidate);
    const relative = path.relative(rootRealPath, canonical);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error(`build output escaped its root: ${candidate}`);
    if (info.isDirectory())
      files.push(...(await filesUnder(candidate, rootRealPath)));
    else if (info.isFile()) files.push(candidate);
    else throw new Error(`unsupported build output entry: ${candidate}`);
  }
  return files;
};

export const scanDirectory = async (directory, options = {}) => {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes <= 0 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes <= 0
  )
    throw new Error("build scan size limits must be positive safe integers");
  const resolved = path.resolve(directory);
  const info = await lstat(resolved).catch(() => null);
  if (!info)
    throw new Error(`required build directory is missing: ${resolved}`);
  if (info.isSymbolicLink())
    throw new Error(`build directory must not be a symbolic link: ${resolved}`);
  if (!info.isDirectory())
    throw new Error(`build scan target is not a directory: ${resolved}`);
  const rootRealPath = await realpath(resolved);
  const findings = [];
  let totalBytes = 0;
  for (const file of await filesUnder(rootRealPath, rootRealPath)) {
    const before = await lstat(file);
    if (!before.isFile())
      throw new Error(`build scan input is not a file: ${file}`);
    if (before.size > maxFileBytes)
      throw new Error(`build scan file size limit exceeded: ${file}`);
    totalBytes += before.size;
    if (totalBytes > maxTotalBytes)
      throw new Error(`build scan total size limit exceeded: ${rootRealPath}`);
    const bytes = await readFile(file);
    if (bytes.length !== before.size || bytes.length > maxFileBytes)
      throw new Error(`build scan input changed while reading: ${file}`);
    const relativeFile = path
      .relative(rootRealPath, file)
      .split(path.sep)
      .join("/");
    const expanded = expandedArtifact(relativeFile, bytes);
    if (FORBIDDEN_BUILD_PATH.test(relativeFile))
      findings.push({
        file: relativeFile,
        line: 1,
        type: "forbidden-build-artifact",
      });
    findings.push(
      ...[bytes, expanded.bytes].flatMap((surfaceBytes) =>
        textSurfaces(surfaceBytes).flatMap((text) =>
          scanText(text).map((finding) => ({
            ...finding,
            file: relativeFile,
          })),
        ),
      ),
      ...structuredFindings(expanded.logicalFile, expanded.bytes).map(
        (type) => ({
          file: relativeFile,
          line: 1,
          type,
        }),
      ),
    );
  }
  return [
    ...new Map(
      findings.map((finding) => [
        `${finding.file}:${finding.line}:${finding.type}`,
        finding,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.type.localeCompare(right.type),
  );
};

const main = async () => {
  const target = process.argv[2];
  if (!target)
    throw new Error(
      "usage: node scripts/scan-build-secrets.mjs <dist-directory>",
    );
  const findings = await scanDirectory(target);
  if (findings.length) {
    process.stderr.write(
      `BUILD SECRET SCAN FAIL\n${findings
        .map(({ file, line, type }) => `${file}:${line}:${type}`)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("BUILD SECRET SCAN PASS\n");
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`BUILD SECRET SCAN ERROR: ${message}\n`);
    process.exitCode = 1;
  });
