import { expect, test } from "@playwright/test";

test("serves every OCR runtime class from the application origin", async ({
  page,
}) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const assets = [
    ["/ocr/tesseract/worker.min.js", "javascript"],
    ["/ocr/tesseract-core/tesseract-core-lstm.wasm.js", "javascript"],
    ["/ocr/tesseract-core/tesseract-core-lstm.wasm", "wasm"],
    ["/ocr/tesseract-core/tesseract-core-simd-lstm.wasm.js", "javascript"],
    ["/ocr/tesseract-core/tesseract-core-simd-lstm.wasm", "wasm"],
    [
      "/ocr/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js",
      "javascript",
    ],
    ["/ocr/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm", "wasm"],
    ["/ocr/lang/chi_sim.traineddata.gz", "gzip"],
    ["/ocr/lang/eng.traineddata.gz", "gzip"],
  ];

  for (const [path, kind] of assets) {
    const response = await page.request.get(`${origin}${path}`);
    expect(response.status(), path).toBe(200);
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
});

test("loads the real local worker and recognizes a synthetic canvas", async ({
  page,
}) => {
  test.setTimeout(180_000);
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
