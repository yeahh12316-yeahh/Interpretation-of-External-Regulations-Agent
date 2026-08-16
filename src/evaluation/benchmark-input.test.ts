import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildMachineReportJson,
  evaluateValidatedBenchmark,
  loadBenchmarkBundle,
} from "./benchmark-input";
import { evaluateFindings } from "./evaluate-findings";

const fixtureRoot = path.resolve("tests/fixtures/benchmark");
const fixtureManifest = path.join(fixtureRoot, "manifest.json");

const temporaryBundle = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "benchmark-boundary-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
};

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const blankPdf = (): Buffer => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n\r\n`)
    .join("");
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
};

const onePixelPdf = (): Buffer => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n335577>\nendstream",
    "<< /Length 32 >>\nstream\nq\n300 0 0 300 0 0 cm\n/Im1 Do\nQ\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im1 3 0 R >> >> /Contents 4 0 R >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f\r\n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n\r\n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
};

const rewriteJson = async (
  filePath: string,
  mutate: (value: any) => void,
): Promise<void> => {
  const value = JSON.parse(await readFile(filePath, "utf8")) as any;
  mutate(value);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
    expect(bundle.validatedAnchorCount).toBeGreaterThan(0);
    expect(
      bundle.manifest.samples.find(
        ({ sourceId }) => sourceId === "SYNTH-REG-SCAN",
      )?.groundTruth,
    ).toEqual(
      expect.objectContaining({
        reviewer: "合成基准复核人",
        reviewedAt: "2026-08-14T00:00:00.000Z",
      }),
    );
  });

  it("rejects symlinks and duplicate canonical source or attachment files", async () => {
    const symlinkRoot = await temporaryBundle();
    const sourcePath = path.join(symlinkRoot, "sources/regulatory-text.pdf");
    const outside = path.join(
      await mkdtemp(path.join(tmpdir(), "benchmark-outside-")),
      "outside.pdf",
    );
    await copyFile(sourcePath, outside);
    await unlink(sourcePath);
    await symlink(outside, sourcePath);
    await expect(
      loadBenchmarkBundle(path.join(symlinkRoot, "manifest.json")),
    ).rejects.toThrow(/symlink/u);

    const duplicateRoot = await temporaryBundle();
    const manifestPath = path.join(duplicateRoot, "manifest.json");
    await rewriteJson(manifestPath, (manifest) => {
      const long = manifest.samples.find(
        ({ sourceId }: any) => sourceId === "SYNTH-REG-TXT",
      );
      const official = manifest.samples.find(
        ({ sourceId }: any) => sourceId === "SYNTH-OFFICIAL",
      );
      official.path = long.path;
      official.sha256 = long.sha256;
      official.size = long.size;
    });
    await expect(loadBenchmarkBundle(manifestPath)).rejects.toThrow(
      /duplicate canonical/u,
    );
  });

  it("rejects fabricated quotes and wrong page, paragraph, or article locators", async () => {
    const mutations = [
      (corpus: any) => {
        corpus.findings[0].sourceAnchors[0].quote = "第一条 捏造的监管要求。";
      },
      (corpus: any) => {
        corpus.findings.find(
          ({ findingId }: any) => findingId === "EXP-DATE",
        ).sourceAnchors[0].page = 1;
      },
      (corpus: any) => {
        corpus.findings.find(
          ({ findingId }: any) => findingId === "EXP-BAN",
        ).sourceAnchors[0].paragraphIndex = 0;
      },
      (corpus: any) => {
        corpus.findings.find(
          ({ findingId }: any) => findingId === "EXP-TRANSITION",
        ).sourceAnchors[0].article = "第十二条";
      },
    ];
    for (const mutate of mutations) {
      const root = await temporaryBundle();
      await rewriteJson(path.join(root, "expected-findings.json"), mutate);
      await expect(
        loadBenchmarkBundle(path.join(root, "manifest.json")),
      ).rejects.toThrow(/anchor|quote|locator|article/u);
    }
  });

  it("rejects wrong official pairing and tampered scan ground truth", async () => {
    const pairingRoot = await temporaryBundle();
    await rewriteJson(
      path.join(pairingRoot, "expected-findings.json"),
      (corpus) => {
        corpus.officialPrimarySourceIds = {
          "SYNTH-OFFICIAL": "SYNTH-REG-PDF",
        };
      },
    );
    await expect(
      loadBenchmarkBundle(path.join(pairingRoot, "manifest.json")),
    ).rejects.toThrow(/official|primary|pair/u);

    const truthRoot = await temporaryBundle();
    const truthPath = path.join(
      truthRoot,
      "sources/regulatory-scan.ground-truth.json",
    );
    await writeFile(truthPath, "{}", "utf8");
    await expect(
      loadBenchmarkBundle(path.join(truthRoot, "manifest.json")),
    ).rejects.toThrow(/ground-truth|sha256|size/u);
  });

  it("rejects a blank scan PDF even when its declared hash and size match", async () => {
    const root = await temporaryBundle();
    const manifestPath = path.join(root, "manifest.json");
    const bytes = blankPdf();
    const blankPath = path.join(root, "sources/blank-scan.pdf");
    await writeFile(blankPath, bytes);
    await rewriteJson(manifestPath, (manifest) => {
      const sample = manifest.samples.find(
        ({ sourceId }: any) => sourceId === "SYNTH-REG-SCAN",
      );
      sample.path = "sources/blank-scan.pdf";
      sample.sha256 = digest(bytes);
      sample.size = bytes.length;
    });

    await expect(loadBenchmarkBundle(manifestPath)).rejects.toThrow(/image/u);

    const pixelRoot = await temporaryBundle();
    const pixelManifest = path.join(pixelRoot, "manifest.json");
    const pixelBytes = onePixelPdf();
    const pixelPath = path.join(pixelRoot, "sources/one-pixel.pdf");
    await writeFile(pixelPath, pixelBytes);
    await rewriteJson(pixelManifest, (manifest) => {
      const sample = manifest.samples.find(
        ({ sourceId }: any) => sourceId === "SYNTH-REG-SCAN",
      );
      sample.path = "sources/one-pixel.pdf";
      sample.sha256 = digest(pixelBytes);
      sample.size = pixelBytes.length;
    });
    await expect(loadBenchmarkBundle(pixelManifest)).rejects.toThrow(
      /image.*(?:small|uniform|blank)/u,
    );
  });

  it("blocks raw-corpus release metrics and only unlocks fixture-validated bundles", async () => {
    const bundle = await loadBenchmarkBundle(fixtureManifest);

    expect(
      evaluateFindings(bundle.expected, bundle.actual).releaseGate.failures,
    ).toContain("fixture_evidence_not_validated");
    expect(evaluateValidatedBenchmark(bundle).releaseGate).toEqual({
      passed: true,
      failures: [],
    });
  });

  it("rejects expected-as-actual, forged OCR truth, and forged or cloned capabilities", async () => {
    await expect(
      loadBenchmarkBundle(fixtureManifest, "expected-findings.json"),
    ).rejects.toThrow(/expected.*actual|canonical/u);

    const root = await temporaryBundle();
    for (const name of ["expected-findings.json", "actual-findings.json"]) {
      await rewriteJson(path.join(root, name), (corpus) => {
        corpus.ocrPages[0].text = "双方同时伪造的 OCR 文本";
      });
    }
    await expect(
      loadBenchmarkBundle(path.join(root, "manifest.json")),
    ).rejects.toThrow(/OCR.*ground-truth|expected OCR/u);

    const bundle = await loadBenchmarkBundle(fixtureManifest);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(() => ((bundle.actual as any).ocrPages = [])).toThrow();
    await expect(() =>
      evaluateValidatedBenchmark(structuredClone(bundle) as any),
    ).toThrow(/provenance|loader/u);
    await expect(() =>
      evaluateValidatedBenchmark({ ...bundle } as any),
    ).toThrow(/provenance|loader/u);
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
    const metrics = evaluateValidatedBenchmark(bundle);

    const first = buildMachineReportJson(bundle, metrics);
    const second = buildMachineReportJson(bundle, metrics);

    expect(first).toBe(second);
    expect(JSON.parse(first).generatedAt).toBe(bundle.manifest.asOf);
  });
});
