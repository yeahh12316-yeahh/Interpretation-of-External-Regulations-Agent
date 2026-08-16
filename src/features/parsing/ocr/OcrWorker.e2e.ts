import { expect, test as baseTest } from "../../../../playwright-fixtures";

// Tesseract chi_sim ships legacy config keys that the current engine reports as
// ignored warnings; recognition still completes and is asserted below.
const ocrTest = baseTest.extend({
  expectedConsoleErrors: async ({}, use) =>
    use({
      specs: [
        "language_model_ngram_on",
        "segsearch_max_char_wh_ratio",
        "language_model_ngram_space_delimited_language",
        "language_model_use_sigmoidal_certainty",
        "language_model_ngram_nonmatch_score",
        "classify_integer_matcher_multiplier",
        "assume_fixed_pitch_char_segment",
        "allow_blob_division",
      ].map((parameter) => ({
        text: new RegExp(`^Warning: Parameter not found: ${parameter}$`, "u"),
        url: /^http:\/\/127\.0\.0\.1:4173\/ocr\/tesseract-7\.0\.0-data-1\.0\.0\/tesseract-core\/tesseract-core-relaxedsimd-lstm\.wasm\.js$/u,
        count: 1,
      })),
    }),
});

import type { ParseResult } from "../parse-document";

baseTest("serves every OCR runtime class from the application origin", async ({
  page,
}) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const assetBase = "/ocr/tesseract-7.0.0-data-1.0.0";
  const assets = [
    [`${assetBase}/tesseract/worker.min.js`, "javascript"],
    [`${assetBase}/tesseract-core/tesseract-core-lstm.wasm.js`, "javascript"],
    [`${assetBase}/tesseract-core/tesseract-core-lstm.wasm`, "wasm"],
    [
      `${assetBase}/tesseract-core/tesseract-core-simd-lstm.wasm.js`,
      "javascript",
    ],
    [`${assetBase}/tesseract-core/tesseract-core-simd-lstm.wasm`, "wasm"],
    [
      `${assetBase}/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js`,
      "javascript",
    ],
    [
      `${assetBase}/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm`,
      "wasm",
    ],
    [`${assetBase}/lang/chi_sim.traineddata.gz`, "gzip"],
    [`${assetBase}/lang/eng.traineddata.gz`, "gzip"],
  ];

  for (const [path, kind] of assets) {
    const response = await page.request.get(`${origin}${path}`);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["cache-control"], path).toBe("no-store");
    const bytes = await response.body();
    if (kind === "javascript") {
      expect(response.headers()["content-type"], path).toContain("javascript");
      expect(bytes.byteLength, path).toBeGreaterThan(50_000);
    } else if (kind === "wasm") {
      expect(Array.from(bytes.subarray(0, 4)), path).toEqual([0, 97, 115, 109]);
    } else {
      expect(Array.from(bytes.subarray(0, 2)), path).toEqual([31, 139]);
    }
  }

  const policyResponse = await page.request.get(
    `${origin}/ocr-cache-policy.json`,
  );
  expect(policyResponse.headers()["content-type"]).toContain(
    "application/json",
  );
  expect(await policyResponse.json()).toEqual({
    namespace: "tesseract-7.0.0-data-1.0.0",
    pathPattern: "/ocr/tesseract-7.0.0-data-1.0.0/*",
    cacheControl: "public, max-age=31536000, immutable",
    rule: "Only versioned OCR assets may be cached immutably; change the namespace whenever worker, core, or language data versions change.",
  });
});

ocrTest("loads the real local worker and recognizes a synthetic canvas", async ({
  page,
}) => {
  ocrTest.setTimeout(180_000);
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4173")
      externalRequests.push(request.url());
  });
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const moduleUrl = "/src/features/parsing/ocr/ocr-worker.ts";
    const { createLocalOcrWorker } = (await import(moduleUrl)) as {
      createLocalOcrWorker: () => Promise<{
        recognize(image: HTMLCanvasElement): Promise<{
          data: { text: string; confidence: number };
        }>;
        terminate(): Promise<unknown>;
      }>;
    };
    const canvas = document.createElement("canvas");
    canvas.width = 1000;
    canvas.height = 220;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "black";
    context.font = "bold 72px Arial";
    context.fillText("DO NOT DISCLOSE", 50, 135);

    const worker = await createLocalOcrWorker();
    try {
      const recognition = await worker.recognize(canvas);
      return {
        text: recognition.data.text,
        confidence: recognition.data.confidence,
      };
    } finally {
      await worker.terminate();
    }
  });

  expect(result.text.replace(/\s/g, " ")).toContain("DO NOT DISCLOSE");
  expect(result.confidence).toBeGreaterThan(0);
  expect(externalRequests).toEqual([]);
});

