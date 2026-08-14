import { describe, expect, test, vi } from "vitest";

import { isScannedPage } from "./detect-scanned-page";
import {
  ocrPages,
  type OcrPageBitmap,
  type OcrWorkerLike,
} from "./ocr-pipeline";

const scannedPage: OcrPageBitmap = {
  pageNumber: 2,
  sourceId: "SRC-regulatory_text-synthetic",
  sourceType: "regulatory_text",
  image: {} as HTMLCanvasElement,
  width: 1200,
  height: 1600,
};

const syntheticRecognition = {
  data: {
    text: "第一条 银行业金融机构不得泄露客户信息。\n",
    confidence: 82,
    blocks: [
      {
        text: "第一条 银行业金融机构不得泄露客户信息。",
        confidence: 82,
        bbox: { x0: 40, y0: 60, x1: 880, y1: 120 },
        paragraphs: [
          {
            lines: [
              {
                words: [
                  {
                    symbols: [
                      {
                        text: "不",
                        confidence: 42,
                        bbox: { x0: 600, y0: 60, x1: 630, y1: 120 },
                      },
                      {
                        text: "得",
                        confidence: 91,
                        bbox: { x0: 630, y0: 60, x1: 660, y1: 120 },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

const workerDouble = () => {
  const worker: OcrWorkerLike = {
    recognize: vi.fn().mockResolvedValue(syntheticRecognition),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
  return worker;
};

describe("scanned page detection", () => {
  test("routes pages with fewer than twelve extracted characters to OCR", () => {
    expect(isScannedPage(" 第一条 ")).toBe(true);
    expect(isScannedPage("第一条 银行业金融机构应当建立管理制度。")).toBe(
      false,
    );
  });
});

describe("ocrPages", () => {
  test("returns normalized confidence, text and page coordinates", async () => {
    const worker = workerDouble();

    const result = await ocrPages(
      [scannedPage],
      new AbortController().signal,
      () => undefined,
      async () => worker,
    );

    expect(result[0]).toMatchObject({
      unitId: "SRC-regulatory_text-synthetic:p2:ocr",
      page: 2,
      method: "ocr",
      confidence: 0.82,
      text: expect.stringContaining("不得"),
      originalOcrText: expect.stringContaining("不得"),
      correctedText: null,
      reviewStatus: "unreviewed",
      reviewedAt: null,
      boundingBox: { x: 40, y: 60, width: 840, height: 60 },
    });
    expect(result[0]?.regions[0]).toMatchObject({
      confidence: 0.82,
      boundingBox: { x: 40, y: 60, width: 840, height: 60 },
    });
    expect(result[0]?.lowConfidenceCharacters).toEqual([
      {
        text: "不",
        confidence: 0.42,
        boundingBox: { x: 600, y: 60, width: 30, height: 60 },
      },
    ]);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  test("returns an explicit failed page instead of silently dropping it", async () => {
    const worker = workerDouble();
    vi.mocked(worker.recognize).mockRejectedValueOnce(
      new Error("sensitive engine detail"),
    );

    const [result] = await ocrPages(
      [scannedPage],
      new AbortController().signal,
      () => undefined,
      async () => worker,
    );

    expect(result).toMatchObject({
      page: 2,
      method: "ocr",
      confidence: 0,
      text: "",
      error: "页面 OCR 识别失败",
      reviewStatus: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive engine detail");
  });

  test("treats an empty OCR response as a failed page", async () => {
    const worker = workerDouble();
    vi.mocked(worker.recognize).mockResolvedValueOnce({
      data: { text: "   ", confidence: 0, blocks: [] },
    });

    const [result] = await ocrPages(
      [scannedPage],
      new AbortController().signal,
      () => undefined,
      async () => worker,
    );

    expect(result).toMatchObject({
      page: 2,
      reviewStatus: "failed",
      error: "页面 OCR 识别失败",
    });
  });

  test("rejects promptly with AbortError and terminates the worker", async () => {
    const controller = new AbortController();
    const worker = workerDouble();
    vi.mocked(worker.recognize).mockImplementation(
      () => new Promise(() => undefined),
    );

    const pending = ocrPages(
      [scannedPage],
      controller.signal,
      () => undefined,
      async () => worker,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  test("terminates a worker that finishes starting after cancellation", async () => {
    const controller = new AbortController();
    const worker = workerDouble();
    let resolveWorker: ((worker: OcrWorkerLike) => void) | undefined;
    const pending = ocrPages(
      [scannedPage],
      controller.signal,
      () => undefined,
      () =>
        new Promise<OcrWorkerLike>((resolve) => {
          resolveWorker = resolve;
        }),
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolveWorker?.(worker);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
