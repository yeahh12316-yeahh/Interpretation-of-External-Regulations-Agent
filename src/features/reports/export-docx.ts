import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import type { ReportEvidence, ReportItem, ReportModel } from "./report-model";

const BLACK = "111111";
const GREEN = "86BC25";
const MUTED = "555555";
const LIGHT_GRAY = "F2F4F7";
const TABLE_WIDTH = 9360;
const CJK_FONT = "Source Han Sans";

const cjkRunFont = {
  ascii: CJK_FONT,
  cs: CJK_FONT,
  eastAsia: CJK_FONT,
  hAnsi: CJK_FONT,
};

const assertExportable = (report: ReportModel): void => {
  if (!report.authoritativeParsing)
    throw new Error("权威解析未通过，不能导出报告");
  const serialized = JSON.stringify(report);
  if (
    /"(?:apiKey|authorization|endpoint|credential|sessionSecret)"\s*:/iu.test(
      serialized,
    ) ||
    /(?:\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b|Bearer\s+\S+|session[-_ ]?secret)/iu.test(
      serialized,
    )
  )
    throw new Error("报告模型包含不允许导出的凭据字段");
};

const evidenceText = (evidence: ReportEvidence): string => {
  const locator = [
    evidence.page === null ? null : `第${evidence.page}页`,
    evidence.article,
    `第${evidence.paragraphIndex + 1}段`,
  ]
    .filter(Boolean)
    .join(" / ");
  return `${evidence.sourceLabel} | ${evidence.sourceTitle} | ${evidence.sourceId} | ${locator} | ${evidence.quote}`;
};

const itemParagraph = (
  item: ReportItem,
  footnoteIds: readonly number[],
): Paragraph =>
  new Paragraph({
    style: "standard_business_brief",
    numbering: { reference: "report-bullets", level: 0 },
    children: [
      new TextRun({ text: `[${item.claimLabel}] `, bold: true, color: GREEN }),
      new TextRun(item.text),
      ...footnoteIds.map((id) => new FootnoteReferenceRun(id)),
    ],
  });

const metadataLine = (label: string, value: string): Paragraph =>
  new Paragraph({
    style: "standard_business_brief",
    spacing: { after: 40, line: 264, lineRule: "auto" },
    children: [
      new TextRun({ text: `${label}: `, bold: true, color: BLACK }),
      new TextRun({ text: value, color: BLACK }),
    ],
  });

const fixedTable = (
  rows: readonly (readonly string[])[],
  widths: readonly number[],
): Table =>
  new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    indent: { size: 120, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: widths,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    rows: rows.map(
      (row, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex === 0,
          children: row.map(
            (text, cellIndex) =>
              new TableCell({
                width: { size: widths[cellIndex], type: WidthType.DXA },
                shading:
                  rowIndex === 0
                    ? { fill: LIGHT_GRAY, type: ShadingType.CLEAR }
                    : undefined,
                children: [
                  new Paragraph({
                    style: "standard_business_brief",
                    children: [
                      new TextRun({
                        text,
                        bold: rowIndex === 0,
                        color: BLACK,
                      }),
                    ],
                  }),
                ],
              }),
          ),
        }),
    ),
  });

