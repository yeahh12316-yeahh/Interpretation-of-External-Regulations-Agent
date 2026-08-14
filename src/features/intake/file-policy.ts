export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

export type SupportedDocumentKind = "pdf" | "docx" | "txt";

export interface FilePolicyOptions {
  maxBytes?: number;
}

const MIME_TYPES: Record<SupportedDocumentKind, ReadonlySet<string>> = {
  pdf: new Set(["application/pdf"]),
  docx: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  txt: new Set(["text/plain"]),
};

const extensionOf = (fileName: string): string =>
  fileName.toLocaleLowerCase().split(".").pop() ?? "";

export const documentKind = (file: File): SupportedDocumentKind | null => {
  const extension = extensionOf(file.name);
  if (extension !== "pdf" && extension !== "docx" && extension !== "txt")
    return null;
  if (
    file.type &&
    file.type !== "application/octet-stream" &&
    !MIME_TYPES[extension].has(file.type)
  ) {
    return null;
  }
  return extension;
};

const beginsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((value, index) => bytes[index] === value);

export async function validateFile(
  file: File,
  options: FilePolicyOptions = {},
): Promise<SupportedDocumentKind> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (file.size === 0) throw new Error("不能上传空文件");
  if (file.size > maxBytes) throw new Error("文件超过大小上限");

  const kind = documentKind(file);
  if (!kind) throw new Error("仅支持 PDF、DOCX 或 TXT 文件");

  if (kind === "pdf" || kind === "docx") {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new Error("无法读取文件");
    }

    if (kind === "pdf") {
      const searchableHeader = new TextDecoder("latin1").decode(bytes);
      if (/\/Encrypt\b/.test(searchableHeader))
        throw new Error("不支持加密 PDF 文件");
    } else if (beginsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
      throw new Error("不支持加密 DOCX 文件");
    }
  }

  return kind;
}
