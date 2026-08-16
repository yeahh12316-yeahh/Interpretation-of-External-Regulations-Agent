const finishPdf = (objects) => {
  const chunks = [
    Buffer.from("%PDF-1.7\n% synthetic production smoke\n", "binary"),
  ];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "binary"),
      Buffer.isBuffer(body) ? body : Buffer.from(body, "binary"),
      Buffer.from("\nendobj\n", "binary"),
    ]);
    chunks.push(object);
    length += object.length;
  });
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f\r\n",
    ...offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n\r\n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "binary"));
  return Buffer.concat(chunks);
};

const hex = (value, width) =>
  value.toString(16).toUpperCase().padStart(width, "0");

export const buildTextLayerPdf = (paragraphs) => {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0)
    throw new Error("text PDF requires at least one paragraph");
  const characters = [...new Set(paragraphs.join(""))];
  const cidByCharacter = new Map(
    characters.map((character, index) => [character, index + 1]),
  );
  const encodedText = (text) =>
    [...text]
      .map((character) => hex(cidByCharacter.get(character) ?? 0, 4))
      .join("");
  const toUnicode = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Synthetic-Smoke def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${characters.length} beginbfchar`,
    ...characters.map(
      (character) =>
        `<${hex(cidByCharacter.get(character) ?? 0, 4)}> <${[...character]
          .map((unit) => hex(unit.charCodeAt(0), 4))
          .join("")}>`,
    ),
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const content = [
    "BT",
    "/F1 12 Tf",
    "50 760 Td",
    ...paragraphs.flatMap((paragraph, index) => [
      `<${encodedText(paragraph)}> Tj`,
      ...(index < paragraphs.length - 1 ? ["0 -32 Td"] : []),
    ]),
    "ET",
  ].join("\n");
  return finishPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 3 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticSmoke /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticSmoke /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>",
    `<< /Length ${Buffer.byteLength(toUnicode)} >>\nstream\n${toUnicode}\nendstream`,
    "<< /Type /FontDescriptor /FontName /SyntheticSmoke /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
  ]);
};

export const buildJpegScanPdf = (jpeg, width, height) => {
  if (!Buffer.isBuffer(jpeg) || jpeg.length < 4)
    throw new Error("scan PDF requires JPEG bytes");
  if (
    !Number.isInteger(width) ||
    width < 100 ||
    !Number.isInteger(height) ||
    height < 100
  )
    throw new Error("scan PDF requires meaningful image dimensions");
  const image = Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      "binary",
    ),
    jpeg,
    Buffer.from("\nendstream", "binary"),
  ]);
  const draw = `q\n595 0 0 347 0 247 cm\n/Im0 Do\nQ`;
  return finishPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    image,
    `<< /Length ${Buffer.byteLength(draw)} >>\nstream\n${draw}\nendstream`,
  ]);
};
