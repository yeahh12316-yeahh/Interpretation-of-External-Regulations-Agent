import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildMachineReportJson,
  evaluateValidatedBenchmark,
  loadBenchmarkBundle,
} from "../src/evaluation/benchmark-input";
import { renderEvaluationSummary } from "../src/evaluation/evaluation-report";

const valueAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
};

const generatedAtOverride = (): string | undefined => {
  const explicit = valueAfter("--generated-at");
  if (explicit) return explicit;
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (!epoch) return undefined;
  if (!/^\d+$/u.test(epoch))
    throw new Error("SOURCE_DATE_EPOCH must be integer seconds");
  return new Date(Number(epoch) * 1000).toISOString();
};

const main = async (): Promise<void> => {
  const root = process.cwd();
  const manifestPath = path.resolve(
    root,
    valueAfter("--manifest") ?? "tests/fixtures/benchmark/manifest.json",
  );
  const bundle = await loadBenchmarkBundle(
    manifestPath,
    valueAfter("--actual"),
  );
  const metrics = evaluateValidatedBenchmark(bundle);
  const outputDirectory = path.resolve(
    root,
    valueAfter("--output-dir") ?? "artifacts/benchmark",
  );
  const summary = renderEvaluationSummary({
    benchmarkId: bundle.manifest.benchmarkId,
    benchmarkVersion: bundle.manifest.benchmarkVersion,
    disclaimer: bundle.manifest.disclaimer,
    metrics,
  });
  const machineReport = buildMachineReportJson(
    bundle,
    metrics,
    generatedAtOverride(),
  );
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "benchmark-report.json"),
      machineReport,
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
