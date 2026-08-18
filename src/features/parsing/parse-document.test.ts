import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { SourceUnitSchema } from "../../domain/schemas";
import { validateFile } from "../intake/file-policy";
import { hashFile } from "../intake/hash-file";
import { buildAnchors } from "./build-anchors";
import { parseDocx } from "./parse-docx";
import { parseDocument } from "./parse-document";
import { parsePdfPages } from "./parse-pdf";

const fixturePath = (name: string) =>
  resolve(process.cwd(), "tests", "fixtures", name);

const fixtureFile = async (name: string, type: string): Promise<File> => {
  const bytes = await readFile(fixturePath(name));
  const file = new File([bytes], name, { type });

  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
    });
  }

  return file;
};

const settleWithin = async <T>(
  promise: Promise<T>,
  timeoutMs = 100,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("operation did not settle after abort")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

describe("file intake boundaries", () => {
  test("hashes the real file bytes with SHA-256", async () => {
    const file = new File(["abc"], "regulation.txt", { type: "text/plain" });

    await expect(hashFile(file)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("rejects empty, oversized, unsupported, and encrypted documents", async () => {
    await expect(
      validateFile(new File([], "empty.txt", { type: "text/plain" })),
    ).rejects.toThrow(/空文件/);
    await expect(
      validateFile(new File(["12345"], "large.txt", { type: "text/plain" }), {
        maxBytes: 4,
      }),
    ).rejects.toThrow(/大小上限/);
    await expect(
      validateFile(
        new File(["content"], "regulation.rtf", { type: "application/rtf" }),
      ),
    ).rejects.toThrow(/PDF、DOCX 或 TXT/);
    await expect(
      validateFile(
        new File(
          ["%PDF-1.7\n1 0 obj<</Encrypt 2 0 R>>endobj"],
          "encrypted.pdf",
          {
            type: "application/pdf",
          },
        ),
      ),
    ).rejects.toThrow(/加密/);
  });

  test("does not disclose file content in hashing errors", async () => {
    const file = new File(["敏感正文不得出现在错误里"], "regulation.txt", {
      type: "text/plain",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => {
        throw new Error("敏感正文不得出现在错误里");
      },
    });

    await expect(hashFile(file)).rejects.toThrow("无法计算文件哈希");
    await expect(hashFile(file)).rejects.not.toThrow(/敏感正文/);
  });

  test("aborts validation while a PDF read never settles", async () => {
    const controller = new AbortController();
    const file = new File(["%PDF-1.7"], "pending.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => new Promise<ArrayBuffer>(() => undefined),
    });

    const validation = validateFile(file, {}, controller.signal);
    controller.abort();

    await expect(settleWithin(validation)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("aborts hashing while file.arrayBuffer never settles", async () => {
    const controller = new AbortController();
    const file = new File(["pending"], "pending.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => new Promise<ArrayBuffer>(() => undefined),
    });

    const hashing = hashFile(file, controller.signal);
    controller.abort();

    await expect(settleWithin(hashing)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("parseDocument", () => {
  test("parses a real two-page PDF through PDF.js and preserves page anchors", async () => {
    const result = await parseDocument(
      await fixtureFile("text-regulation.pdf", "application/pdf"),
      "regulatory_text",
      new AbortController().signal,
    );

    expect(result.pageCount).toBe(2);
    expect(result.successfulPages).toEqual([1, 2]);
    expect(result.failedPages).toEqual([]);
    expect(result.units[0]).toMatchObject({
      sourceType: "regulatory_text",
      page: 1,
      extractionMethod: "text_layer",
    });
    expect(result.units.map((unit) => unit.text).join("")).toContain(
      "商业银行应当",
    );
    expect(result.anchors[0]).toMatchObject({
      sourceId: result.source.sourceId,
      sourceType: "regulatory_text",
      page: 1,
      paragraphIndex: 0,
    });
    expect(() => SourceUnitSchema.parse(result.source)).not.toThrow();
  });

  test("parses synthetic DOCX paragraphs without inventing page numbers", async () => {
    const result = await parseDocument(
      await fixtureFile(
        "regulation.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      "official_interpretation",
      new AbortController().signal,
    );

    expect(result.pageCount).toBeNull();
    expect(result.units.map((unit) => unit.paragraphIndex)).toEqual([0, 1, 2]);
    expect(result.units.every((unit) => unit.page === null)).toBe(true);
    expect(
      result.units.every(
        (unit) => unit.sourceType === "official_interpretation",
      ),
    ).toBe(true);
    expect(result.source.content).toContain("本解读仅用于合成测试");
  });

  test("decodes UTF-8 and UTF-16 BOM text and keeps source categories separate", async () => {
    const utf8 = await parseDocument(
      await fixtureFile("regulation.txt", "text/plain"),
      "regulatory_text",
      new AbortController().signal,
    );
    const utf16Bytes = new Uint8Array([
      0xff,
      0xfe,
      ...Array.from("第一条\n商业银行应当审慎经营。").flatMap((character) => {
        const code = character.charCodeAt(0);
        return [code & 0xff, code >> 8];
      }),
    ]);
    const utf16File = new File([utf16Bytes], "interpretation.txt", {
      type: "text/plain",
    });
    if (typeof utf16File.arrayBuffer !== "function") {
      Object.defineProperty(utf16File, "arrayBuffer", {
        value: async () => utf16Bytes.buffer,
      });
    }
    const utf16 = await parseDocument(
      utf16File,
      "official_interpretation",
      new AbortController().signal,
    );

    expect(utf8.source.content).toContain("第一条");
    expect(utf16.source.content).toContain("审慎经营");
    expect(utf8.source.sourceType).toBe("regulatory_text");
    expect(utf16.source.sourceType).toBe("official_interpretation");
    expect(utf8.source.sourceId).not.toBe(utf16.source.sourceId);
  });

  test("stops before parsing when cancellation is already requested", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      parseDocument(
        await fixtureFile("regulation.txt", "text/plain"),
        "regulatory_text",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("aborts a second file read that never settles", async () => {
    const controller = new AbortController();
    const bytes = new TextEncoder().encode("第一条 商业银行应当审慎经营。");
    const file = new File([bytes], "pending.txt", { type: "text/plain" });
    let readCount = 0;
    let markSecondReadStarted!: () => void;
    const secondReadStarted = new Promise<void>((resolve) => {
      markSecondReadStarted = resolve;
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => {
        readCount += 1;
        if (readCount === 1) return Promise.resolve(bytes.buffer);
        markSecondReadStarted();
        return new Promise<ArrayBuffer>(() => undefined);
      },
    });

    const parsing = parseDocument(file, "regulatory_text", controller.signal);
    await settleWithin(secondReadStarted);
    controller.abort();

    await expect(settleWithin(parsing)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("aborts while Mammoth extraction never settles", async () => {
    const controller = new AbortController();
    const file = await fixtureFile(
      "regulation.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    let markExtractionStarted!: () => void;
    const extractionStarted = new Promise<void>((resolve) => {
      markExtractionStarted = resolve;
    });
    const extraction = parseDocx(
      await file.arrayBuffer(),
      "SRC-official_interpretation-pending",
      "official_interpretation",
      controller.signal,
      () => {
        markExtractionStarted();
        return new Promise(() => undefined);
      },
    );
    await settleWithin(extractionStarted);
    controller.abort();

    await expect(settleWithin(extraction)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("page failures and stable anchors", () => {
  test("reconstructs Chinese text lines without inserting spaces between glyphs", async () => {
    const fakePdf = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [
            {
              str: "第",
              transform: [1, 0, 0, 1, 20, 700],
              width: 12,
              height: 12,
            },
            {
              str: "一",
              transform: [1, 0, 0, 1, 32, 700],
              width: 12,
              height: 12,
            },
            {
              str: "条",
              transform: [1, 0, 0, 1, 44, 700],
              width: 12,
              height: 12,
            },
            {
              str: "商",
              transform: [1, 0, 0, 1, 20, 680],
              width: 12,
              height: 12,
            },
            {
              str: "业",
              transform: [1, 0, 0, 1, 32, 680],
              width: 12,
              height: 12,
            },
            {
              str: "银",
              transform: [1, 0, 0, 1, 44, 680],
              width: 12,
              height: 12,
            },
            {
              str: "行",
              transform: [1, 0, 0, 1, 56, 680],
              width: 12,
              height: 12,
            },
          ],
        }),
      }),
    };

    const result = await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-lines",
      "regulatory_text",
      new AbortController().signal,
    );

    expect(result.units.map((unit) => unit.text)).toEqual([
      "第一条",
      "商业银行",
    ]);
    expect(result.units.map((unit) => unit.paragraphIndex)).toEqual([0, 1]);
  });

  test("uses PDF geometry instead of inserting spaces into fragmented article digits and Latin text", async () => {
    const fakePdf = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [
            {
              str: "第",
              transform: [1, 0, 0, 1, 20, 700],
              width: 12,
              height: 12,
            },
            {
              str: "2",
              transform: [1, 0, 0, 1, 32, 700],
              width: 7,
              height: 12,
            },
            {
              str: "0",
              transform: [1, 0, 0, 1, 39, 700],
              width: 7,
              height: 12,
            },
            {
              str: "2",
              transform: [1, 0, 0, 1, 46, 700],
              width: 7,
              height: 12,
            },
            {
              str: "6",
              transform: [1, 0, 0, 1, 53, 700],
              width: 7,
              height: 12,
            },
            {
              str: "条",
              transform: [1, 0, 0, 1, 60, 700],
              width: 12,
              height: 12,
            },
            {
              str: "B",
              transform: [1, 0, 0, 1, 20, 680],
              width: 8,
              height: 12,
            },
            {
              str: "a",
              transform: [1, 0, 0, 1, 28, 680],
              width: 7,
              height: 12,
            },
            {
              str: "n",
              transform: [1, 0, 0, 1, 35, 680],
              width: 7,
              height: 12,
            },
            {
              str: "k",
              transform: [1, 0, 0, 1, 42, 680],
              width: 7,
              height: 12,
            },
            {
              str: "Risk",
              transform: [1, 0, 0, 1, 58, 680],
              width: 24,
              height: 12,
            },
          ],
        }),
      }),
    };

    const result = await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-ascii",
      "regulatory_text",
      new AbortController().signal,
    );

    expect(result.units.map((unit) => unit.text)).toEqual([
      "第2026条",
      "Bank Risk",
    ]);
    expect(result.units[0]?.article).toBe("第2026条");
  });

  test("cleans every PDF page after extraction and disables marked-content work", async () => {
    const cleanup = vi.fn();
    const getTextContent = vi.fn(async () => ({
      items: [
        {
          str: "第一条 页面文本",
          transform: [1, 0, 0, 1, 20, 700],
          width: 100,
          height: 12,
        },
      ],
    }));
    const fakePdf = {
      numPages: 1,
      getPage: async () => ({ getTextContent, cleanup }),
    };

    await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-cleanup",
      "regulatory_text",
      new AbortController().signal,
    );

    expect(getTextContent).toHaveBeenCalledWith({
      includeMarkedContent: false,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("records failed and low-text PDF pages instead of silently dropping them", async () => {
    const fakePdf = {
      numPages: 3,
      getPage: async (pageNumber: number) => {
        if (pageNumber === 2) throw new Error("synthetic page failure");
        return {
          getTextContent: async () => ({
            items:
              pageNumber === 1
                ? [
                    {
                      str: "第一条 商业银行应当建立风险管理制度。",
                      transform: [1, 0, 0, 1, 20, 700],
                      width: 200,
                      height: 12,
                    },
                  ]
                : [],
          }),
        };
      },
    };

    const result = await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-fixture",
      "regulatory_text",
      new AbortController().signal,
    );

    expect(result.failedPages).toEqual([
      { page: 2, error: "页面文本提取失败" },
    ]);
    expect(result.successfulPages).toEqual([1, 3]);
    expect(result.lowTextPages).toEqual([3]);
    expect(
      result.units.some((unit) => unit.page === 3 && unit.text === ""),
    ).toBe(true);
  });

  test("replaces a low-text PDF page with located OCR units", async () => {
    const fakePdf = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
      }),
    };

    const result = await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-scanned",
      "regulatory_text",
      new AbortController().signal,
      {
        renderPageBitmap: async ({ pageNumber, sourceId, sourceType }) => ({
          pageNumber,
          sourceId,
          sourceType,
          image: {} as HTMLCanvasElement,
          width: 1200,
          height: 1600,
        }),
        runOcr: async (pages) =>
          pages.map((page) => ({
            unitId: `${page.sourceId}:p${page.pageNumber}:ocr`,
            sourceId: page.sourceId,
            sourceType: page.sourceType,
            page: page.pageNumber,
            method: "ocr" as const,
            confidence: 0.78,
            text: "第一条 银行业金融机构不得泄露客户信息。",
            originalOcrText: "第一条 银行业金融机构不得泄露客户信息。",
            correctedText: null,
            reviewStatus: "unreviewed" as const,
            reviewedAt: null,
            reviewedBy: null,
            correctionHistory: [],
            boundingBox: { x: 20, y: 40, width: 800, height: 60 },
            regions: [
              {
                text: "第一条 银行业金融机构不得泄露客户信息。",
                confidence: 0.78,
                boundingBox: { x: 20, y: 40, width: 800, height: 60 },
                lowConfidence: false,
              },
            ],
            lowConfidenceCharacters: [
              {
                text: "不",
                confidence: 0.42,
                boundingBox: { x: 600, y: 40, width: 30, height: 60 },
              },
            ],
          })),
      },
    );

    expect(result.units).toEqual([
      expect.objectContaining({
        page: 1,
        unitId: "SRC-regulatory_text-scanned:p1:ocr",
        text: "第一条 银行业金融机构不得泄露客户信息。",
        extractionMethod: "ocr",
        confidence: 0.78,
        originalOcrText: "第一条 银行业金融机构不得泄露客户信息。",
        reviewStatus: "unreviewed",
        boundingBox: { x: 20, y: 40, width: 800, height: 60 },
        lowConfidenceCharacters: [
          expect.objectContaining({ text: "不", confidence: 0.42 }),
        ],
      }),
    ]);
    expect(result.ocrReviews).toHaveLength(1);
    expect(result.ocrReviews[0]).toMatchObject({
      unitId: "SRC-regulatory_text-scanned:p1:ocr",
      lowConfidenceCharacters: [
        expect.objectContaining({ text: "不", confidence: 0.42 }),
      ],
    });
    expect(result.failedPages).toEqual([]);
    expect(result.ocrFailedPages).toEqual([]);
    expect(result.lowTextPages).toEqual([1]);
    expect(result.successfulPages).toEqual([1]);
  });

  test("falls back to OCR when the PDF text layer throws", async () => {
    const fakePdf = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => {
          throw new Error("synthetic text-layer exception");
        },
      }),
    };

    const result = await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-text-layer-fallback",
      "regulatory_text",
      new AbortController().signal,
      {
        renderPageBitmap: async ({ pageNumber, sourceId, sourceType }) => ({
          pageNumber,
          sourceId,
          sourceType,
          image: {} as HTMLCanvasElement,
          width: 1200,
          height: 1600,
        }),
        runOcr: async (pages) =>
          pages.map((page) => ({
            unitId: `${page.sourceId}:p${page.pageNumber}:ocr`,
            sourceId: page.sourceId,
            sourceType: page.sourceType,
            page: page.pageNumber,
            method: "ocr" as const,
            confidence: 0.86,
            text: "第一条 文本层异常时仍可通过 OCR 提取。",
            originalOcrText: "第一条 文本层异常时仍可通过 OCR 提取。",
            correctedText: null,
            reviewStatus: "unreviewed" as const,
            reviewedAt: null,
            reviewedBy: null,
            correctionHistory: [],
            boundingBox: { x: 0, y: 0, width: 1200, height: 1600 },
            regions: [],
            lowConfidenceCharacters: [],
          })),
      },
    );

    expect(result.units).toEqual([
      expect.objectContaining({
        page: 1,
        extractionMethod: "ocr",
        text: "第一条 文本层异常时仍可通过 OCR 提取。",
      }),
    ]);
    expect(result.failedPages).toEqual([]);
    expect(result.ocrFailedPages).toEqual([]);
    expect(result.lowTextPages).toEqual([1]);
    expect(result.successfulPages).toEqual([1]);
  });

  test("records an OCR failure as a finalization blocker", async () => {
    const fakePdf = {
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
    };

    const result = await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-scanned-failure",
      "regulatory_text",
      new AbortController().signal,
      {
        renderPageBitmap: async ({ pageNumber, sourceId, sourceType }) => ({
          pageNumber,
          sourceId,
          sourceType,
          image: {} as HTMLCanvasElement,
          width: 1200,
          height: 1600,
        }),
        runOcr: async (pages) =>
          pages.map((page) => ({
            unitId: `${page.sourceId}:p${page.pageNumber}:ocr`,
            sourceId: page.sourceId,
            sourceType: page.sourceType,
            page: page.pageNumber,
            method: "ocr" as const,
            confidence: 0,
            text: "",
            originalOcrText: "",
            correctedText: null,
            reviewStatus: "failed" as const,
            reviewedAt: null,
            reviewedBy: null,
            correctionHistory: [],
            boundingBox: { x: 0, y: 0, width: 1200, height: 1600 },
            regions: [],
            lowConfidenceCharacters: [],
            error: "页面 OCR 识别失败" as const,
          })),
      },
    );

    expect(result.ocrFailedPages).toEqual([1]);
    expect(result.failedPages).toEqual([
      { page: 1, error: "页面 OCR 识别失败" },
    ]);
    expect(result.successfulPages).toEqual([]);
    expect(result.ocrReviews).toEqual([
      expect.objectContaining({ page: 1, reviewStatus: "failed" }),
    ]);
  });

  test("turns an OCR worker startup failure into explicit page failures", async () => {
    const fakePdf = {
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
    };

    const result = await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-worker-failure",
      "regulatory_text",
      new AbortController().signal,
      {
        renderPageBitmap: async ({ pageNumber, sourceId, sourceType }) => ({
          pageNumber,
          sourceId,
          sourceType,
          image: {} as HTMLCanvasElement,
          width: 1200,
          height: 1600,
        }),
        runOcr: async () => {
          throw new Error("synthetic worker startup detail");
        },
      },
    );

    expect(result.failedPages).toEqual([
      { page: 1, error: "页面 OCR 识别失败" },
    ]);
    expect(result.ocrFailedPages).toEqual([1]);
    expect(result.units).toEqual([]);
  });

  test("OCRs low-text pages sequentially and releases each bitmap before rendering the next", async () => {
    const events: string[] = [];
    const fakePdf = {
      numPages: 2,
      getPage: async (pageNumber: number) => {
        events.push(`get:${pageNumber}`);
        return { getTextContent: async () => ({ items: [] }) };
      },
    };

    const result = await parsePdfPages(
      fakePdf,
      "SRC-regulatory_text-sequential",
      "regulatory_text",
      new AbortController().signal,
      {
        renderPageBitmap: async ({ pageNumber, sourceId, sourceType }) => {
          events.push(`render:${pageNumber}`);
          return {
            pageNumber,
            sourceId,
            sourceType,
            image: { pageNumber } as unknown as HTMLCanvasElement,
            width: 1200,
            height: 1600,
          };
        },
        runOcr: async (pages) => {
          expect(pages).toHaveLength(1);
          const page = pages[0]!;
          events.push(`ocr:${page.pageNumber}`);
          return [
            {
              unitId: `${page.sourceId}:p${page.pageNumber}:ocr`,
              sourceId: page.sourceId,
              sourceType: page.sourceType,
              page: page.pageNumber,
              method: "ocr" as const,
              confidence: 0.9,
              text: `第${page.pageNumber}页合成 OCR 文本不得遗漏`,
              originalOcrText: `第${page.pageNumber}页合成 OCR 文本不得遗漏`,
              correctedText: null,
              reviewStatus: "unreviewed" as const,
              reviewedAt: null,
              reviewedBy: null,
              correctionHistory: [],
              boundingBox: { x: 0, y: 0, width: 1200, height: 1600 },
              regions: [],
              lowConfidenceCharacters: [],
            },
          ];
        },
        releasePageBitmap: (page) => {
          events.push(`release:${page.pageNumber}`);
        },
      },
    );

    expect(events).toEqual([
      "get:1",
      "render:1",
      "ocr:1",
      "release:1",
      "get:2",
      "render:2",
      "ocr:2",
      "release:2",
    ]);
    expect(result.ocrReviews).toHaveLength(2);
  });

  test("propagates article context into deterministic reverse-location anchors", () => {
    const units = [
      {
        sourceId: "SRC-regulatory_text-abc",
        sourceType: "regulatory_text" as const,
        page: 1,
        article: "第一条",
        paragraphIndex: 0,
        text: "第一条 商业银行应当建立风险管理制度。",
        extractionMethod: "text_layer" as const,
        confidence: 1,
      },
      {
        sourceId: "SRC-regulatory_text-abc",
        sourceType: "regulatory_text" as const,
        page: 1,
        article: null,
        paragraphIndex: 1,
        text: "相关制度应当定期评估。",
        extractionMethod: "text_layer" as const,
        confidence: 1,
      },
    ];

    expect(buildAnchors(units)).toEqual([
      {
        sourceId: "SRC-regulatory_text-abc",
        sourceType: "regulatory_text",
        page: 1,
        article: "第一条",
        paragraphIndex: 0,
        quote: "第一条 商业银行应当建立风险管理制度。",
      },
      {
        sourceId: "SRC-regulatory_text-abc",
        sourceType: "regulatory_text",
        page: 1,
        article: "第一条",
        paragraphIndex: 1,
        quote: "相关制度应当定期评估。",
      },
    ]);
  });

  test("does not trust a parsed unit article that is absent from its text", () => {
    const units = [
      {
        sourceId: "SRC-regulatory_text-untrusted",
        sourceType: "regulatory_text" as const,
        page: 1,
        article: "第九十九条",
        paragraphIndex: 0,
        text: "前言。",
        extractionMethod: "text_layer" as const,
        confidence: 1,
      },
      {
        sourceId: "SRC-regulatory_text-untrusted",
        sourceType: "regulatory_text" as const,
        page: 1,
        article: null,
        paragraphIndex: 1,
        text: "银行应当保存记录。",
        extractionMethod: "text_layer" as const,
        confidence: 1,
      },
    ];

    expect(buildAnchors(units).map(({ article }) => article)).toEqual([
      null,
      null,
    ]);
  });

  test("only switches canonical article at a unit-leading article heading", () => {
    const common = {
      sourceId: "SRC-regulatory_text-heading",
      sourceType: "regulatory_text" as const,
      page: 1,
      extractionMethod: "text_layer" as const,
      confidence: 1,
    };
    const units = [
      {
        ...common,
        article: "第五条",
        paragraphIndex: 0,
        text: "第五条 总则。",
      },
      {
        ...common,
        article: "第一条",
        paragraphIndex: 1,
        text: "具体流程按照第一条规定执行。",
      },
      {
        ...common,
        article: null,
        paragraphIndex: 2,
        text: "\n  第一条 新编总则。",
      },
    ];

    expect(buildAnchors(units).map(({ article }) => article)).toEqual([
      "第五条",
      "第五条",
      "第一条",
    ]);
  });
});
