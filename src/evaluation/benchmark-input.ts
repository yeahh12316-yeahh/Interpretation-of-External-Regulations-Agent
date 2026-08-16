import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";

import {
  EvaluationCorpusSchema,
  type EvaluationCorpus,
  type EvaluationMetrics,
} from "./evaluate-findings";
import {
  BenchmarkManifestSchema,
  type BenchmarkManifest,
} from "./evaluation-report";

export interface VerifiedBenchmarkSample {
  readonly sourceId: string;
  readonly verified: true;
  readonly absolutePath: string;
}

export interface BenchmarkBundle {
  readonly manifest: BenchmarkManifest;
  readonly manifestPath: string;
  readonly expectedPath: string;
  readonly actualPath: string;
  readonly expected: EvaluationCorpus;
  readonly actual: EvaluationCorpus;
  readonly samples: readonly VerifiedBenchmarkSample[];
}

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await readFile(filePath, "utf8")) as unknown;

const insideBenchmarkRoot = (root: string, relativePath: string): string => {
  if (path.isAbsolute(relativePath))
    throw new Error(`path must remain inside benchmark root: ${relativePath}`);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".."
  )
    throw new Error(`path must remain inside benchmark root: ${relativePath}`);
  return resolved;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const verifyArtifact = async (
  root: string,
  artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  },
): Promise<{ readonly path: string; readonly bytes: Buffer }> => {
  const filePath = insideBenchmarkRoot(root, artifact.path);
  const bytes = await readFile(filePath);
  if (bytes.length !== artifact.size)
    throw new Error(`size mismatch for ${artifact.path}`);
  if (sha256(bytes) !== artifact.sha256)
    throw new Error(`sha256 mismatch for ${artifact.path}`);
  return { path: filePath, bytes };
};

const unzipEntry = (bytes: Buffer, fileName: string): Buffer => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 30; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;
    const flags = view.getUint16(offset + 6, true);
    if ((flags & 0x08) !== 0)
      throw new Error(
        "DOCX data descriptors are not supported by benchmark verifier",
      );
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString();
    if (name !== fileName) continue;
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return compressed;
    if (method === 8) return inflateRawSync(compressed);
    throw new Error(`unsupported DOCX compression method: ${method}`);
  }
  throw new Error(`DOCX entry missing: ${fileName}`);
};

const pdfTextCharacters = async (bytes: Buffer): Promise<number> => {
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  try {
    let characters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      characters += content.items.reduce(
        (total, item) => total + ("str" in item ? [...item.str].length : 0),
        0,
      );
    }
    return characters;
  } finally {
    await loadingTask.destroy();
  }
};

const verifySampleContent = async (
  sample: BenchmarkManifest["samples"][number],
  bytes: Buffer,
): Promise<void> => {
  if (
    sample.fileType.startsWith("pdf") &&
    !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
  )
    throw new Error(`invalid PDF magic for ${sample.path}`);
  if (sample.fileType === "docx") {
    if (!bytes.subarray(0, 2).equals(Buffer.from("PK")))
      throw new Error(`invalid DOCX magic for ${sample.path}`);
    const documentXml = unzipEntry(bytes, "word/document.xml").toString("utf8");
    if (sample.modalities.includes("table") && !/<w:tbl[ >]/u.test(documentXml))
      throw new Error(`DOCX table modality missing for ${sample.path}`);
  }
  if (sample.fileType === "pdf_text") {
    if ((await pdfTextCharacters(bytes)) === 0)
      throw new Error(`text PDF has no extractable text layer: ${sample.path}`);
  }
  if (sample.fileType === "pdf_scan") {
    if ((await pdfTextCharacters(bytes)) >= 20)
      throw new Error(
        `scan PDF unexpectedly has a substantial text layer: ${sample.path}`,
      );
  }
  if (sample.modalities.includes("long_document")) {
    const characters = [...bytes.toString("utf8")].length;
    if (characters < 24_000)
      throw new Error(
        `long document is below 24000 characters: ${sample.path}`,
      );
  }
};

