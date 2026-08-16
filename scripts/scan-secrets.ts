import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  if (!info) return [];
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
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)))
      findings.push(`${file}:credential_pattern`);
    for (const needle of forbiddenNeedles) {
      if (needle && text.includes(needle))
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
