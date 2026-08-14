export interface QualityMetrics {
  factCitationCoverage: number;
  citationReverseCheckRate: number;
  unsupportedFindingCount: number;
  inferenceMarkingRate: number;
  requiredReviewCompletionRate: number;
}

export const hasPassedQualityGate = (metrics: QualityMetrics) =>
  metrics.factCitationCoverage === 1 &&
  metrics.citationReverseCheckRate === 1 &&
  metrics.unsupportedFindingCount === 0 &&
  metrics.inferenceMarkingRate === 1 &&
  metrics.requiredReviewCompletionRate === 1;
