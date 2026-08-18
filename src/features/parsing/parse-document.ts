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
import type { ParseProgress, ParseProgressCallback } from "./parse-progress";

export type { ParseProgress, ParseProgressCallback } from "./parse-progress";

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
  onProgress: ParseProgressCallback = () => undefined,
): Promise<ParseResult> {
  throwIfAborted(signal);
  const report = (progress: ParseProgress) => {
    if (!signal.aborted) onProgress(progress);
  };
  report({
    stage: "validating",
    completed: 0,
    total: 1,
    detail: "正在检查文件格式与大小",
  });
  const kind = await validateFile(file, {}, signal);
  report({
    stage: "validating",
    completed: 1,
    total: 1,
    detail: "文件校验完成",
  });
  report({
    stage: "hashing",
    completed: 0,
    total: 1,
    detail: "正在计算文件指纹",
  });
  const fileHash = await hashFile(file, signal);
  report({
    stage: "hashing",
    completed: 1,
    total: 1,
    detail: "文件指纹完成",
  });
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
    report({
      stage: "loading",
      completed: 0,
      total: 1,
      detail: "正在加载 PDF 页面",
    });
    const { parsePdf } = await raceWithAbort(import("./parse-pdf"), signal);
    const parsed = await parsePdf(bytes, sourceId, sourceType, signal, report);
    units = parsed.units;
    pageCount = parsed.pageCount;
    successfulPages = parsed.successfulPages;
    failedPages = parsed.failedPages;
    lowTextPages = parsed.lowTextPages;
    ocrFailedPages = parsed.ocrFailedPages;
    ocrReviews = parsed.ocrReviews;
  } else if (kind === "docx") {
    report({
      stage: "extracting",
      completed: 0,
      total: 1,
      detail: "正在提取 DOCX 文本",
    });
    const { parseDocx } = await raceWithAbort(import("./parse-docx"), signal);
    units = await parseDocx(bytes, sourceId, sourceType, signal);
    report({
      stage: "extracting",
      completed: 1,
      total: 1,
      detail: "DOCX 文本提取完成",
    });
  } else {
    report({
      stage: "extracting",
      completed: 0,
      total: 1,
      detail: "正在读取 TXT 文本",
    });
    units = parseText(bytes, sourceId, sourceType, signal);
    report({
      stage: "extracting",
      completed: 1,
      total: 1,
      detail: "TXT 文本读取完成",
    });
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

  report({
    stage: "finalizing",
    completed: 0,
    total: 1,
    detail: "正在整理来源锚点与质量结果",
  });
  const result = {
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
  report({
    stage: "finalizing",
    completed: 1,
    total: 1,
    detail: "解析结果已生成",
  });
  return result;
}
