import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import type { SourceType } from "../../domain/source";
import {
  abortError,
  isAbortError,
  raceWithAbort,
  throwIfAborted,
} from "../../lib/abort";
import {
  articleFromText,
  type BoundingBox,
  type ParsedSourceUnit,
} from "./build-anchors";
import { isScannedPage } from "./ocr/detect-scanned-page";
import {
  ocrPages,
  type OcrPageBitmap,
  type OcrPageResult,
  type OcrProgress,
} from "./ocr/ocr-pipeline";
import type { ParseProgressCallback } from "./parse-progress";

// Keep a malformed or unusually complex page from making the whole intake
// screen appear frozen. The caller can still cancel immediately; this bound
// is the final safety net when PDF.js never settles a page promise.
export const PDF_OPERATION_TIMEOUT_MS = 30_000;
export const PDF_DESTROY_TIMEOUT_MS = 2_000;

const testProcess = globalThis as typeof globalThis & {
  process?: { cwd(): string };
};
const testWorkerUrl = testProcess.process
  ? new URL(
      `file://${testProcess.process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs`,
    ).toString()
  : null;

// Vite emits the imported worker as a same-origin asset. Vitest runs PDF.js's
// fake worker in Node, where the equivalent file URL is required instead.
GlobalWorkerOptions.workerSrc =
  import.meta.env.MODE === "test" && testWorkerUrl ? testWorkerUrl : workerUrl;

