import { inflateRawSync } from "node:zlib";
import { expect, it } from "vitest";

import { buildFullReport } from "./build-full-report";
import { buildQuickCommentary } from "./build-quick-commentary";
import { exportDocx } from "./export-docx";
import {
  draftReportSession,
  reviewedReportSession,
} from "./__test__/report-fixture";

const unzipText = (bytes: Uint8Array, fileName: string): string => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length - 30; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(
      bytes.slice(nameStart, nameStart + nameLength),
    );
    const dataStart = nameStart + nameLength + extraLength;
    if (name !== fileName) continue;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    return new TextDecoder().decode(
      method === 0 ? compressed : inflateRawSync(compressed),
    );
  }
  throw new Error(`ZIP entry missing: ${fileName}`);
};

it("exports editable standard_business_brief OOXML with memo masthead, fixed tables, headers, footers and footnotes", async () => {
  const report = buildFullReport(reviewedReportSession(), {
    generatedAt: "2026-08-16T03:00:00.000Z",
  });
  const blob = await exportDocx(report);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const documentXml = unzipText(bytes, "word/document.xml");
  const stylesXml = unzipText(bytes, "word/styles.xml");
  const footnotesXml = unzipText(bytes, "word/footnotes.xml");

  expect(bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
  expect(blob.type).toContain("wordprocessingml.document");
  expect(documentXml).toContain("外规解读报告");
  expect(documentXml).toContain('w:tblLayout w:type="fixed"');
  expect(documentXml).toContain('w:tblW w:type="dxa" w:w="9360"');
  expect(documentXml.match(/<w:sectPr/gu)).toHaveLength(2);
  expect(documentXml.match(/<w:footnotePr>/gu)).toHaveLength(2);
  expect(documentXml).toContain('<w:pos w:val="beneathText"/>');
  expect(documentXml).toContain("w:footnoteReference");
  expect(stylesXml).toContain("standard_business_brief");
  expect(stylesXml).toContain("ReportFootnote");
  expect(footnotesXml).toContain('w:pStyle w:val="ReportFootnote"');
  expect(stylesXml).toContain('w:eastAsia="Source Han Sans"');
  expect(footnotesXml).toContain("REG-A");
  expect(JSON.stringify(report)).not.toContain("apiKey");
});

it("fails quick DOCX export closed when fewer than three verified changes exist", async () => {
  const report = buildQuickCommentary(reviewedReportSession());
  const invalid = {
    ...report,
    sections: report.sections.map((section) =>
      section.key === "top_changes"
        ? { ...section, items: section.items.slice(0, 2) }
        : section,
    ),
  };
  await expect(exportDocx(invalid)).rejects.toThrow(/至少需要 3 项/);
});

it("embeds the required draft watermark without including credentials", async () => {
  const report = buildFullReport(draftReportSession());
  const bytes = new Uint8Array(await (await exportDocx(report)).arrayBuffer());
  const headerXml = unzipText(bytes, "word/header1.xml");
  expect(headerXml).toContain("AI草稿，未经人工复核");
  expect(new TextDecoder().decode(bytes)).not.toContain("session-only-secret");
});