export const exportDocx = async (report: ReportModel): Promise<Blob> => {
  assertExportable(report);
  let nextFootnoteId = 1;
  const footnotes: Record<string, { children: Paragraph[] }> = {};
  const body: Array<Paragraph | Table> = [
    new Paragraph({
      style: "standard_business_brief",
      spacing: { before: 320, after: 80 },
      children: [
        new TextRun({
          text: "外规解读agent",
          bold: true,
          color: GREEN,
          size: 20,
        }),
      ],
    }),
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 80 },
      children: [
        new TextRun({ text: report.title, bold: true, size: 46, color: BLACK }),
      ],
    }),
    new Paragraph({
      spacing: { after: 320 },
      children: [
        new TextRun({ text: report.projectName, size: 28, color: MUTED }),
      ],
    }),
    metadataLine("成果类型", report.title),
    metadataLine("项目版本", report.projectVersion),
    metadataLine("生成时间", report.generatedAt),
    metadataLine("复核状态", report.reviewStatusLabel),
    metadataLine(
      "来源清单",
      report.sources
        .map(({ sourceLabel, title }) => `${sourceLabel}：${title}`)
        .join("；"),
    ),
    new Paragraph({
      border: {
        bottom: { style: BorderStyle.SINGLE, color: GREEN, size: 18, space: 8 },
      },
      spacing: { after: 240 },
    }),
  ];

  for (const section of report.sections) {
    body.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun(section.title)],
      }),
    );
    if (section.items.length === 0) {
      body.push(
        new Paragraph({
          style: "standard_business_brief",
          children: [
            new TextRun({
              text: "本节无可纳入的已验证结论。",
              italics: true,
              color: MUTED,
            }),
          ],
        }),
      );
      continue;
    }
    if (section.key === "evidence_appendix") {
      body.push(
        fixedTable(
          [
            ["结论 ID", "结论类型", "来源与定位"],
            ...section.items.map((item) => [
              item.findingId,
              item.claimLabel,
              item.evidence.map(evidenceText).join("\n"),
            ]),
          ],
          [1440, 1800, 6120],
        ),
      );
      for (const item of section.items) {
        for (const revision of item.revisions) {
          body.push(
            new Paragraph({
              style: "standard_business_brief",
              children: [
                new TextRun({
                  text: `${item.findingId} 修订留痕：`,
                  bold: true,
                }),
                new TextRun(
                  `${revision.reviewer} | ${revision.reviewedAt} | ${revision.reason}`,
                ),
              ],
            }),
          );
        }
      }
      continue;
    }
    for (const item of section.items) {
      const ids = item.evidence.map((evidence) => {
        const id = nextFootnoteId++;
        footnotes[String(id)] = {
          children: [
            new Paragraph({
              style: "standard_business_brief",
              children: [new TextRun(evidenceText(evidence))],
            }),
          ],
        };
        return id;
      });
      body.push(itemParagraph(item, ids));
    }
  }

  const headerChildren = [
    new Paragraph({
      children: [
        new TextRun({ text: "外规解读agent", bold: true, color: BLACK }),
        new TextRun({ text: `  |  ${report.title}`, color: MUTED }),
      ],
    }),
  ];
  if (report.watermark) {
    headerChildren.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 40, after: 40 },
        children: [
          new TextRun({
            text: report.watermark,
            bold: true,
            color: GREEN,
            size: 30,
          }),
        ],
      }),
    );
  }
  const document = new Document({
    title: report.title,
    subject: `${report.projectName} ${report.reviewStatusLabel}`,
    creator: "外规解读agent",
    description: "浏览器本地生成的结构化外规成果",
    styles: {
      default: {
        document: { run: { font: cjkRunFont, size: 22, color: BLACK } },
      },
      paragraphStyles: [
        {
          id: "standard_business_brief",
          name: "standard_business_brief",
          basedOn: "Normal",
          next: "standard_business_brief",
          quickFormat: true,
          run: { font: cjkRunFont, size: 22, color: BLACK },
          paragraph: {
            spacing: { before: 0, after: 120, line: 264, lineRule: "auto" },
          },
        },
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "standard_business_brief",
          quickFormat: true,
          run: { font: cjkRunFont, size: 46, bold: true, color: BLACK },
          paragraph: { spacing: { before: 0, after: 80 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "standard_business_brief",
          quickFormat: true,
          run: { font: cjkRunFont, size: 32, bold: true, color: GREEN },
          paragraph: { spacing: { before: 320, after: 160 }, keepNext: true },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "report-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: 720, hanging: 360 },
                  spacing: { after: 160, line: 280, lineRule: "auto" },
                },
              },
            },
          ],
        },
      ],
    },
    footnotes,
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
              header: 708,
              footer: 708,
            },
          },
        },
        headers: { default: new Header({ children: headerChildren }) },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `${report.projectName}  |  `,
                    color: MUTED,
                  }),
                  new TextRun({ children: [PageNumber.CURRENT], color: MUTED }),
                ],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });
  return Packer.toBlob(document);
};
