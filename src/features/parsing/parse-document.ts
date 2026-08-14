import type { SourceAnchor, SourceType, SourceUnit } from "../../domain/source";
import { SourceUnitSchema } from "../../domain/schemas";
import {
  abortError,
  isAbortError,
  raceWithAbort,
  throwIfAborted,
} from "../../lib/abort";
import { validateFile } from "../intake/file-policy";
import { hashFile } from "../intake/hash-file";
import { buildAnchors, type ParsedSourceUnit } from "./build-anchors";
import { parseText } from "./parse-text";
import type { OcrPageResult } from "./ocr/ocr-pipeline";

export interface ParseQuality {
  totalCharacters: number;
  parsedUnitCount: number;
  failedPageCount: number;
  lowTextPages: number[];
  extractionCoverage: number;
  ocrFailedPages: number[];
  finalizationBlocked: boolean;
}

export interface ParseResult {
  fileHash: string;
  source: SourceUnit;
  pageCount: number | null;
  successfulPages: number[];
  failedPages: Array<{ page: number; error: string }>;
  units: ParsedSourceUnit[];
  ocrReviews: OcrPageResult[];
  anchors: SourceAnchor[];
  quality: ParseQuality;
}

const readBytes = async (
  file: File,
  signal: AbortSignal,
): Promise<ArrayBuffer> => {
  throwIfAborted(signal);
  try {
    return await raceWithAbort(
      Promise.resolve().then(() => file.arrayBuffer()),
      signal,
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw abortError();
    }
    throw new Error("无法读取文件");
  }
};

export async function parseDocument(
  file: File,
  sourceType: SourceType,
  signal: AbortSignal,
): Promise<ParseResult> {
  throwIfAborted(signal);
  const kind = await validateFile(file, {}, signal);
  const fileHash = await hashFile(file, signal);
  const sourceId = `SRC-${sourceType}-${fileHash.slice(0, 20)}`;
  const bytes = await readBytes(file, signal);

  let units: ParsedSourceUnit[];
  let pageCount: number | null = null;
  let successfulPages: number[] = [];
  let failedPages: Array<{ page: number; error: string }> = [];
  let lowTextPages: number[] = [];
  let ocrFailedPages: number[] = [];
  let ocrReviews: OcrPageResult[] = [];

  if (kind === "pdf") {
    const { parsePdf } = await raceWithAbort(import("./parse-pdf"), signal);
    const parsed = await parsePdf(bytes, sourceId, sourceType, signal);
    units = parsed.units;
    pageCount = parsed.pageCount;
    successfulPages = parsed.successfulPages;
    failedPages = parsed.failedPages;
    lowTextPages = parsed.lowTextPages;
    ocrFailedPages = parsed.ocrFailedPages;
    ocrReviews = parsed.ocrReviews;
  } else if (kind === "docx") {
    const { parseDocx } = await raceWithAbort(import("./parse-docx"), signal);
    units = await parseDocx(bytes, sourceId, sourceType, signal);
  } else {
    units = parseText(bytes, sourceId, sourceType, signal);
  }

  const content = units
    .map((unit) => unit.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const source = SourceUnitSchema.parse({
    sourceId,
    sourceType,
    title: file.name,
    content,
  });
  const extractionCoverage = pageCount
    ? successfulPages.length / pageCount
    : units.length > 0
      ? 1
      : 0;

  return {
    fileHash,
    source,
    pageCount,
    successfulPages,
    failedPages,
    units,
    ocrReviews,
    anchors: buildAnchors(units),
    quality: {
      totalCharacters: content.length,
      parsedUnitCount: units.length,
      failedPageCount: failedPages.length,
      lowTextPages,
      extractionCoverage,
      ocrFailedPages,
      finalizationBlocked: failedPages.length > 0,
    },
  };
}
