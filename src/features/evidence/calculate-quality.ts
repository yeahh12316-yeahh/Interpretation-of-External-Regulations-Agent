import type { Finding } from "../../domain/finding";
import type { Project } from "../../domain/project";
import {
  hasPassedQualityGate,
  type QualityMetrics,
} from "../../domain/quality";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import { createSourceIndex, validateFinding } from "./validate-finding";

/** Task 9 can pass this session boundary without expanding the strict Project schema. */
export interface AnalysisEvidenceSession {
  project: Project;
  parsedUnits: readonly ParsedSourceUnit[];
}

const ratio = (
  numerator: number,
  denominator: number,
  emptyValue: number,
): number => (denominator === 0 ? emptyValue : numerator / denominator);

const isReviewed = (finding: Finding): boolean =>
  finding.reviewStatus === "confirmed" ||
  finding.reviewStatus === "modified" ||
  (finding.reviewStatus === "deleted" && finding.revisionRecords.length > 0);

const isEvidenceFinding = (finding: Finding): boolean =>
  finding.claimType === "regulatory_fact" ||
  finding.claimType === "official_explanation" ||
  finding.claimType === "ai_inference";

const hasCitation = (finding: Finding, project: Project): boolean => {
  if (finding.sourceAnchors.length === 0) return false;
  const sourceById = new Map(
    project.sourceUnits.map((source) => [source.sourceId, source]),
  );
  return finding.sourceAnchors.every((anchor) => {
    const source = sourceById.get(anchor.sourceId);
    if (!source || source.sourceType !== anchor.sourceType) return false;
    if (finding.claimType === "regulatory_fact") {
      return anchor.sourceType === "regulatory_text";
    }
    if (finding.claimType === "official_explanation") {
      return anchor.sourceType === "official_interpretation";
    }
    return true;
  });
};

const failedSupportRules = new Set([
  "source_id",
  "source_type",
  "locator_page",
  "locator_paragraph",
  "locator_article",
  "quote_match",
  "modal_strength",
  "dates",
  "numbers",
  "inference_parent",
]);

export function calculateQuality(
  project: Project,
  parsedUnits?: readonly ParsedSourceUnit[],
): QualityMetrics {
  const activeFindings = project.findings.filter(
    (finding) => finding.reviewStatus !== "deleted",
  );
  const facts = activeFindings.filter(
    (finding) =>
      finding.claimType === "regulatory_fact" ||
      finding.claimType === "official_explanation",
  );
  const evidenceFindings = activeFindings.filter(isEvidenceFinding);
  const index = createSourceIndex({
    sources: project.sourceUnits,
    parsedUnits: parsedUnits ?? [],
    findings: activeFindings,
  });
  const validations = new Map(
    evidenceFindings.map((finding) => [
      finding.findingId,
      validateFinding(finding, index),
    ]),
  );
  const reversePassed = evidenceFindings.filter((finding) =>
    validations.get(finding.findingId)?.every(({ passed }) => passed),
  ).length;
  const unsupportedFindingCount = activeFindings.filter((finding) => {
    if (finding.claimType === "pending_confirmation") return true;
    if (!isEvidenceFinding(finding)) return false;
    if (!hasCitation(finding, project)) return true;
    return validations
      .get(finding.findingId)
      ?.some(({ rule, passed }) => failedSupportRules.has(rule) && !passed);
  }).length;

  const inferenceCandidates = activeFindings.filter(
    (finding) =>
      finding.claimType === "ai_inference" ||
      finding.category.startsWith("institution_impact:"),
  );
  const markedInferences = inferenceCandidates.filter(
    (finding) =>
      finding.claimType === "ai_inference" &&
      validations
        .get(finding.findingId)
        ?.find(({ rule }) => rule === "inference_parent")?.passed,
  ).length;
  const requiredReviews = project.findings.filter(
    ({ requiredReview }) => requiredReview,
  );

  return {
    factCitationCoverage: ratio(
      facts.filter((finding) => hasCitation(finding, project)).length,
      facts.length,
      0,
    ),
    citationReverseCheckRate: ratio(reversePassed, evidenceFindings.length, 0),
    unsupportedFindingCount,
    inferenceMarkingRate: ratio(
      markedInferences,
      inferenceCandidates.length,
      1,
    ),
    requiredReviewCompletionRate: ratio(
      requiredReviews.filter(isReviewed).length,
      requiredReviews.length,
      1,
    ),
  };
}

const parsingEvidenceComplete = (
  project: Project,
  parsedUnits: readonly ParsedSourceUnit[] | undefined,
): boolean => {
  if (!project.parsingCompleted || !parsedUnits || parsedUnits.length === 0)
    return false;
  const sourceById = new Map(
    project.sourceUnits.map((source) => [source.sourceId, source]),
  );
  if (
    project.sourceUnits.length === 0 ||
    !project.sourceUnits.some(
      ({ sourceType }) => sourceType === "regulatory_text",
    )
  ) {
    return false;
  }
  if (
    project.sourceUnits.some(
      (source) =>
        !source.content.trim() ||
        !parsedUnits.some(
          (unit) =>
            unit.sourceId === source.sourceId &&
            unit.sourceType === source.sourceType &&
            unit.text.trim(),
        ),
    )
  ) {
    return false;
  }
  return parsedUnits.every((unit) => {
    const source = sourceById.get(unit.sourceId);
    if (
      !source ||
      source.sourceType !== unit.sourceType ||
      !unit.text.trim() ||
      !Number.isFinite(unit.confidence) ||
      unit.confidence <= 0
    ) {
      return false;
    }
    const unresolvedOcr =
      unit.extractionMethod === "ocr" &&
      (unit.lowConfidenceCharacters?.length ?? 0) > 0 &&
      unit.reviewStatus !== "corrected";
    return !unresolvedOcr;
  });
};

export function canFinalize(
  project: Project,
  parsedUnits?: readonly ParsedSourceUnit[],
): boolean {
  if (!parsingEvidenceComplete(project, parsedUnits)) return false;
  const activeFindings = project.findings.filter(
    ({ reviewStatus }) => reviewStatus !== "deleted",
  );
  if (activeFindings.length === 0) return false;
  return hasPassedQualityGate(calculateQuality(project, parsedUnits));
}
