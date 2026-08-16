import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

export const scanDirectory = async (directory) => {
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
  for (const file of await filesUnder(rootRealPath, rootRealPath)) {
    const bytes = await readFile(file);
    const text = bytes.toString("utf8");
    const relativeFile = path
      .relative(rootRealPath, file)
      .split(path.sep)
      .join("/");
    if (FORBIDDEN_BUILD_PATH.test(relativeFile))
      findings.push({
        file: relativeFile,
        line: 1,
        type: "forbidden-build-artifact",
      });
    findings.push(
      ...scanText(text).map((finding) => ({ ...finding, file: relativeFile })),
    );
  }
  return findings.sort(
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
