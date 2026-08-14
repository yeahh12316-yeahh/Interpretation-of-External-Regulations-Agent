import type { SourceAnchor } from './source';

export type ClaimType =
  | 'regulatory_fact'
  | 'official_explanation'
  | 'ai_inference'
  | 'pending_confirmation'
  | 'human_judgment';

export type ReviewStatus = 'unreviewed' | 'confirmed' | 'modified' | 'deleted';

export interface RevisionRecord {
  revisedBy: string;
  revisedAt: string;
  changeSummary: string;
}

export interface Finding {
  findingId: string;
  category: string;
  statement: string;
  claimType: ClaimType;
  sourceAnchors: SourceAnchor[];
  inferenceParents: string[];
  reviewStatus: ReviewStatus;
  requiredReview: boolean;
  revisionRecords: RevisionRecord[];
}
