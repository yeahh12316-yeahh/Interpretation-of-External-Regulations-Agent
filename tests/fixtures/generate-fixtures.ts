import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Document, Packer, Paragraph } from "docx";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

const docx = new Document({
  sections: [
    {
      children: [
        new Paragraph("合成官方解读"),
        new Paragraph("第一条 商业银行应当建立覆盖全部业务的风险管理制度。"),
        new Paragraph("本解读仅用于合成测试，不代表任何真实机构或项目。"),
      ],
    },
  ],
});

await writeFile(
  resolve(fixtureDirectory, "regulation.docx"),
  await Packer.toBuffer(docx),
);

const pages = [
  "第一条 商业银行应当建立覆盖全部业务的风险管理制度。",
  "第二条 商业银行应当定期开展风险评估。",
];

const characters = [...new Set(pages.join(""))];
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

const objects: string[] = [];
const addObject = (body: string) => {
  objects.push(body);
  return objects.length;
};

const catalogId = addObject("");
const pagesId = addObject("");
const pageIds: number[] = [];
for (const pageText of pages) {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n<${encodedText(pageText)}> Tj\nET`;
  const contentId = addObject(
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  );
  const pageId = addObject("");
  pageIds.push(pageId);
  objects[pageId - 1] =
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] ` +
    `/Resources << /Font << /F1 7 0 R >> >> /Contents ${contentId} 0 R >>`;
}
const fontId = addObject(
  "<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticRegulation /Encoding /Identity-H " +
    "/DescendantFonts [8 0 R] /ToUnicode 9 0 R >>",
);
const descendantId = addObject(
  "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticRegulation " +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> " +
    "/FontDescriptor 10 0 R /DW 1000 /CIDToGIDMap /Identity >>",
);
const toUnicodeId = addObject(
  `<< /Length ${Buffer.byteLength(toUnicode)} >>\nstream\n${toUnicode}\nendstream`,
);
const fontDescriptorId = addObject(
  "<< /Type /FontDescriptor /FontName /SyntheticRegulation /Flags 4 /FontBBox [0 -200 1000 900] " +
    "/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
);

if (
  fontId !== 7 ||
  descendantId !== 8 ||
  toUnicodeId !== 9 ||
  fontDescriptorId !== 10
) {
  throw new Error("Unexpected synthetic PDF object numbering");
}

objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
objects[pagesId - 1] =
  `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] ` +
  `/Count ${pageIds.length} >>`;

let pdf = "%PDF-1.7\n% synthetic fixture\n";
const offsets = [0];
for (const [index, body] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
}
const xrefOffset = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += "0000000000 65535 f\r\n";
for (const offset of offsets.slice(1)) {
  pdf += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
}
pdf +=
  `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n` +
  `startxref\n${xrefOffset}\n%%EOF\n`;

await writeFile(
  resolve(fixtureDirectory, "text-regulation.pdf"),
  Buffer.from(pdf, "binary"),
);
