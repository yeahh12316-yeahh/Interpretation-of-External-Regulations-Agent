import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import type { SourceType } from "../../domain/source";
import {
  articleFromText,
  type BoundingBox,
  type ParsedSourceUnit,
} from "./build-anchors";

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

const LOW_TEXT_CHARACTER_THRESHOLD = 12;
const abortError = (): DOMException =>
  new DOMException("文件处理已取消", "AbortError");

interface PdfTextItem {
  str: string;
  transform?: readonly number[];
  width?: number;
  height?: number;
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export interface PdfPageParseResult {
  units: ParsedSourceUnit[];
  successfulPages: number[];
  failedPages: Array<{ page: number; error: string }>;
  lowTextPages: number[];
}

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

const needsWordSpace = (left: string, right: string): boolean =>
  /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);

const lineText = (items: readonly PdfTextItem[]): string => {
  let text = "";
  for (const item of items) {
    if (text && item.str && needsWordSpace(text, item.str)) text += " ";
    text += item.str;
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
): Promise<PdfPageParseResult> {
  const result: PdfPageParseResult = {
    units: [],
    successfulPages: [],
    failedPages: [],
    lowTextPages: [],
  };

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (signal.aborted) throw abortError();
    try {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      if (signal.aborted) throw abortError();
      const items = textContent.items.filter(isTextItem);
      const lines = textLines(items).filter((line) => lineText(line.items));
      const pageCharacterCount = lines.reduce(
        (count, line) => count + lineText(line.items).length,
        0,
      );
      result.successfulPages.push(pageNumber);
      if (pageCharacterCount < LOW_TEXT_CHARACTER_THRESHOLD)
        result.lowTextPages.push(pageNumber);
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
            confidence:
              pageCharacterCount < LOW_TEXT_CHARACTER_THRESHOLD ? 0.25 : 1,
            boundingBox: boundingBoxOf(line.items),
          };
        }),
      );
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw abortError();
      }
      result.failedPages.push({ page: pageNumber, error: "页面文本提取失败" });
    }
  }

  return result;
}

export async function parsePdf(
  bytes: ArrayBuffer,
  sourceId: string,
  sourceType: SourceType,
  signal: AbortSignal,
): Promise<PdfPageParseResult & { pageCount: number }> {
  if (signal.aborted) throw abortError();
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  const cancelLoading = () => {
    void loadingTask.destroy();
  };
  signal.addEventListener("abort", cancelLoading, { once: true });

  try {
    const pdf = await loadingTask.promise;
    if (signal.aborted) throw abortError();
    const pages = await parsePdfPages(pdf, sourceId, sourceType, signal);
    return { ...pages, pageCount: pdf.numPages };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof Error && error.message === "PDF 文本提取失败")
      throw error;
    throw new Error("PDF 文本提取失败");
  } finally {
    signal.removeEventListener("abort", cancelLoading);
    await loadingTask.destroy();
  }
}
