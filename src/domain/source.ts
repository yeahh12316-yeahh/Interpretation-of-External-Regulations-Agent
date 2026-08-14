export type SourceType = 'regulatory_text' | 'official_interpretation';

export interface SourceUnit {
  sourceId: string;
  sourceType: SourceType;
  title: string;
  content: string;
}

export interface SourceAnchor {
  sourceId: string;
  sourceType: SourceType;
  page: number | null;
  article: string | null;
  paragraphIndex: number;
  quote: string;
}
