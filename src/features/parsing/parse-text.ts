import type { SourceType } from "../../domain/source";
import { articleFromText, type ParsedSourceUnit } from "./build-anchors";

const abortError = (): DOMException =>
  new DOMException("文件处理已取消", "AbortError");

const decodeUtf16BigEndian = (bytes: Uint8Array): string => {
  const swapped = new Uint8Array(bytes.length);
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
};

export const decodeText = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: true }).decode(
      bytes.subarray(2),
    );
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16BigEndian(bytes.subarray(2));
  }
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
};

const paragraphsOf = (text: string): string[] =>
  text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n|\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

export function parseText(
  bytes: ArrayBuffer,
  sourceId: string,
  sourceType: SourceType,
  signal: AbortSignal,
): ParsedSourceUnit[] {
  if (signal.aborted) throw abortError();
  let text: string;
  try {
    text = decodeText(new Uint8Array(bytes));
  } catch {
    throw new Error("TXT 文件编码无法识别");
  }

  if (signal.aborted) throw abortError();
  return paragraphsOf(text).map((paragraph, paragraphIndex) => ({
    sourceId,
    sourceType,
    page: null,
    article: articleFromText(paragraph),
    paragraphIndex,
    text: paragraph,
    extractionMethod: "plain_text",
    confidence: 1,
  }));
}
