import type { SourceAnchor, SourceType } from "../../domain/source";

export type ExtractionMethod = "text_layer" | "docx_xml" | "plain_text";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedSourceUnit {
  sourceId: string;
  sourceType: SourceType;
  page: number | null;
  article: string | null;
  paragraphIndex: number;
  text: string;
  extractionMethod: ExtractionMethod;
  confidence: number;
  boundingBox?: BoundingBox;
}

const ARTICLE_PATTERN = /第[〇零一二三四五六七八九十百千万两\d]+条/;

export const articleFromText = (text: string): string | null =>
  text.match(ARTICLE_PATTERN)?.[0] ?? null;

export function buildAnchors(
  units: readonly ParsedSourceUnit[],
): SourceAnchor[] {
  const articleBySource = new Map<string, string>();

  return units.flatMap((unit) => {
    const detectedArticle = unit.article ?? articleFromText(unit.text);
    if (detectedArticle) articleBySource.set(unit.sourceId, detectedArticle);
    if (!unit.text.trim()) return [];

    return [
      {
        sourceId: unit.sourceId,
        sourceType: unit.sourceType,
        page: unit.page,
        article: detectedArticle ?? articleBySource.get(unit.sourceId) ?? null,
        paragraphIndex: unit.paragraphIndex,
        quote: unit.text,
      },
    ];
  });
}
