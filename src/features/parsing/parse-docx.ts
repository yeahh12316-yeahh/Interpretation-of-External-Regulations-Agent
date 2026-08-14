import * as mammoth from "mammoth";

import type { SourceType } from "../../domain/source";
import { isAbortError, raceWithAbort, throwIfAborted } from "../../lib/abort";
import { articleFromText, type ParsedSourceUnit } from "./build-anchors";

type MammothInput = Parameters<typeof mammoth.extractRawText>[0] & {
  buffer: ArrayBuffer;
};
type MammothResult = Awaited<ReturnType<typeof mammoth.extractRawText>>;
export type DocxTextExtractor = (input: MammothInput) => Promise<MammothResult>;

export async function parseDocx(
  bytes: ArrayBuffer,
  sourceId: string,
  sourceType: SourceType,
  signal: AbortSignal,
  extractRawText: DocxTextExtractor = mammoth.extractRawText,
): Promise<ParsedSourceUnit[]> {
  throwIfAborted(signal);

  let rawText: string;
  try {
    // Mammoth's browser entry consumes `arrayBuffer`; its SSR test entry names the
    // same in-memory value `buffer`. Supplying both keeps parsing local in either runtime.
    const input = { arrayBuffer: bytes, buffer: bytes } as MammothInput;
    const result = await raceWithAbort(extractRawText(input), signal);
    rawText = result.value;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error("DOCX 文本提取失败");
  }

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
