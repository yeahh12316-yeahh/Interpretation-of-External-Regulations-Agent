import type { SourceAnchor, SourceType, SourceUnit } from "../../domain/source";
import { SourceUnitSchema } from "../../domain/schemas";
import { validateFile } from "../intake/file-policy";
import { hashFile } from "../intake/hash-file";
import { buildAnchors, type ParsedSourceUnit } from "./build-anchors";
import { parseText } from "./parse-text";

export interface ParseQuality {
  totalCharacters: number;
  parsedUnitCount: number;
  failedPageCount: number;
  lowTextPages: number[];
  extractionCoverage: number;
}

export interface ParseResult {
  fileHash: string;
  source: SourceUnit;
  pageCount: number | null;
  successfulPages: number[];
  failedPages: Array<{ page: number; error: string }>;
  units: ParsedSourceUnit[];
  anchors: SourceAnchor[];
  quality: ParseQuality;
}

const abortError = (): DOMException =>
  new DOMException("文件处理已取消", "AbortError");

const readBytes = async (
  file: File,
  signal: AbortSignal,
): Promise<ArrayBuffer> => {
  if (signal.aborted) throw abortError();
  try {
    const bytes = await file.arrayBuffer();
    if (signal.aborted) throw abortError();
    return bytes;
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
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
  if (signal.aborted) throw abortError();
  const kind = await validateFile(file);
  if (signal.aborted) throw abortError();
  const fileHash = await hashFile(file, signal);
  const sourceId = `SRC-${sourceType}-${fileHash.slice(0, 20)}`;
  const bytes = await readBytes(file, signal);

  let units: ParsedSourceUnit[];
  let pageCount: number | null = null;
  let successfulPages: number[] = [];
  let failedPages: Array<{ page: number; error: string }> = [];
  let lowTextPages: number[] = [];

  if (kind === "pdf") {
    const { parsePdf } = await import("./parse-pdf");
    const parsed = await parsePdf(bytes, sourceId, sourceType, signal);
    units = parsed.units;
    pageCount = parsed.pageCount;
    successfulPages = parsed.successfulPages;
    failedPages = parsed.failedPages;
    lowTextPages = parsed.lowTextPages;
  } else if (kind === "docx") {
    const { parseDocx } = await import("./parse-docx");
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
    anchors: buildAnchors(units),
    quality: {
      totalCharacters: content.length,
      parsedUnitCount: units.length,
      failedPageCount: failedPages.length,
      lowTextPages,
      extractionCoverage,
    },
  };
}
