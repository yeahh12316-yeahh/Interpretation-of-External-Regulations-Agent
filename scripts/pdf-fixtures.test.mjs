import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { buildJpegScanPdf, buildTextLayerPdf } from "./pdf-fixtures.mjs";

describe("production smoke PDF fixtures", () => {
  it("builds a real extractable multi-paragraph text PDF", async () => {
    const bytes = buildTextLayerPdf([
      "第一条 示例银行应当建立管理机制。",
      "第二条 示例银行不得虚构合规记录。",
      "第三条 本办法自2026年1月1日起施行。",
    ]);
    const loadingTask = getDocument({ data: new Uint8Array(bytes) });
    try {
      const document = await loadingTask.promise;
      const page = await document.getPage(1);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join("");
      expect(text).toContain("示例银行应当建立管理机制");
      expect(text).toContain("不得虚构合规记录");
      expect(text).toContain("2026年1月1日");
    } finally {
      await loadingTask.destroy();
    }
  });

  it("embeds a raster image as a no-text-layer PDF page", async () => {
    const minimalJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
    const bytes = buildJpegScanPdf(minimalJpeg, 1200, 700);
    const latin = bytes.toString("latin1");
    expect(latin.startsWith("%PDF-")).toBe(true);
    expect(latin).toContain("/Subtype /Image");
    expect(latin).toContain("/Filter /DCTDecode");
    expect(latin).not.toContain("/Font");
  });
});
