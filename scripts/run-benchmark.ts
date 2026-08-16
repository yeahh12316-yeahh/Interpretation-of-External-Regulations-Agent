import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EvaluationCorpusSchema,
  evaluateFindings,
} from "../src/evaluation/evaluate-findings";
import {
  BenchmarkManifestSchema,
  renderEvaluationSummary,
} from "../src/evaluation/evaluation-report";

const valueAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
};

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await readFile(filePath, "utf8")) as unknown;

const main = async (): Promise<void> => {
  const root = process.cwd();
  const manifestPath = path.resolve(
    root,
    valueAfter("--manifest") ?? "tests/fixtures/benchmark/manifest.json",
  );
  const manifest = BenchmarkManifestSchema.parse(await readJson(manifestPath));
  const fixtureDirectory = path.dirname(manifestPath);
  const expectedPath = path.resolve(fixtureDirectory, manifest.expectedFile);
  const actualPath = path.resolve(
    fixtureDirectory,
    valueAfter("--actual") ?? manifest.actualFile,
  );
  const expected = EvaluationCorpusSchema.parse(await readJson(expectedPath));
  const actual = EvaluationCorpusSchema.parse(await readJson(actualPath));
  const metrics = evaluateFindings(expected, actual);
  const outputDirectory = path.resolve(
    root,
    valueAfter("--output-dir") ?? "artifacts/benchmark",
  );
  const summary = renderEvaluationSummary({
    benchmarkId: manifest.benchmarkId,
    benchmarkVersion: manifest.benchmarkVersion,
    disclaimer: manifest.disclaimer,
    metrics,
  });
  const machineReport = {
    schemaVersion: 1,
    benchmarkId: manifest.benchmarkId,
    benchmarkVersion: manifest.benchmarkVersion,
    generatedAt: new Date().toISOString(),
    disclaimer: manifest.disclaimer,
    inputs: {
      manifest: path.basename(manifestPath),
      expected: path.basename(expectedPath),
      actual: path.basename(actualPath),
    },
    coverage: manifest.coverage,
    metrics,
  };
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "benchmark-report.json"),
      `${JSON.stringify(machineReport, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(outputDirectory, "benchmark-summary.txt"),
      summary,
      "utf8",
    ),
  ]);
  process.stdout.write(summary);
  if (!metrics.releaseGate.passed) process.exitCode = 1;
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`BENCHMARK ERROR: ${message}\n`);
  process.exitCode = 1;
});
