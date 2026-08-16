import { expect, test } from "../../playwright-fixtures";

import {
  assertReportStructure,
  QUICK_REPORT_HEADINGS,
  type DownloadedReport,
} from "./support/production-flow";

const paragraph = (text: string, kind: "heading" | "item") =>
  `<w:p><w:pPr>${
    kind === "heading"
      ? '<w:pStyle w:val="Heading1"/>'
      : "<w:numPr><w:ilvl w:val=\"0\"/></w:numPr>"
  }</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

const docxReport = (count: number): DownloadedReport => {
  const xml = `<w:document><w:body>${QUICK_REPORT_HEADINGS.map((heading) =>
    `${paragraph(heading, "heading")}${
      heading === "最值得关注的三至五项变化"
        ? Array.from({ length: count }, (_, index) =>
            paragraph(`合成变化 ${index + 1}`, "item"),
          ).join("")
        : ""
    }`,
  ).join("")}</w:body></w:document>`;
  return {
    bytes: Buffer.from("PK"),
    text: QUICK_REPORT_HEADINGS.join("\n"),
    archiveEntries: new Map([["word/document.xml", Buffer.from(xml)]]),
  };
};

const pdfReport = (count: number): DownloadedReport => ({
  bytes: Buffer.from("%PDF-"),
  text: QUICK_REPORT_HEADINGS.map((heading) =>
    heading === "最值得关注的三至五项变化"
      ? `${heading}\n${Array.from({ length: count }, (_, index) => `• 监管事实 ｜ F${index + 1}\n合成变化`).join("\n")}`
      : heading,
  ).join("\n"),
  archiveEntries: null,
});

test("quick report verifier rejects two-item and unmarked bags, and accepts four structural items", async () => {
  expect(() => assertReportStructure(docxReport(2), "quick")).toThrow();
  expect(() => assertReportStructure(pdfReport(2), "quick")).toThrow();
  expect(() =>
    assertReportStructure(
      { ...pdfReport(4), text: pdfReport(4).text.replaceAll("• ", "") },
      "quick",
    ),
  ).toThrow();
  expect(() => assertReportStructure(docxReport(4), "quick")).not.toThrow();
  expect(() => assertReportStructure(pdfReport(4), "quick")).not.toThrow();
});
