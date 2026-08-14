export interface QualityMetrics {
  qualityGatePassed: boolean;
  sourceAnchorCoverage?: number;
  inferenceTraceability?: number;
  requiredReviewCompletion?: number;
}
