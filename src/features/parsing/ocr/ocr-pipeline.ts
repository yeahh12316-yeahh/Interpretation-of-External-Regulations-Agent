import type { SourceType } from "../../../domain/source";
import {
  abortError,
  isAbortError,
  raceWithAbort,
  throwIfAborted,
} from "../../../lib/abort";
import type { BoundingBox } from "../build-anchors";
import { createLocalOcrWorker, type OcrWorkerProgress } from "./ocr-worker";

export type OcrImage =
  | string
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | CanvasRenderingContext2D
  | File
  | Blob
  | OffscreenCanvas;

export interface OcrPageBitmap {
  pageNumber: number;
  sourceId: string;
  sourceType: SourceType;
  image: OcrImage;
  width: number;
  height: number;
}

interface OcrRecognitionBlock {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  paragraphs?: Array<{
    lines: Array<{
      words: Array<{
        symbols: Array<{
          text: string;
          confidence: number;
          bbox: { x0: number; y0: number; x1: number; y1: number };
        }>;
      }>;
    }>;
  }>;
}

export interface OcrRecognitionResult {
  data: {
    text: string;
    confidence: number;
    blocks: OcrRecognitionBlock[] | null;
  };
}

export interface OcrWorkerLike {
  recognize(
    image: OcrImage,
    options?: object,
    output?: { text: boolean; blocks: boolean },
  ): Promise<OcrRecognitionResult>;
  terminate(): Promise<unknown>;
}

export type OcrWorkerFactory = (
  onProgress: (progress: OcrWorkerProgress) => void,
) => Promise<OcrWorkerLike>;

export interface OcrRegion {
  text: string;
  confidence: number;
  boundingBox: BoundingBox;
  lowConfidence: boolean;
}

export interface OcrCharacter {
  text: string;
  confidence: number;
  boundingBox: BoundingBox;
}

export type OcrReviewStatus = "unreviewed" | "corrected" | "failed";

export interface OcrCorrectionRecord {
  correctedText: string;
  reviewedBy: string;
  reviewedAt: string;
}

export interface OcrPageResult {
  unitId: string;
  sourceId: string;
  sourceType: SourceType;
  page: number;
  method: "ocr";
  confidence: number;
  text: string;
  originalOcrText: string;
  correctedText: string | null;
  reviewStatus: OcrReviewStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
  correctionHistory: OcrCorrectionRecord[];
  boundingBox: BoundingBox;
  regions: OcrRegion[];
  lowConfidenceCharacters: OcrCharacter[];
  error?: "页面 OCR 识别失败";
}

export interface OcrProgress {
  page: number;
  pageIndex: number;
  pageCount: number;
  status: string;
  progress: number;
}

const normalizeConfidence = (confidence: number): number =>
  Math.max(0, Math.min(1, confidence / 100));

const boxFrom = (bbox: OcrRecognitionBlock["bbox"]): BoundingBox => ({
  x: bbox.x0,
  y: bbox.y0,
  width: Math.max(0, bbox.x1 - bbox.x0),
  height: Math.max(0, bbox.y1 - bbox.y0),
});

const fullPageBox = (page: OcrPageBitmap): BoundingBox => ({
  x: 0,
  y: 0,
  width: page.width,
  height: page.height,
});

const failedResult = (page: OcrPageBitmap): OcrPageResult => ({
  unitId: `${page.sourceId}:p${page.pageNumber}:ocr`,
  sourceId: page.sourceId,
  sourceType: page.sourceType,
  page: page.pageNumber,
  method: "ocr",
  confidence: 0,
  text: "",
  originalOcrText: "",
  correctedText: null,
  reviewStatus: "failed",
  reviewedAt: null,
  reviewedBy: null,
  correctionHistory: [],
  boundingBox: fullPageBox(page),
  regions: [],
  lowConfidenceCharacters: [],
  error: "页面 OCR 识别失败",
});

export async function ocrPages(
  pages: readonly OcrPageBitmap[],
  signal: AbortSignal,
  onProgress: (progress: OcrProgress) => void,
  workerFactory: OcrWorkerFactory = createLocalOcrWorker,
): Promise<OcrPageResult[]> {
  throwIfAborted(signal);
  if (pages.length === 0) return [];

  let worker: OcrWorkerLike | undefined;
  let currentPageIndex = -1;
  let terminated = false;
  const terminate = async () => {
    if (!worker || terminated) return;
    terminated = true;
    await worker.terminate().catch(() => undefined);
  };
  const abortWorker = () => {
    void terminate();
  };
  signal.addEventListener("abort", abortWorker, { once: true });

  const workerCreation = workerFactory((progress) => {
    const pageIndex = Math.max(0, currentPageIndex);
    const page = pages[pageIndex];
    if (!page) return;
    onProgress({
      page: page.pageNumber,
      pageIndex,
      pageCount: pages.length,
      ...progress,
    });
  });
  const assignWorker = workerCreation.then((createdWorker) => {
    worker = createdWorker;
    return createdWorker;
  });

  try {
    worker = await raceWithAbort(assignWorker, signal);
    throwIfAborted(signal);

    const results: OcrPageResult[] = [];
    for (
      currentPageIndex = 0;
      currentPageIndex < pages.length;
      currentPageIndex += 1
    ) {
      const page = pages[currentPageIndex];
      if (!page) continue;
      throwIfAborted(signal);
      onProgress({
        page: page.pageNumber,
        pageIndex: currentPageIndex,
        pageCount: pages.length,
        status: "recognizing page",
        progress: 0,
      });
      try {
        const recognition = await raceWithAbort(
          worker.recognize(page.image, {}, { text: true, blocks: true }),
          signal,
        );
        const text = recognition.data.text.trim();
        if (!text) {
          results.push(failedResult(page));
          continue;
        }
        const confidence = normalizeConfidence(recognition.data.confidence);
        const regions = (recognition.data.blocks ?? [])
          .filter((block) => block.text.trim())
          .map((block) => ({
            text: block.text.trim(),
            confidence: normalizeConfidence(block.confidence),
            boundingBox: boxFrom(block.bbox),
            lowConfidence: normalizeConfidence(block.confidence) < 0.7,
          }));
        const lowConfidenceCharacters = (recognition.data.blocks ?? [])
          .flatMap((block) => block.paragraphs ?? [])
          .flatMap((paragraph) => paragraph.lines)
          .flatMap((line) => line.words)
          .flatMap((word) => word.symbols)
          .filter((symbol) => normalizeConfidence(symbol.confidence) < 0.7)
          .map((symbol) => ({
            text: symbol.text,
            confidence: normalizeConfidence(symbol.confidence),
            boundingBox: boxFrom(symbol.bbox),
          }));
        const boundingBox = regions[0]?.boundingBox ?? fullPageBox(page);
        results.push({
          unitId: `${page.sourceId}:p${page.pageNumber}:ocr`,
          sourceId: page.sourceId,
          sourceType: page.sourceType,
          page: page.pageNumber,
          method: "ocr",
          confidence,
          text,
          originalOcrText: text,
          correctedText: null,
          reviewStatus: "unreviewed",
          reviewedAt: null,
          reviewedBy: null,
          correctionHistory: [],
          boundingBox,
          regions,
          lowConfidenceCharacters,
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError();
        results.push(failedResult(page));
      }
    }
    return results;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError();
    throw error;
  } finally {
    signal.removeEventListener("abort", abortWorker);
    if (signal.aborted && !worker) {
      await Promise.race([
        assignWorker.then(
          () => terminate(),
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 25)),
      ]);
    }
    await terminate();
  }
}
