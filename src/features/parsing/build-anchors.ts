import type { SourceAnchor, SourceType } from "../../domain/source";

export type ExtractionMethod = "text_layer" | "docx_xml" | "plain_text" | "ocr";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedSourceUnit {
  unitId?: string;
  sourceId: string;
  sourceType: SourceType;
  page: number | null;
  article: string | null;
  paragraphIndex: number;
  text: string;
  extractionMethod: ExtractionMethod;
  confidence: number;
  boundingBox?: BoundingBox;
  originalOcrText?: string;
  correctedText?: string | null;
  reviewStatus?: "unreviewed" | "corrected";
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  correctionHistory?: Array<{
    correctedText: string;
    reviewedBy: string;
    reviewedAt: string;
  }>;
  ocrRegions?: Array<{
    text: string;
    confidence: number;
    boundingBox: BoundingBox;
    lowConfidence: boolean;
  }>;
  lowConfidenceCharacters?: Array<{
    text: string;
    confidence: number;
    boundingBox: BoundingBox;
  }>;
}

const ARTICLE_PATTERN = /第[〇零一二三四五六七八九十百千万两\d]+条/;

export const articleFromText = (text: string): string | null =>
  text.match(ARTICLE_PATTERN)?.[0] ?? null;

export function canonicalArticlesForUnits(
  units: readonly ParsedSourceUnit[],
): Array<string | null> {
  const articleBySource = new Map<string, string>();
  return units.map((unit) => {
    const detectedArticle = articleFromText(unit.text);
    if (detectedArticle) articleBySource.set(unit.sourceId, detectedArticle);
    return detectedArticle ?? articleBySource.get(unit.sourceId) ?? null;
  });
}

export function buildAnchors(
  units: readonly ParsedSourceUnit[],
): SourceAnchor[] {
  const canonicalArticles = canonicalArticlesForUnits(units);

  return units.flatMap((unit, index) => {
    if (!unit.text.trim()) return [];

    return [
      {
        sourceId: unit.sourceId,
        sourceType: unit.sourceType,
        page: unit.page,
        article: canonicalArticles[index],
        paragraphIndex: unit.paragraphIndex,
        quote: unit.text,
      },
    ];
  });
}