const corpusAnchors = (corpus: EvaluationCorpus) => [
  ...corpus.findings.flatMap(({ sourceAnchors }) => sourceAnchors),
  ...corpus.atomicRequirements.flatMap(({ sourceAnchors }) => sourceAnchors),
];

const verifyCorpusSources = (
  manifest: BenchmarkManifest,
  expected: EvaluationCorpus,
  actual: EvaluationCorpus,
): void => {
  const samples = new Map(
    manifest.samples.map((sample) => [sample.sourceId, sample]),
  );
  const expectedAnchors = corpusAnchors(expected);
  const actualAnchors = corpusAnchors(actual);
  for (const anchor of [...expectedAnchors, ...actualAnchors]) {
    const sample = samples.get(anchor.sourceId);
    if (!sample)
      throw new Error(
        `corpus anchor references undeclared source ${anchor.sourceId}`,
      );
    if (sample.sourceType !== anchor.sourceType)
      throw new Error(
        `corpus anchor source type mismatch for ${anchor.sourceId}`,
      );
  }
  for (const [corpusName, anchors] of [
    ["expected", expectedAnchors],
    ["actual", actualAnchors],
  ] as const) {
    const covered = new Set(anchors.map(({ sourceId }) => sourceId));
    for (const sourceId of samples.keys()) {
      if (!covered.has(sourceId))
        throw new Error(
          `manifest source is not covered by ${corpusName} corpus: ${sourceId}`,
        );
    }
  }
  for (const page of [...expected.ocrPages, ...actual.ocrPages]) {
    if (!samples.has(page.sourceId))
      throw new Error(
        `OCR corpus references undeclared source ${page.sourceId}`,
      );
  }
};

export const loadBenchmarkBundle = async (
  manifestPathInput: string,
  actualPathInput?: string,
): Promise<BenchmarkBundle> => {
  const manifestPath = path.resolve(manifestPathInput);
  const root = path.dirname(manifestPath);
  const manifest = BenchmarkManifestSchema.parse(await readJson(manifestPath));
  const expectedPath = insideBenchmarkRoot(root, manifest.expectedFile);
  const actualPath = actualPathInput
    ? insideBenchmarkRoot(root, actualPathInput)
    : insideBenchmarkRoot(root, manifest.actualFile);
  const [expected, actual] = await Promise.all([
    readJson(expectedPath).then((value) => EvaluationCorpusSchema.parse(value)),
    readJson(actualPath).then((value) => EvaluationCorpusSchema.parse(value)),
  ]);
  const samples: VerifiedBenchmarkSample[] = [];
  for (const sample of manifest.samples) {
    const artifact = await verifyArtifact(root, sample);
    await verifySampleContent(sample, artifact.bytes);
    for (const attachment of sample.attachments)
      await verifyArtifact(root, attachment);
    samples.push({
      sourceId: sample.sourceId,
      absolutePath: artifact.path,
      verified: true,
    });
  }
  verifyCorpusSources(manifest, expected, actual);
  return {
    manifest,
    manifestPath,
    expectedPath,
    actualPath,
    expected,
    actual,
    samples,
  };
};

export const buildMachineReportJson = (
  bundle: BenchmarkBundle,
  metrics: EvaluationMetrics,
  generatedAt = bundle.manifest.asOf,
): string => {
  const stableGeneratedAt = z.string().datetime().parse(generatedAt);
  return `${JSON.stringify(
    {
      schemaVersion: 2,
      benchmarkId: bundle.manifest.benchmarkId,
      benchmarkVersion: bundle.manifest.benchmarkVersion,
      generatedAt: stableGeneratedAt,
      disclaimer: bundle.manifest.disclaimer,
      corpusKind: "fixture-bound static regression corpus",
      inputs: {
        manifest: path.basename(bundle.manifestPath),
        expected: path.basename(bundle.expectedPath),
        actual: path.basename(bundle.actualPath),
      },
      coverage: bundle.manifest.coverage,
      samples: bundle.manifest.samples,
      metrics,
    },
    null,
    2,
  )}\n`;
};
