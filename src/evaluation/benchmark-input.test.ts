import { mkdtemp, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildMachineReportJson, loadBenchmarkBundle } from "./benchmark-input";
import { evaluateFindings } from "./evaluate-findings";

const fixtureRoot = path.resolve("tests/fixtures/benchmark");
const fixtureManifest = path.join(fixtureRoot, "manifest.json");

const temporaryBundle = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "benchmark-boundary-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
};

describe("benchmark input boundary", () => {
  it("binds every manifest sample and corpus anchor to real verified files", async () => {
    const bundle = await loadBenchmarkBundle(fixtureManifest);

    expect(bundle.samples.map(({ sourceId }) => sourceId).sort()).toEqual([
      "SYNTH-OFFICIAL",
      "SYNTH-REG-DOCX",
      "SYNTH-REG-PDF",
      "SYNTH-REG-SCAN",
      "SYNTH-REG-TXT",
    ]);
    expect(bundle.samples.every(({ verified }) => verified)).toBe(true);
  });

  it("rejects a tampered source, path escape, and corpus anchor outside the manifest", async () => {
    const tamperedRoot = await temporaryBundle();
    const manifestPath = path.join(tamperedRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as any;
    await writeFile(
      path.join(tamperedRoot, manifest.samples[0].path),
      "tampered",
      "utf8",
    );
    await expect(loadBenchmarkBundle(manifestPath)).rejects.toThrow(
      /sha256|size/u,
    );

    const escapedRoot = await temporaryBundle();
    const escapedManifestPath = path.join(escapedRoot, "manifest.json");
    const escaped = JSON.parse(
      await readFile(escapedManifestPath, "utf8"),
    ) as any;
    escaped.samples[0].path = "../outside.pdf";
    await writeFile(escapedManifestPath, JSON.stringify(escaped), "utf8");
    await expect(loadBenchmarkBundle(escapedManifestPath)).rejects.toThrow(
      /benchmark root/u,
    );

    const anchorRoot = await temporaryBundle();
    const expectedPath = path.join(anchorRoot, "expected-findings.json");
    const expected = JSON.parse(await readFile(expectedPath, "utf8")) as any;
    expected.findings[0].sourceAnchors[0].sourceId = "UNDECLARED-SOURCE";
    await writeFile(expectedPath, JSON.stringify(expected), "utf8");
    await expect(
      loadBenchmarkBundle(path.join(anchorRoot, "manifest.json")),
    ).rejects.toThrow(/UNDECLARED-SOURCE/u);
  });

  it("emits byte-identical machine JSON with manifest-bound generatedAt", async () => {
    const bundle = await loadBenchmarkBundle(fixtureManifest);
    const metrics = evaluateFindings(bundle.expected, bundle.actual);

    const first = buildMachineReportJson(bundle, metrics);
    const second = buildMachineReportJson(bundle, metrics);

    expect(first).toBe(second);
    expect(JSON.parse(first).generatedAt).toBe(bundle.manifest.asOf);
  });
});