ocrTest("parses the real no-text-layer PDF through PDF.js and local OCR", async ({
  page,
}) => {
  ocrTest.setTimeout(180_000);
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4173")
      externalRequests.push(request.url());
  });
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const fixtureResponse = await fetch(
      "/tests/fixtures/scanned-regulation.pdf",
    );
    if (!fixtureResponse.ok) throw new Error("fixture unavailable");
    const bytes = await fixtureResponse.arrayBuffer();
    const parseModuleUrl = "/src/features/parsing/parse-document.ts";
    const pdfModuleUrl = "/src/features/parsing/parse-pdf.ts";
    const reviewModuleUrl = "/src/features/parsing/OcrReview.tsx";
    const { parseDocument } = (await import(parseModuleUrl)) as {
      parseDocument(
        file: File,
        sourceType: "regulatory_text",
        signal: AbortSignal,
      ): Promise<ParseResult>;
    };
    const { inspectPdfTextLayer } = (await import(pdfModuleUrl)) as {
      inspectPdfTextLayer(
        bytes: ArrayBuffer,
        signal: AbortSignal,
      ): Promise<{ page: number; itemCount: number; text: string }[]>;
    };
    const { applyOcrCorrection } = (await import(reviewModuleUrl)) as {
      applyOcrCorrection(
        result: ParseResult,
        reviewId: string,
        correctedText: string,
        reviewer: string,
        reviewedAt: string,
      ): ParseResult;
    };
    const textLayer = await inspectPdfTextLayer(
      bytes.slice(0),
      new AbortController().signal,
    );
    const parsed = await parseDocument(
      new File([bytes], "scanned-regulation.pdf", {
        type: "application/pdf",
      }),
      "regulatory_text",
      new AbortController().signal,
    );
    const reviewId = parsed.ocrReviews[0]?.unitId;
    if (!reviewId) throw new Error("OCR review unavailable");
    const corrected = applyOcrCorrection(
      parsed,
      reviewId,
      "第一条 银行业金融机构不得泄露客户个人信息。",
      "浏览器集成测试复核员",
      "2026-08-14T12:00:00.000Z",
    );
    return {
      textLayer,
      sourceText: parsed.source.content,
      units: parsed.units,
      ocrReviews: parsed.ocrReviews,
      quality: parsed.quality,
      corrected: {
        sourceText: corrected.source.content,
        unit: corrected.units[0],
        review: corrected.ocrReviews[0],
        anchor: corrected.anchors[0],
      },
    };
  });

  expect(result.textLayer).toEqual([{ page: 1, itemCount: 0, text: "" }]);
  expect(result.sourceText.replace(/\s/g, "")).toContain("不得");
  expect(result.units).toEqual([
    expect.objectContaining({
      unitId: expect.stringMatching(/:p1:ocr$/),
      extractionMethod: "ocr",
      confidence: expect.any(Number),
    }),
  ]);
  expect(result.ocrReviews).toEqual([
    expect.objectContaining({
      unitId: expect.stringMatching(/:p1:ocr$/),
      confidence: expect.any(Number),
    }),
  ]);
  expect(result.quality).toMatchObject({
    lowTextPages: [1],
    ocrFailedPages: [],
    finalizationBlocked: false,
  });
  expect(result.corrected).toMatchObject({
    sourceText: "第一条 银行业金融机构不得泄露客户个人信息。",
    unit: {
      unitId: expect.stringMatching(/:p1:ocr$/),
      text: "第一条 银行业金融机构不得泄露客户个人信息。",
      originalOcrText: expect.stringContaining("合 成 扫 描"),
      correctedText: "第一条 银行业金融机构不得泄露客户个人信息。",
      reviewStatus: "corrected",
      reviewedBy: "浏览器集成测试复核员",
      reviewedAt: "2026-08-14T12:00:00.000Z",
    },
    review: {
      unitId: expect.stringMatching(/:p1:ocr$/),
      originalOcrText: expect.stringContaining("合 成 扫 描"),
      correctedText: "第一条 银行业金融机构不得泄露客户个人信息。",
      correctionHistory: [
        {
          correctedText: "第一条 银行业金融机构不得泄露客户个人信息。",
          reviewedBy: "浏览器集成测试复核员",
          reviewedAt: "2026-08-14T12:00:00.000Z",
        },
      ],
    },
    anchor: {
      quote: "第一条 银行业金融机构不得泄露客户个人信息。",
    },
  });
  expect(externalRequests).toEqual([]);
});
