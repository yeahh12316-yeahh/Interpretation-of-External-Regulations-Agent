import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Document, Packer, Paragraph, Table, TableCell, TableRow } from "docx";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.dirname(benchmarkRoot);
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

await Promise.all([
  copyFile(
    path.join(fixtureRoot, "text-regulation.pdf"),
    path.join(sourceRoot, "regulatory-text.pdf"),
  ),
  copyFile(
    path.join(fixtureRoot, "scanned-regulation.pdf"),
    path.join(sourceRoot, "regulatory-scan.pdf"),
  ),
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
  longClause.repeat(Math.ceil(24_000 / [...longClause].length) + 1),
  "utf8",
);
await writeFile(
  path.join(sourceRoot, "regulatory-attachment.txt"),
  "合成附件：字段A、字段B、字段C。仅用于脱敏回归测试。\n",
  "utf8",
);
await writeFile(
  path.join(sourceRoot, "official-interpretation.txt"),
  "合成官方解读：第二条所称定期是指每季度一次。本材料不指向真实机构。\n",
  "utf8",
);
