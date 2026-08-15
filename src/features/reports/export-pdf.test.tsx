import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { buildQuickCommentary } from "./build-quick-commentary";
import { exportPdf } from "./export-pdf";
import { draftReportSession } from "./__test__/report-fixture";
import { reviewedReportSession } from "./__test__/report-fixture";

it("exports a real searchable PDF from the same ReportModel with Chinese title and watermark", async () => {
  const report = buildQuickCommentary(draftReportSession(), {
    generatedAt: "2026-08-16T03:00:00.000Z",
  });
  const blob = await exportPdf(report);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  expect(blob.type).toBe("application/pdf");
  expect(report.title).toBe("新规快评");
  expect(report.watermark).toBe("AI草稿，未经人工复核");
  const document = await getDocument({ data: bytes }).promise;
  const extracted: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    extracted.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(""),
    );
  }
  expect(extracted.join("\n")).toContain("新规快评");
  expect(extracted.join("\n")).toContain("AI草稿，未经人工复核");
});

it("fails quick PDF export closed when fewer than three verified changes exist", async () => {
  const report = buildQuickCommentary(reviewedReportSession());
  const invalid = {
    ...report,
    sections: report.sections.map((section) =>
      section.key === "top_changes"
        ? { ...section, items: section.items.slice(0, 2) }
        : section,
    ),
  };
  await expect(exportPdf(invalid)).rejects.toThrow(/至少需要 3 项/);
});