const raceWithTimeout = async <T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([raceWithAbort(promise, signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const destroyLoadingTask = async (
  loadingTask: ReturnType<typeof getDocument>,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const destruction = Promise.resolve()
    .then(() => loadingTask.destroy())
    .catch(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PDF_DESTROY_TIMEOUT_MS);
  });
  try {
    await Promise.race([destruction, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

interface PdfTextItem {
  str: string;
  transform?: readonly number[];
  width?: number;
  height?: number;
}

interface PdfPageLike {
  getTextContent?(options?: {
    includeMarkedContent?: boolean;
    disableCombineTextItems?: boolean;
  }): Promise<{ items: readonly unknown[] }>;
  getViewport?(options: { scale: number }): PageViewport;
  render?(parameters: Parameters<PDFPageProxy["render"]>[0]): RenderTask;
  cleanup?(): boolean;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export interface PdfPageParseResult {
  units: ParsedSourceUnit[];
  ocrReviews: OcrPageResult[];
  successfulPages: number[];
  failedPages: Array<{ page: number; error: string }>;
  lowTextPages: number[];
  ocrFailedPages: number[];
}

interface RenderPageBitmapInput {
  page: PdfPageLike;
  pageNumber: number;
  sourceId: string;
  sourceType: SourceType;
  signal: AbortSignal;
}

export interface PdfOcrDependencies {
  renderPageBitmap?: (input: RenderPageBitmapInput) => Promise<OcrPageBitmap>;
  runOcr?: (
    pages: readonly OcrPageBitmap[],
    signal: AbortSignal,
    onProgress: (progress: OcrProgress) => void,
  ) => Promise<OcrPageResult[]>;
  onOcrProgress?: (progress: OcrProgress) => void;
  releasePageBitmap?: (page: OcrPageBitmap) => void;
  onProgress?: ParseProgressCallback;
}

const canRenderPage = (
  page: PdfPageLike,
): page is Required<Pick<PdfPageLike, "getViewport" | "render">> &
  PdfPageLike =>
  typeof page.getViewport === "function" && typeof page.render === "function";

const renderPageBitmap = async ({
  page,
  pageNumber,
  sourceId,
  sourceType,
  signal,
}: RenderPageBitmapInput): Promise<OcrPageBitmap> => {
  throwIfAborted(signal);
  if (!canRenderPage(page) || typeof document === "undefined")
    throw new Error("PDF 页面不支持本地 OCR 渲染");
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  if (!canvasContext) throw new Error("PDF 页面位图创建失败");
  const rendering = page.render({ canvas, canvasContext, viewport });
  await raceWithTimeout(
    rendering.promise,
    signal,
    PDF_OPERATION_TIMEOUT_MS,
    "PDF 页面渲染超时",
  );
  return {
    pageNumber,
    sourceId,
    sourceType,
    image: canvas,
    width: canvas.width,
    height: canvas.height,
  };
};

const releasePageBitmap = (page: OcrPageBitmap): void => {
  const image = page.image;
  if (typeof image !== "object" || image === null) return;
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    image instanceof HTMLCanvasElement
  ) {
    image.width = 0;
    image.height = 0;
    return;
  }
  if ("close" in image && typeof image.close === "function") image.close();
};

const failedOcrResult = (bitmap: OcrPageBitmap): OcrPageResult => ({
  unitId: `${bitmap.sourceId}:p${bitmap.pageNumber}:ocr`,
  sourceId: bitmap.sourceId,
  sourceType: bitmap.sourceType,
  page: bitmap.pageNumber,
  method: "ocr",
  confidence: 0,
  text: "",
  originalOcrText: "",
  correctedText: null,
  reviewStatus: "failed",
  reviewedAt: null,
  reviewedBy: null,
  correctionHistory: [],
  boundingBox: { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
  regions: [],
  lowConfidenceCharacters: [],
  error: "页面 OCR 识别失败",
});

const isTextItem = (item: unknown): item is PdfTextItem =>
  typeof item === "object" &&
  item !== null &&
  "str" in item &&
  typeof item.str === "string";

const boundingBoxOf = (
  items: readonly PdfTextItem[],
): BoundingBox | undefined => {
  const positioned = items.filter(
    (item) => item.transform && item.transform.length >= 6,
  );
  if (positioned.length === 0) return undefined;
  const xs = positioned.map((item) => item.transform?.[4] ?? 0);
  const ys = positioned.map((item) => item.transform?.[5] ?? 0);
  const right = positioned.map(
    (item) => (item.transform?.[4] ?? 0) + (item.width ?? 0),
  );
  const top = positioned.map(
    (item) => (item.transform?.[5] ?? 0) + (item.height ?? 0),
  );
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...right) - x, height: Math.max(...top) - y };
};

interface TextLine {
  y: number | null;
  firstItemIndex: number;
  items: PdfTextItem[];
}

const needsWordSpace = (left: PdfTextItem, right: PdfTextItem): boolean => {
  if (!/[A-Za-z0-9]$/.test(left.str) || !/^[A-Za-z0-9]/.test(right.str))
    return false;
  const leftX = left.transform?.[4];
  const rightX = right.transform?.[4];
  if (
    typeof leftX !== "number" ||
    typeof rightX !== "number" ||
    typeof left.width !== "number"
  ) {
    return false;
  }
  const gap = rightX - (leftX + left.width);
  const fontHeight = Math.max(left.height ?? 0, right.height ?? 0);
  return gap > Math.max(1, fontHeight * 0.2);
};

const lineText = (items: readonly PdfTextItem[]): string => {
  let text = "";
  let previous: PdfTextItem | undefined;
  for (const item of items) {
    if (previous && item.str && needsWordSpace(previous, item)) text += " ";
    text += item.str;
    if (item.str) previous = item;
  }
  return text.replace(/\s+/g, " ").trim();
};

const textLines = (items: readonly PdfTextItem[]): TextLine[] => {
  const lines: TextLine[] = [];
  items.forEach((item, itemIndex) => {
    const y = item.transform?.[5];
    const existing =
      typeof y === "number"
        ? lines.find((line) => line.y !== null && Math.abs(line.y - y) <= 2)
        : lines.find((line) => line.y === null);
    if (existing) {
      existing.items.push(item);
    } else {
      lines.push({
        y: typeof y === "number" ? y : null,
        firstItemIndex: itemIndex,
        items: [item],
      });
    }
  });

  return lines
    .sort((left, right) => {
      if (left.y === null || right.y === null)
        return left.firstItemIndex - right.firstItemIndex;
      return right.y - left.y;
    })
    .map((line) => ({
      ...line,
      items: [...line.items].sort(
        (left, right) =>
          (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0),
      ),
    }));
};

export async function parsePdfPages(
  pdf: PdfDocumentLike,
  sourceId: string,
  sourceType: SourceType,
  signal: AbortSignal,
  ocrDependencies: PdfOcrDependencies = {},
): Promise<PdfPageParseResult> {
  const result: PdfPageParseResult = {
    units: [],
    ocrReviews: [],
    successfulPages: [],
    failedPages: [],
    lowTextPages: [],
    ocrFailedPages: [],
  };

  const recordOcrResult = (ocrResult: OcrPageResult) => {
    result.ocrReviews.push(ocrResult);
    result.units = result.units.filter((unit) => unit.page !== ocrResult.page);
    if (ocrResult.reviewStatus === "failed" || ocrResult.error) {
      if (!result.ocrFailedPages.includes(ocrResult.page))
        result.ocrFailedPages.push(ocrResult.page);
      if (
        !result.failedPages.some((failure) => failure.page === ocrResult.page)
      ) {
        result.failedPages.push({
          page: ocrResult.page,
          error: ocrResult.error ?? "页面 OCR 识别失败",
        });
      }
      result.successfulPages = result.successfulPages.filter(
        (successfulPage) => successfulPage !== ocrResult.page,
      );
      return;
    }
    result.units.push({
      unitId: ocrResult.unitId,
      sourceId: ocrResult.sourceId,
      sourceType: ocrResult.sourceType,
      page: ocrResult.page,
      article: articleFromText(ocrResult.text),
      paragraphIndex: 0,
      text: ocrResult.text,
      extractionMethod: "ocr",
      confidence: ocrResult.confidence,
      boundingBox: ocrResult.boundingBox,
      originalOcrText: ocrResult.originalOcrText,
      correctedText: ocrResult.correctedText,
      reviewStatus: ocrResult.reviewStatus,
      reviewedAt: ocrResult.reviewedAt,
      reviewedBy: ocrResult.reviewedBy,
      correctionHistory: ocrResult.correctionHistory,
      ocrRegions: ocrResult.regions,
      lowConfidenceCharacters: ocrResult.lowConfidenceCharacters,
    });
  };

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    throwIfAborted(signal);
    ocrDependencies.onProgress?.({
      stage: "extracting",
      completed: pageNumber - 1,
      total: pdf.numPages,
      page: pageNumber,
      detail: `正在提取第 ${pageNumber}/${pdf.numPages} 页文本`,
    });
    let page: PdfPageLike | undefined;
    try {
      page = await raceWithTimeout(
        pdf.getPage(pageNumber),
        signal,
        PDF_OPERATION_TIMEOUT_MS,
        "PDF 页面加载超时",
      );
      if (typeof page.getTextContent !== "function")
        throw new Error("PDF 页面不支持文本提取");
      const textContent = await raceWithTimeout(
        page.getTextContent({ includeMarkedContent: false }),
        signal,
        PDF_OPERATION_TIMEOUT_MS,
        "PDF 文本提取超时",
      );
      const items = textContent.items.filter(isTextItem);
      const lines = textLines(items).filter((line) => lineText(line.items));
      result.successfulPages.push(pageNumber);
      const lowText = isScannedPage(
        lines.map((line) => lineText(line.items)).join(""),
      );
      if (lowText) result.lowTextPages.push(pageNumber);
      const sourceLines =
        lines.length > 0 ? lines : [{ y: null, firstItemIndex: 0, items: [] }];
      result.units.push(
        ...sourceLines.map((line, paragraphIndex) => {
          const text = lineText(line.items);
          return {
            sourceId,
            sourceType,
            page: pageNumber,
            article: articleFromText(text),
            paragraphIndex,
            text,
            extractionMethod: "text_layer" as const,
            confidence: lowText ? 0.25 : 1,
            boundingBox: boundingBoxOf(line.items),
          };
        }),
      );
      const bitmapRenderer =
        ocrDependencies.renderPageBitmap ?? renderPageBitmap;
      if (
        lowText &&
        (ocrDependencies.renderPageBitmap || canRenderPage(page))
      ) {
        let bitmap: OcrPageBitmap | undefined;
        try {
          bitmap = await bitmapRenderer({
            page,
            pageNumber,
            sourceId,
            sourceType,
            signal,
          });
          const runOcr = ocrDependencies.runOcr ?? ocrPages;
          let pageResults: OcrPageResult[];
          try {
            pageResults = await runOcr([bitmap], signal, (progress) => {
              ocrDependencies.onOcrProgress?.(progress);
              ocrDependencies.onProgress?.({
                stage: "ocr",
                completed: pageNumber - 1 + progress.progress,
                total: pdf.numPages,
                page: pageNumber,
                detail: progress.status,
              });
            });
          } catch (error) {
            if (signal.aborted || isAbortError(error)) throw abortError();
            pageResults = [failedOcrResult(bitmap)];
          }
          recordOcrResult(
            pageResults.find((ocrResult) => ocrResult.page === pageNumber) ??
              failedOcrResult(bitmap),
          );
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw abortError();
          if (!result.ocrFailedPages.includes(pageNumber))
            result.ocrFailedPages.push(pageNumber);
          if (
            !result.failedPages.some((failure) => failure.page === pageNumber)
          ) {
            result.failedPages.push({
              page: pageNumber,
              error: "页面 OCR 渲染失败",
            });
          }
          result.successfulPages = result.successfulPages.filter(
            (successfulPage) => successfulPage !== pageNumber,
          );
        } finally {
          if (bitmap)
            (ocrDependencies.releasePageBitmap ?? releasePageBitmap)(bitmap);
        }
      }
      ocrDependencies.onProgress?.({
        stage: "extracting",
        completed: pageNumber,
        total: pdf.numPages,
        page: pageNumber,
        detail: `第 ${pageNumber}/${pdf.numPages} 页处理完成`,
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw abortError();
      }
      result.failedPages.push({ page: pageNumber, error: "页面文本提取失败" });
      ocrDependencies.onProgress?.({
        stage: "extracting",
        completed: pageNumber,
        total: pdf.numPages,
        page: pageNumber,
        detail: `第 ${pageNumber}/${pdf.numPages} 页提取失败，已跳过`,
      });
    } finally {
      // PDFPageProxy retains operator lists and text-layer resources until
      // explicitly cleaned. Releasing each page is important when both
      // upload panels parse documents at the same time.
      try {
        page?.cleanup?.();
      } catch {
        // Cleanup is best-effort; the page result above remains authoritative.
      }
    }
  }

  result.units.sort(
    (left, right) =>
      (left.page ?? 0) - (right.page ?? 0) ||
      left.paragraphIndex - right.paragraphIndex,
  );

  return result;
}

export async function parsePdf(
  bytes: ArrayBuffer,
  sourceId: string,
  sourceType: SourceType,
  signal: AbortSignal,
  onProgress: ParseProgressCallback = () => undefined,
): Promise<PdfPageParseResult & { pageCount: number }> {
  throwIfAborted(signal);
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  let pdf: Awaited<typeof loadingTask.promise> | undefined;
  const cancelLoading = () => {
    void destroyLoadingTask(loadingTask);
  };
  signal.addEventListener("abort", cancelLoading, { once: true });

  try {
    pdf = await raceWithTimeout(
      loadingTask.promise,
      signal,
      PDF_OPERATION_TIMEOUT_MS,
      "PDF 加载超时",
    );
    onProgress({
      stage: "extracting",
      completed: 0,
      total: pdf.numPages,
      detail: `共 ${pdf.numPages} 页，开始提取文本`,
    });
    const pages = await parsePdfPages(pdf, sourceId, sourceType, signal, {
      onProgress,
    });
    return { ...pages, pageCount: pdf.numPages };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof Error && error.message === "PDF 文本提取失败")
      throw error;
    throw new Error("PDF 文本提取失败");
  } finally {
    signal.removeEventListener("abort", cancelLoading);
    // Release cached page resources before destroying the loading task. This
    // prevents a late worker message from keeping the promise chain alive.
    // PDF.js exposes cleanup on PDFDocumentProxy, but keep this defensive for
    // test doubles and future versions.
    try {
      pdf?.cleanup();
    } catch {
      // Loading failed or was aborted; destroy below is still sufficient.
    }
    await destroyLoadingTask(loadingTask);
  }
}

export async function inspectPdfTextLayer(
  bytes: ArrayBuffer,
  signal: AbortSignal,
): Promise<Array<{ page: number; itemCount: number; text: string }>> {
  throwIfAborted(signal);
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  let pdf: Awaited<typeof loadingTask.promise> | undefined;
  const cancelLoading = () => {
    void destroyLoadingTask(loadingTask);
  };
  signal.addEventListener("abort", cancelLoading, { once: true });
  try {
    pdf = await raceWithTimeout(
      loadingTask.promise,
      signal,
      PDF_OPERATION_TIMEOUT_MS,
      "PDF 加载超时",
    );
    const pages: Array<{ page: number; itemCount: number; text: string }> = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await raceWithTimeout(
        pdf.getPage(pageNumber),
        signal,
        PDF_OPERATION_TIMEOUT_MS,
        "PDF 页面加载超时",
      );
      if (typeof page.getTextContent !== "function")
        throw new Error("PDF 页面不支持文本提取");
      const content = await raceWithTimeout(
        page.getTextContent({ includeMarkedContent: false }),
        signal,
        PDF_OPERATION_TIMEOUT_MS,
        "PDF 文本提取超时",
      );
      const items = content.items.filter(isTextItem) as PdfTextItem[];
      pages.push({
        page: pageNumber,
        itemCount: items.length,
        text: items.map((item) => item.str).join(""),
      });
      page.cleanup?.();
    }
    return pages;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError();
    throw new Error("PDF 文本层检查失败");
  } finally {
    signal.removeEventListener("abort", cancelLoading);
    try {
      pdf?.cleanup();
    } catch {
      // Best-effort cleanup for inspection callers.
    }
    await destroyLoadingTask(loadingTask);
  }
}
