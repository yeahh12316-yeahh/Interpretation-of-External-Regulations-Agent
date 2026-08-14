import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { SourceUnitSchema } from "../../domain/schemas";
import { validateFile } from "../intake/file-policy";
import { hashFile } from "../intake/hash-file";
import { buildAnchors } from "./build-anchors";
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
});
