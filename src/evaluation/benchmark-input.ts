import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";

import type { SourceAnchor } from "../domain/source";
import { articleFromText } from "../features/parsing/build-anchors";
import { normalizeText } from "../features/evidence/normalize-text";
import {
  MAX_DOCX_FILE_BYTES,
  readStrictDocxEntries,
} from "../lib/strict-docx-zip";
import {
  EvaluationCorpusSchema,
  evaluateFindings,
  type EvaluationCorpus,
  type EvaluationMetrics,
} from "./evaluate-findings";
import {
  BenchmarkManifestSchema,
  type BenchmarkManifest,
} from "./evaluation-report";

interface FixtureUnit {
  readonly sourceId: string;
  readonly page: number | null;
  readonly paragraphIndex: number;
  readonly article: string | null;
  readonly text: string;
}

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
  readonly validatedAnchorCount: number;
}

const validatedBundles = new WeakSet<object>();

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const isBenchmarkBundle = (value: unknown): value is BenchmarkBundle =>
  typeof value === "object" && value !== null;

const GroundTruthFileSchema = z
  .object({
    sourceId: z.string().min(1),
    scanFileSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    pages: z
      .array(
        z
          .object({
            page: z.number().int().positive(),
            expectedText: z.string().trim().min(1),
            paragraphs: z
              .array(
                z
                  .object({
                    paragraphIndex: z.number().int().nonnegative(),
                    article: z.string().min(1).nullable(),
                    text: z.string().trim().min(1),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((truth, context) => {
    const pages = new Set<number>();
    truth.pages.forEach((page, pageIndex) => {
      if (pages.has(page.page))
        context.addIssue({
          code: "custom",
          path: ["pages", pageIndex, "page"],
          message: "ground-truth page must be unique",
        });
      pages.add(page.page);
      const paragraphs = new Set<number>();
      page.paragraphs.forEach((paragraph, paragraphIndex) => {
        if (paragraphs.has(paragraph.paragraphIndex))
          context.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "paragraphs", paragraphIndex],
            message: "ground-truth paragraph must be unique",
          });
        paragraphs.add(paragraph.paragraphIndex);
      });
    });
  });

const MAX_BENCHMARK_JSON_BYTES = 16 * 1024 * 1024;
const MAX_BENCHMARK_ARTIFACT_BYTES = 128 * 1024 * 1024;

export interface FileSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

const fileSnapshot = (stat: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): FileSnapshot => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});

export const assertStableFileSnapshots = (
  before: FileSnapshot,
  after: FileSnapshot,
): void => {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("benchmark file changed during descriptor read (TOCTOU)");
};

const lexicalInside = (root: string, relativePath: string): string => {
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

const checkedLexicalPath = async (
  root: string,
  relativePath: string,
): Promise<string> => {
  const resolved = lexicalInside(root, relativePath);
  const relativeParts = path.relative(root, resolved).split(path.sep);
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new Error(
        `symlink is forbidden in benchmark path: ${relativePath}`,
      );
  }
  return resolved;
};

const assertCanonicalInside = (
  rootCanonical: string,
  canonical: string,
  relativePath: string,
): void => {
  const canonicalRelative = path.relative(rootCanonical, canonical);
  if (
    canonicalRelative === "" ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`)
  )
    throw new Error(
      `real path must remain inside benchmark root: ${relativePath}`,
    );
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

interface VerifiedFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly identity: string;
  readonly role: string;
}

const readVerifiedFile = async (input: {
  readonly root: string;
  readonly rootCanonical: string;
  readonly relativePath: string;
  readonly role: string;
  readonly expectedSha256?: string;
  readonly expectedSize?: number;
  readonly maxBytes: number;
}): Promise<VerifiedFile> => {
  const resolved = await checkedLexicalPath(input.root, input.relativePath);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(resolved, flags);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code === "ELOOP")
      throw new Error(
        `symlink is forbidden in benchmark path: ${input.relativePath}`,
      );
    throw error;
  }
  try {
    const beforeStat = await handle.stat();
    if (!beforeStat.isFile())
      throw new Error(
        `benchmark artifact is not a regular file: ${input.role}`,
      );
    if (beforeStat.nlink !== 1)
      throw new Error(
        `benchmark hardlink artifact is forbidden: ${input.role}`,
      );
    const before = fileSnapshot(beforeStat);
    if (before.size > input.maxBytes)
      throw new Error(`benchmark artifact size limit exceeded: ${input.role}`);
    if (input.expectedSize !== undefined && before.size !== input.expectedSize)
      throw new Error(`size mismatch for ${input.relativePath}`);

    const pathBefore = await lstat(resolved);
    if (pathBefore.isSymbolicLink())
      throw new Error(
        `symlink is forbidden in benchmark path: ${input.relativePath}`,
      );
    if (
      pathBefore.dev !== before.dev ||
      pathBefore.ino !== before.ino ||
      !pathBefore.isFile()
    )
      throw new Error(
        `benchmark path identity changed before read: ${input.role}`,
      );
    const canonicalBefore = await realpath(resolved);
    assertCanonicalInside(
      input.rootCanonical,
      canonicalBefore,
      input.relativePath,
    );

    const bytes = await handle.readFile();
    const afterStat = await handle.stat();
    assertStableFileSnapshots(before, fileSnapshot(afterStat));
    if (bytes.length !== before.size || bytes.length > input.maxBytes)
      throw new Error(`benchmark descriptor read size changed: ${input.role}`);
    const pathAfter = await lstat(resolved);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino
    )
      throw new Error(
        `benchmark path identity changed after read: ${input.role}`,
      );
    const canonicalAfter = await realpath(resolved);
    assertCanonicalInside(
      input.rootCanonical,
      canonicalAfter,
      input.relativePath,
    );
    if (canonicalAfter !== canonicalBefore)
      throw new Error(
        `benchmark canonical path changed during read: ${input.role}`,
      );
    const digest = sha256(bytes);
    if (input.expectedSha256 && digest !== input.expectedSha256)
      throw new Error(`sha256 mismatch for ${input.relativePath}`);
    const hasStableInode =
      Number.isFinite(before.dev) && before.dev >= 0 && before.ino > 0;
    return {
      path: canonicalAfter,
      bytes,
      identity: hasStableInode
        ? `dev:${before.dev}:ino:${before.ino}`
        : `content:${digest}:size:${before.size}`,
      role: input.role,
    };
  } finally {
    await handle.close();
  }
};

const verifyArtifact = async (
  root: string,
  rootCanonical: string,
  artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  },
  role: string,
  maxBytes = MAX_BENCHMARK_ARTIFACT_BYTES,
): Promise<VerifiedFile> =>
  readVerifiedFile({
    root,
    rootCanonical,
    relativePath: artifact.path,
    role,
    expectedSha256: artifact.sha256,
    expectedSize: artifact.size,
    maxBytes,
  });

const decodeXml = (value: string): string =>
  value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");

const textUnits = (sourceId: string, bytes: Buffer): FixtureUnit[] =>
  bytes
    .toString("utf8")
    .split(/\r?\n/u)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, paragraphIndex) => ({
      sourceId,
      page: null,
      paragraphIndex,
      article: articleFromText(text),
      text,
    }));

const docxUnits = (sourceId: string, xml: string): FixtureUnit[] => {
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gu)]
    .map((match) =>
      [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
        .map((text) => decodeXml(text[1]))
        .join("")
        .trim(),
    )
    .filter(Boolean);
  return paragraphs.map((text, paragraphIndex) => ({
    sourceId,
    page: null,
    paragraphIndex,
    article: articleFromText(text),
    text,
  }));
};

interface PdfInspection {
  readonly units: readonly FixtureUnit[];
  readonly textCharacters: number;
  readonly imagePages: ReadonlySet<number>;
  readonly meaningfulImagePages: ReadonlySet<number>;
  readonly pageCount: number;
}

const inspectPdf = async (
  sourceId: string,
  bytes: Buffer,
): Promise<PdfInspection> => {
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  try {
    const document = await loadingTask.promise;
    const units: FixtureUnit[] = [];
    const imagePages = new Set<number>();
    const meaningfulImagePages = new Set<number>();
    let textCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageTexts: string[] = [];
      let currentLine = "";
      let currentY: number | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const itemY = item.transform[5];
        if (currentY !== undefined && Math.abs(itemY - currentY) > 0.5) {
          if (currentLine.trim()) pageTexts.push(currentLine.trim());
          currentLine = "";
        }
        currentY = itemY;
        currentLine += item.str;
        if (item.hasEOL) {
          if (currentLine.trim()) pageTexts.push(currentLine.trim());
          currentLine = "";
          currentY = undefined;
        }
      }
      if (currentLine.trim()) pageTexts.push(currentLine.trim());
      pageTexts.forEach((text, paragraphIndex) => {
        textCharacters += [...text].length;
        units.push({
          sourceId,
          page: pageNumber,
          paragraphIndex,
          article: articleFromText(text),
          text,
        });
      });
      const operatorList = await page.getOperatorList();
      operatorList.fnArray.forEach((operator, index) => {
        if (
          operator !== OPS.paintImageXObject &&
          operator !== OPS.paintInlineImageXObject &&
          operator !== OPS.paintImageMaskXObject
        )
          return;
        imagePages.add(pageNumber);
        const [imageId, declaredWidth, declaredHeight] = operatorList.argsArray[
          index
        ] as [string, number, number];
        const image =
          typeof imageId === "string"
            ? (page.objs.get(imageId) as {
                width?: number;
                height?: number;
                data?: Uint8Array;
              })
            : undefined;
        const width = image?.width ?? declaredWidth;
        const height = image?.height ?? declaredHeight;
        const data = image?.data;
        if (
          width >= 300 &&
          height >= 200 &&
          data &&
          data.length >= width * height &&
          data.some((value) => value !== data[0])
        )
          meaningfulImagePages.add(pageNumber);
      });
    }
    return {
      units,
      textCharacters,
      imagePages,
      meaningfulImagePages,
      pageCount: document.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
};

const verifySampleContent = async (
  root: string,
  rootCanonical: string,
  sample: BenchmarkManifest["samples"][number],
  bytes: Buffer,
  registerArtifact: (artifact: VerifiedFile) => void,
): Promise<{
  readonly units: readonly FixtureUnit[];
  readonly groundTruthExpectedByPage: ReadonlyMap<string, string>;
}> => {
  const result = (
    units: readonly FixtureUnit[],
    groundTruthExpectedByPage: ReadonlyMap<string, string> = new Map(),
  ) => ({ units, groundTruthExpectedByPage });
  if (
    sample.fileType.startsWith("pdf") &&
    !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
  )
    throw new Error(`invalid PDF magic for ${sample.path}`);
  if (sample.fileType === "txt") {
    if (sample.modalities.includes("long_document")) {
      const characters = [...bytes.toString("utf8")].length;
      if (characters < 24_000)
        throw new Error(
          `long document is below 24000 characters: ${sample.path}`,
        );
    }
    return result(textUnits(sample.sourceId, bytes));
  }
  if (sample.fileType === "docx") {
    if (!bytes.subarray(0, 2).equals(Buffer.from("PK")))
      throw new Error(`invalid DOCX magic for ${sample.path}`);
    const documentXml = readStrictDocxEntries(bytes)
      .get("word/document.xml")
      ?.toString("utf8");
    if (!documentXml) throw new Error(`DOCX entry missing: word/document.xml`);
    if (sample.modalities.includes("table") && !/<w:tbl[ >]/u.test(documentXml))
      throw new Error(`DOCX table modality missing for ${sample.path}`);
    return result(docxUnits(sample.sourceId, documentXml));
  }
  const inspection = await inspectPdf(sample.sourceId, bytes);
  if (sample.fileType === "pdf_text") {
    if (inspection.textCharacters === 0)
      throw new Error(`text PDF has no extractable text layer: ${sample.path}`);
    return result([...inspection.units]);
  }
  if (inspection.textCharacters !== 0)
    throw new Error(`scan PDF must have zero text layer: ${sample.path}`);
  if (inspection.imagePages.size === 0)
    throw new Error(`scan PDF has no image paint operation: ${sample.path}`);
  if (inspection.meaningfulImagePages.size === 0)
    throw new Error(
      `scan PDF image is blank, uniform, or too small: ${sample.path}`,
    );
  if (!sample.groundTruth)
    throw new Error(`scan PDF is missing ground-truth: ${sample.path}`);
  const truthArtifact = await verifyArtifact(
    root,
    rootCanonical,
    sample.groundTruth,
    `ground-truth:${sample.sourceId}`,
  );
  registerArtifact(truthArtifact);
  const truth = GroundTruthFileSchema.parse(
    JSON.parse(truthArtifact.bytes.toString("utf8")) as unknown,
  );
  if (
    truth.sourceId !== sample.sourceId ||
    truth.scanFileSha256 !== sample.sha256
  )
    throw new Error(`ground-truth binding mismatch for ${sample.sourceId}`);
  const units = truth.pages.flatMap((page) => {
    if (
      page.page > inspection.pageCount ||
      !inspection.meaningfulImagePages.has(page.page)
    )
      throw new Error(
        `ground-truth page has no scanned image: ${sample.sourceId}:p${page.page}`,
      );
    return page.paragraphs.map((paragraph) => ({
      sourceId: sample.sourceId,
      page: page.page,
      paragraphIndex: paragraph.paragraphIndex,
      article: paragraph.article,
      text: paragraph.text,
    }));
  });
  return result(
    units,
    new Map(
      truth.pages.map((page) => [
        `${sample.sourceId}\u0000${page.page}`,
        page.expectedText,
      ]),
    ),
  );
};

const corpusAnchors = (corpus: EvaluationCorpus): SourceAnchor[] => [
  ...corpus.findings.flatMap(({ sourceAnchors }) => sourceAnchors),
  ...corpus.atomicRequirements.flatMap(({ sourceAnchors }) => sourceAnchors),
];

const sameText = (left: string, right: string): boolean =>
  normalizeText(left) === normalizeText(right);

const verifyAnchor = (
  anchor: SourceAnchor,
  units: readonly FixtureUnit[],
): void => {
  const unit = units.find(
    (candidate) =>
      candidate.page === anchor.page &&
      candidate.paragraphIndex === anchor.paragraphIndex,
  );
  if (!unit)
    throw new Error(
      `anchor locator unavailable: ${anchor.sourceId}:p${String(anchor.page)}:${anchor.paragraphIndex}`,
    );
  if (
    (anchor.article === null) !== (unit.article === null) ||
    (anchor.article !== null &&
      unit.article !== null &&
      !sameText(anchor.article, unit.article))
  )
    throw new Error(`anchor article mismatch for ${anchor.sourceId}`);
  if (!normalizeText(unit.text).includes(normalizeText(anchor.quote)))
    throw new Error(`anchor quote not found for ${anchor.sourceId}`);
};

const verifyOfficialPairing = (
  manifest: BenchmarkManifest,
  corpus: EvaluationCorpus,
): void => {
  const samples = new Map(
    manifest.samples.map((sample) => [sample.sourceId, sample]),
  );
  for (const sample of manifest.samples) {
    if (sample.sourceType !== "official_interpretation") continue;
    if (
      corpus.officialPrimarySourceIds[sample.sourceId] !==
      sample.primarySourceId
    )
      throw new Error(`official primary pair mismatch for ${sample.sourceId}`);
  }
  for (const finding of corpus.findings) {
    if (finding.claimType !== "official_explanation") continue;
    const officialSources = new Set(
      finding.sourceAnchors
        .filter(({ sourceType }) => sourceType === "official_interpretation")
        .map(({ sourceId }) => sourceId),
    );
    if (officialSources.size !== 1 || finding.inferenceParents.length === 0)
      throw new Error(
        `official explanation must have one source and primary parent: ${finding.findingId}`,
      );
    const officialSourceId = [...officialSources][0];
    const expectedPrimary = corpus.officialPrimarySourceIds[officialSourceId];
    if (
      !expectedPrimary ||
      samples.get(expectedPrimary)?.sourceType !== "regulatory_text"
    )
      throw new Error(
        `official primary source is invalid for ${finding.findingId}`,
      );
    for (const parentId of finding.inferenceParents) {
      const parent = corpus.findings.find(
        ({ findingId }) => findingId === parentId,
      );
      if (
        !parent ||
        !["regulatory_fact", "pending_confirmation"].includes(
          parent.claimType,
        ) ||
        parent.sourceAnchors.length === 0 ||
        parent.sourceAnchors.some(
          ({ sourceId, sourceType }) =>
            sourceType !== "regulatory_text" || sourceId !== expectedPrimary,
        )
      )
        throw new Error(
          `official primary parent mismatch for ${finding.findingId}`,
        );
    }
  }
};

const verifyCorpus = (
  manifest: BenchmarkManifest,
  corpusName: "expected" | "actual",
  corpus: EvaluationCorpus,
  unitsBySource: ReadonlyMap<string, readonly FixtureUnit[]>,
  groundTruthExpectedByPage: ReadonlyMap<string, string>,
): number => {
  const samples = new Map(
    manifest.samples.map((sample) => [sample.sourceId, sample]),
  );
  const anchors = corpusAnchors(corpus);
  for (const anchor of anchors) {
    const sample = samples.get(anchor.sourceId);
    if (!sample)
      throw new Error(
        `corpus anchor references undeclared source ${anchor.sourceId}`,
      );
    if (sample.sourceType !== anchor.sourceType)
      throw new Error(
        `corpus anchor source type mismatch for ${anchor.sourceId}`,
      );
    verifyAnchor(anchor, unitsBySource.get(anchor.sourceId) ?? []);
  }
  const covered = new Set(anchors.map(({ sourceId }) => sourceId));
  for (const sourceId of samples.keys()) {
    if (!covered.has(sourceId))
      throw new Error(
        `manifest source is not covered by ${corpusName} corpus: ${sourceId}`,
      );
  }
  for (const page of corpus.ocrPages) {
    if (!samples.has(page.sourceId))
      throw new Error(
        `OCR corpus references undeclared source ${page.sourceId}`,
      );
  }
  const scanKeys = [...groundTruthExpectedByPage.keys()];
  const corpusOcrKeys = corpus.ocrPages.map(
    ({ sourceId, page }) => `${sourceId}\u0000${page}`,
  );
  if (scanKeys.sort().join("\u0000") !== corpusOcrKeys.sort().join("\u0000"))
    throw new Error(
      `${corpusName} OCR page coverage does not match scan ground-truth`,
    );
  if (corpusName === "expected") {
    for (const page of corpus.ocrPages) {
      const expectedText = groundTruthExpectedByPage.get(
        `${page.sourceId}\u0000${page.page}`,
      );
      if (!expectedText || !sameText(page.text, expectedText))
        throw new Error(
          `expected OCR text does not match scan ground-truth: ${page.sourceId}:p${page.page}`,
        );
    }
  }
  verifyOfficialPairing(manifest, corpus);
  return anchors.length;
};

const verifyManifestPairingLabels = (manifest: BenchmarkManifest): void => {
  const pairedPrimaryIds = new Set(
    manifest.samples.flatMap((sample) =>
      sample.sourceType === "official_interpretation" && sample.primarySourceId
        ? [sample.primarySourceId]
        : [],
    ),
  );
  for (const sample of manifest.samples) {
    const shouldBeWith =
      sample.sourceType === "official_interpretation" ||
      pairedPrimaryIds.has(sample.sourceId);
    if ((sample.officialInterpretation === "with") !== shouldBeWith)
      throw new Error(
        `official interpretation label mismatch for ${sample.sourceId}`,
      );
  }
};

export const loadBenchmarkBundle = async (
  manifestPathInput: string,
  actualPathInput?: string,
): Promise<BenchmarkBundle> => {
  const manifestPathResolved = path.resolve(manifestPathInput);
  const root = path.dirname(manifestPathResolved);
  const rootCanonical = await realpath(root);
  const artifactIdentities = new Map<string, string>();
  const registerArtifact = (artifact: VerifiedFile): void => {
    const priorRole = artifactIdentities.get(artifact.identity);
    if (priorRole)
      throw new Error(
        `duplicate canonical/identity benchmark artifact (hardlink/content fallback): ${priorRole} and ${artifact.role}`,
      );
    artifactIdentities.set(artifact.identity, artifact.role);
  };
  const manifestArtifact = await readVerifiedFile({
    root,
    rootCanonical,
    relativePath: path.basename(manifestPathResolved),
    role: "manifest",
    maxBytes: MAX_BENCHMARK_JSON_BYTES,
  });
  registerArtifact(manifestArtifact);
  const manifest = BenchmarkManifestSchema.parse(
    JSON.parse(manifestArtifact.bytes.toString("utf8")) as unknown,
  );
  verifyManifestPairingLabels(manifest);
  const expectedArtifact = await readVerifiedFile({
    root,
    rootCanonical,
    relativePath: manifest.expectedFile,
    role: "expected",
    maxBytes: MAX_BENCHMARK_JSON_BYTES,
  });
  registerArtifact(expectedArtifact);
  const actualRelative = actualPathInput ?? manifest.actualFile;
  const actualArtifact = await readVerifiedFile({
    root,
    rootCanonical,
    relativePath: actualRelative,
    role: "actual",
    maxBytes: MAX_BENCHMARK_JSON_BYTES,
  });
  if (expectedArtifact.identity === actualArtifact.identity)
    throw new Error(
      "expected and actual artifact identities must be different",
    );
  registerArtifact(actualArtifact);
  const expected = EvaluationCorpusSchema.parse(
    JSON.parse(expectedArtifact.bytes.toString("utf8")) as unknown,
  );
  const actual = EvaluationCorpusSchema.parse(
    JSON.parse(actualArtifact.bytes.toString("utf8")) as unknown,
  );
  const samples: VerifiedBenchmarkSample[] = [];
  const unitsBySource = new Map<string, readonly FixtureUnit[]>();
  const groundTruthExpectedByPage = new Map<string, string>();
  for (const sample of manifest.samples) {
    const artifact = await verifyArtifact(
      root,
      rootCanonical,
      sample,
      `source:${sample.sourceId}`,
      sample.fileType === "docx"
        ? MAX_DOCX_FILE_BYTES
        : MAX_BENCHMARK_ARTIFACT_BYTES,
    );
    registerArtifact(artifact);
    const verifiedContent = await verifySampleContent(
      root,
      rootCanonical,
      sample,
      artifact.bytes,
      registerArtifact,
    );
    unitsBySource.set(sample.sourceId, verifiedContent.units);
    for (const [key, value] of verifiedContent.groundTruthExpectedByPage)
      groundTruthExpectedByPage.set(key, value);
    for (const [attachmentIndex, attachment] of sample.attachments.entries()) {
      const verified = await verifyArtifact(
        root,
        rootCanonical,
        attachment,
        `attachment:${sample.sourceId}:${attachmentIndex}`,
      );
      registerArtifact(verified);
    }
    samples.push({
      sourceId: sample.sourceId,
      absolutePath: artifact.path,
      verified: true,
    });
  }
  const validatedAnchorCount =
    verifyCorpus(
      manifest,
      "expected",
      expected,
      unitsBySource,
      groundTruthExpectedByPage,
    ) +
    verifyCorpus(
      manifest,
      "actual",
      actual,
      unitsBySource,
      groundTruthExpectedByPage,
    );
  const bundle = deepFreeze({
    manifest,
    manifestPath: manifestArtifact.path,
    expectedPath: expectedArtifact.path,
    actualPath: actualArtifact.path,
    expected,
    actual,
    samples,
    validatedAnchorCount,
  });
  validatedBundles.add(bundle);
  return bundle;
};

export const evaluateValidatedBenchmark = (
  bundle: unknown,
): EvaluationMetrics => {
  if (!isBenchmarkBundle(bundle) || !validatedBundles.has(bundle))
    throw new Error("benchmark provenance missing: use loadBenchmarkBundle");
  const raw = evaluateFindings(bundle.expected, bundle.actual);
  const failures = raw.releaseGate.failures.filter(
    (failure) => failure !== "fixture_evidence_not_validated",
  );
  return {
    ...raw,
    releaseGate: { passed: failures.length === 0, failures },
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
      validatedAnchorCount: bundle.validatedAnchorCount,
      metrics,
    },
    null,
    2,
  )}\n`;
};
