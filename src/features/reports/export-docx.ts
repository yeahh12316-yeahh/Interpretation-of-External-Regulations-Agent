import {
  AlignmentType,
  BorderStyle,
  createStringElement,
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
  SectionProperties,
  SectionType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  XmlComponent,
} from "docx";

import {
  impactDimensionTitle,
  reportExportBlockReason,
  type ReportEvidence,
  type ReportItem,
  type ReportModel,
} from "./report-model";

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

class SectionFootnoteProperties extends XmlComponent {
  constructor(position: "beneathText" | "sectEnd") {
    super("w:footnotePr");
    this.addChildElement(createStringElement("w:pos", position));
  }
}

const setNativeFootnotePosition = (
  document: Document,
  position: "beneathText" | "sectEnd",
): void => {
  const body = document.Document.View.Body as unknown as {
    sections?: SectionProperties[];
    root?: unknown[];
  };
  const sectionProperties = new Set<SectionProperties>();
  const visited = new Set<object>();
  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (node instanceof SectionProperties) {
      sectionProperties.add(node);
      return;
    }
    const root = (node as { root?: unknown[] }).root;
    if (Array.isArray(root)) for (const child of root) collect(child);
  };
  collect(body);
  if (Array.isArray(body.sections))
    for (const section of body.sections) collect(section);
  if (sectionProperties.size === 0)
    throw new Error("DOCX 节结构不可用，无法安全设置原生脚注位置");
  for (const section of sectionProperties)
    section.addChildElement(new SectionFootnoteProperties(position));
};

const assertExportable = (report: ReportModel): void => {
  const blocked = reportExportBlockReason(report);
  if (blocked) throw new Error(blocked);
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
      ...(item.dimension
        ? [
            new TextRun({
              text: `【${impactDimensionTitle(item.dimension)}维度】`,
              bold: true,
            }),
          ]
        : []),
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
  const mainBody: Array<Paragraph | Table> = [
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
  const appendixBody: Array<Paragraph | Table> = [];

  for (const section of report.sections) {
    const body =
      section.key === "evidence_appendix" ? appendixBody : mainBody;
    body.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun(section.title)],
      }),
    );
    if (section.groups) {
      for (const group of section.groups) {
        body.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun(`${group.title}维度`)],
          }),
        );
        if (!group.items.length) {
          body.push(
            new Paragraph({
              style: "standard_business_brief",
              children: [
                new TextRun({
                  text: "该维度无可纳入的已验证结论。",
                  italics: true,
                  color: MUTED,
                }),
              ],
            }),
          );
        }
        for (const item of group.items) {
          const ids = item.evidence.map((evidence) => {
            const id = nextFootnoteId++;
            footnotes[String(id)] = {
              children: [
                new Paragraph({
                  style: "ReportFootnote",
                  children: [new TextRun(evidenceText(evidence))],
                }),
              ],
            };
            return id;
          });
          body.push(itemParagraph(item, ids));
        }
      }
      continue;
    }
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
              style: "ReportFootnote",
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
  const makePageProperties = () => ({
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
  });
  const makeHeader = () => new Header({ children: headerChildren });
  const makeFooter = () =>
    new Footer({
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
    });
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
          id: "ReportFootnote",
          name: "Report Footnote",
          basedOn: "Normal",
          next: "ReportFootnote",
          run: { font: cjkRunFont, size: 16, color: MUTED },
          paragraph: {
            spacing: { before: 0, after: 0, line: 200, lineRule: "auto" },
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
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "standard_business_brief",
          quickFormat: true,
          run: { font: cjkRunFont, size: 25, bold: true, color: BLACK },
          paragraph: { spacing: { before: 180, after: 100 }, keepNext: true },
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
        properties: makePageProperties(),
        headers: { default: makeHeader() },
        footers: { default: makeFooter() },
        children: mainBody,
      },
      ...(appendixBody.length
        ? [
            {
              properties: {
                ...makePageProperties(),
                type: SectionType.NEXT_PAGE,
              },
              headers: { default: makeHeader() },
              footers: { default: makeFooter() },
              children: appendixBody,
            },
          ]
        : []),
    ],
  });
  setNativeFootnotePosition(document, "beneathText");
  return Packer.toBlob(document);
};
