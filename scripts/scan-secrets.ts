import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const CREDENTIAL_PATTERNS = [
  /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,}(?=$|[^A-Za-z0-9_-])/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}(?=$|[^A-Z0-9])/u,
] as const;

const filesUnder = async (root: string): Promise<string[]> => {
  const info = await stat(root).catch(() => null);
  if (!info) throw new Error(`required scan root is missing: ${root}`);
  if (info.isFile()) return [root];
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
};

const zipReadableEntries = (bytes: Buffer): string[] => {
  const entries: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 30; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;
    const flags = view.getUint16(offset + 6, true);
    if ((flags & 0x08) !== 0)
      throw new Error("DOCX data descriptor prevents complete secret scan");
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString();
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (!name.endsWith("/")) {
      const expanded =
        method === 0
          ? compressed
          : method === 8
            ? inflateRawSync(compressed)
            : null;
      if (!expanded)
        throw new Error(`unsupported DOCX compression method: ${method}`);
      entries.push(expanded.toString("latin1"), expanded.toString("utf8"));
    }
    offset = dataStart + compressedSize - 1;
  }
  return entries;
};

const pdfExtractedText = async (bytes: Buffer): Promise<string> => {
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  try {
    const document = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items.map((item) => ("str" in item ? item.str : "")).join(""),
      );
    }
    return pages.join("\n");
  } finally {
    await loadingTask.destroy();
  }
};

const scanSurfaces = async (file: string, bytes: Buffer): Promise<string[]> => {
  const surfaces = [bytes.toString("latin1"), bytes.toString("utf8")];
  if (file.toLowerCase().endsWith(".docx"))
    surfaces.push(...zipReadableEntries(bytes));
  if (file.toLowerCase().endsWith(".pdf"))
    surfaces.push(await pdfExtractedText(bytes));
  return surfaces;
};

export const scanPaths = async (
  roots: readonly string[],
  forbiddenNeedles: readonly string[] = [],
  options: { readonly includeTestFiles?: boolean } = {},
): Promise<string[]> => {
  const findings: string[] = [];
  const files = (
    await Promise.all(roots.map((root) => filesUnder(path.resolve(root))))
  )
    .flat()
    .sort();
  for (const file of files) {
    if (
      options.includeTestFiles === false &&
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
    )
      continue;
    const bytes = await readFile(file);
    const surfaces = await scanSurfaces(file, bytes);
    if (
      surfaces.some((text) =>
        CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)),
      )
    )
      findings.push(`${file}:credential_pattern`);
    for (const needle of forbiddenNeedles) {
      if (needle && surfaces.some((text) => text.includes(needle)))
        findings.push(`${file}:forbidden_needle`);
    }
  }
  return findings.sort();
};

const valuesAfter = (flag: string): string[] =>
  process.argv.flatMap((value, index) =>
    value === flag && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );

const main = async (): Promise<void> => {
  const roots = valuesAfter("--root");
  const findings = await scanPaths(
    roots.length ? roots : ["src", "scripts", "dist", "artifacts"],
    valuesAfter("--needle"),
    { includeTestFiles: false },
  );
  if (findings.length) {
    process.stderr.write(`SECRET SCAN FAIL\n${findings.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("SECRET SCAN PASS\n");
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  void main();
