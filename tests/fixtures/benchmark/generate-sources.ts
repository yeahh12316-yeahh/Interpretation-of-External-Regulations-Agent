import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Document, Packer, Paragraph, Table, TableCell, TableRow } from "docx";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(benchmarkRoot, "sources");
await mkdir(sourceRoot, { recursive: true });

const normalizeZipTimestamps = (input: Buffer): Buffer => {
  const bytes = Buffer.from(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 16; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      view.setUint16(offset + 10, 0, true);
      view.setUint16(offset + 12, 0x582e, true);
    } else if (signature === 0x02014b50) {
      view.setUint16(offset + 12, 0, true);
      view.setUint16(offset + 14, 0x582e, true);
    }
  }
  return bytes;
};

const finishPdf = (objects: readonly string[], catalogId = 1): Buffer => {
  let pdf = "%PDF-1.7\n% synthetic benchmark fixture\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n\r\n`)
    .join("");
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
};

const buildTextPdf = (pages: readonly (readonly string[])[]): Buffer => {
  const characters = [...new Set(pages.flat().join(""))];
  const cidByCharacter = new Map(
    characters.map((character, index) => [character, index + 1]),
  );
  const hex = (value: number, width: number) =>
    value.toString(16).toUpperCase().padStart(width, "0");
  const utf16Hex = (character: string) =>
    Array.from(character)
      .map((unit) => hex(unit.charCodeAt(0), 4))
      .join("");
  const encodedText = (text: string) =>
    [...text]
      .map((character) => hex(cidByCharacter.get(character) ?? 0, 4))
      .join("");
  const objects: string[] = ["", ""];
  const pageIds: number[] = [];
  for (const paragraphs of pages) {
    const content = [
      "BT",
      "/F1 12 Tf",
      "72 720 Td",
      ...paragraphs.flatMap((paragraph, index) => [
        `<${encodedText(paragraph)}> Tj`,
        ...(index < paragraphs.length - 1 ? ["0 -30 Td"] : []),
      ]),
      "ET",
    ].join("\n");
    const contentId = objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
    const pageId = objects.push("");
    pageIds.push(pageId);
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${pages.length * 2 + 3} 0 R >> >> /Contents ${contentId} 0 R >>`;
  }
  const fontId = objects.push(
    `<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticRegulation /Encoding /Identity-H ` +
      `/DescendantFonts [${pages.length * 2 + 4} 0 R] /ToUnicode ${pages.length * 2 + 5} 0 R >>`,
  );
  const descendantId = objects.push(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticRegulation ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${pages.length * 2 + 6} 0 R /DW 1000 /CIDToGIDMap /Identity >>`,
  );
  const toUnicode = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Synthetic-Regulation def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${characters.length} beginbfchar`,
    ...characters.map(
      (character) =>
        `<${hex(cidByCharacter.get(character) ?? 0, 4)}> <${utf16Hex(character)}>`,
    ),
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const toUnicodeId = objects.push(
    `<< /Length ${Buffer.byteLength(toUnicode)} >>\nstream\n${toUnicode}\nendstream`,
  );
  const descriptorId = objects.push(
    "<< /Type /FontDescriptor /FontName /SyntheticRegulation /Flags 4 /FontBBox [0 -200 1000 900] " +
      "/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
  );
  if (
    [fontId, descendantId, toUnicodeId, descriptorId].join(",") !==
    [
      pages.length * 2 + 3,
      pages.length * 2 + 4,
      pages.length * 2 + 5,
      pages.length * 2 + 6,
    ].join(",")
  )
    throw new Error("unexpected text PDF object numbering");
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] ` +
    `/Count ${pageIds.length} >>`;
  return finishPdf(objects);
};

const buildScannedPdf = (): Buffer => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB " +
      "/BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n335577>\nendstream",
  ];
  const pageIds: number[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const content =
      page === 3 ? "q\n420 0 0 120 72 620 cm\n/Im1 Do\nQ" : "";
    const contentId = objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
    const resources =
      page === 3 ? "/Resources << /XObject << /Im1 3 0 R >> >> " : "";
    const pageId = objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${resources}/Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] ` +
    `/Count ${pageIds.length} >>`;
  return finishPdf(objects);
};

const textPdf = buildTextPdf([
  ["合成监管文件目录。"],
  [
    "第十条 本办法自二〇二六年一月一日起施行。",
    "第十一条 过渡期截至二〇二六年六月三十日。",
  ],
]);
const scannedPdf = buildScannedPdf();
await Promise.all([
  writeFile(path.join(sourceRoot, "regulatory-text.pdf"), textPdf),
  writeFile(path.join(sourceRoot, "regulatory-scan.pdf"), scannedPdf),
]);

const nativeDate = globalThis.Date;
const fixedMilliseconds = nativeDate.parse("2026-08-14T00:00:00.000Z");
class FixedDate extends nativeDate {
  constructor(value?: string | number | Date) {
    super(value === undefined ? fixedMilliseconds : value);
  }

  static override now(): number {
    return fixedMilliseconds;
  }
}
globalThis.Date = FixedDate as DateConstructor;
let tableBytes: Buffer;
try {
  const tableDocument = new Document({
    creator: "Synthetic Benchmark Generator",
    lastModifiedBy: "Synthetic Benchmark Generator",
    sections: [
      {
        children: [
          new Paragraph("合成监管要求表"),
          new Paragraph("第二条 示例机构不得虚构业务记录。"),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("事项")] }),
                  new TableCell({ children: [new Paragraph("合成要求")] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("报告")] }),
                  new TableCell({
                    children: [new Paragraph("每季度提交合成风险报告")],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph("以上均为合成条款，不代表真实机构或项目。"),
        ],
      },
    ],
  });
  tableBytes = normalizeZipTimestamps(await Packer.toBuffer(tableDocument));
} finally {
  globalThis.Date = nativeDate;
}

await writeFile(path.join(sourceRoot, "regulatory-table.docx"), tableBytes);

const longClause =
  "合成长文件条款：示例机构应当保存合成记录，并于二〇二六年一月一日前完成校验。\n";
await writeFile(
  path.join(sourceRoot, "regulatory-long.txt"),
  `第一条 示例机构必须建立治理机制。\n${longClause.repeat(
    Math.ceil(24_000 / [...longClause].length) + 1,
  )}`,
  "utf8",
);
await writeFile(
  path.join(sourceRoot, "regulatory-attachment.txt"),
  "合成附件：字段A、字段B、字段C。仅用于脱敏回归测试。\n",
  "utf8",
);
await writeFile(
  path.join(sourceRoot, "official-interpretation.txt"),
  "官方说明建议按年度核验。\n本材料仅为合成解读，不指向真实机构。\n",
  "utf8",
);
const scanDigest = createHash("sha256").update(scannedPdf).digest("hex");
await writeFile(
  path.join(sourceRoot, "regulatory-scan.ground-truth.json"),
  `${JSON.stringify(
    {
      sourceId: "SYNTH-REG-SCAN",
      scanFileSha256: scanDigest,
      pages: [
        {
          page: 3,
          paragraphs: [
            {
              paragraphIndex: 0,
              article: "第三条",
              text: "第三条 示例机构必须每年报送合成报告。",
            },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
