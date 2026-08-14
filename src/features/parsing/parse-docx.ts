import * as mammoth from "mammoth";

import type { SourceType } from "../../domain/source";
import { articleFromText, type ParsedSourceUnit } from "./build-anchors";

const abortError = (): DOMException =>
  new DOMException("文件处理已取消", "AbortError");

export async function parseDocx(
  bytes: ArrayBuffer,
  sourceId: string,
  sourceType: SourceType,
  signal: AbortSignal,
): Promise<ParsedSourceUnit[]> {
  if (signal.aborted) throw abortError();

  let rawText: string;
  try {
    // Mammoth's browser entry consumes `arrayBuffer`; its SSR test entry names the
    // same in-memory value `buffer`. Supplying both keeps parsing local in either runtime.
    const input = { arrayBuffer: bytes, buffer: bytes } as Parameters<
      typeof mammoth.extractRawText
    >[0] & { buffer: ArrayBuffer };
    const result = await mammoth.extractRawText(input);
    rawText = result.value;
  } catch {
    throw new Error("DOCX 文本提取失败");
  }
  if (signal.aborted) throw abortError();

  return rawText
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, paragraphIndex) => ({
      sourceId,
      sourceType,
      page: null,
      article: articleFromText(paragraph),
      paragraphIndex,
      text: paragraph,
      extractionMethod: "docx_xml",
      confidence: 1,
    }));
}
