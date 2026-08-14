import type { Finding } from "../../domain/finding";
import type { Project } from "../../domain/project";
import type { SourceType } from "../../domain/source";
import {
  hasPassedQualityGate,
  type QualityMetrics,
} from "../../domain/quality";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import type { ParseResult } from "../parsing/parse-document";
import {
  createSourceIndex,
  type OfficialPrimarySourceIds,
  validateFinding,
} from "./validate-finding";

export interface SourceParseOutcome {
  sourceId: string;
  sourceType: SourceType;
  pageCount: number | null;
  successfulPages: readonly number[];
  failedPages: readonly { page: number; error: string }[];
  ocrFailedPages: readonly number[];
  finalizationBlocked: boolean;
  extractionCoverage: number;
}

/** Task 9 can pass this session boundary without expanding the strict Project schema. */
export interface AnalysisEvidenceSession {
  project: Project;
  parsedUnits: readonly ParsedSourceUnit[];
  parseOutcomes: readonly SourceParseOutcome[];
  officialPrimarySourceIds?: OfficialPrimarySourceIds;
}

export const parseOutcomeFromResult = (
  result: ParseResult,
): SourceParseOutcome => ({
  sourceId: result.source.sourceId,
  sourceType: result.source.sourceType,
  pageCount: result.pageCount,
  successfulPages: result.successfulPages,
  failedPages: result.failedPages,
  ocrFailedPages: result.quality.ocrFailedPages,
  finalizationBlocked: result.quality.finalizationBlocked,
  extractionCoverage: result.quality.extractionCoverage,
});

const ratio = (
  numerator: number,
  denominator: number,
  emptyValue: number,
): number => (denominator === 0 ? emptyValue : numerator / denominator);

const isValidRevisionRecord = (
  revision: Finding["revisionRecords"][number],
): boolean =>
  revision.revisedBy.trim().length > 0 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
    revision.revisedAt,
  ) &&
  !Number.isNaN(Date.parse(revision.revisedAt)) &&
  revision.changeSummary.trim().length > 0;

const describesModification = (changeSummary: string): boolean => {
  const summary = changeSummary.trim();
  const hasBefore = /(?:原|修改前|变更前|before)/i.test(summary);
  const hasAfter = /(?:改为|修改后|变更后|after)/i.test(summary);
  const hasChange = /(?:修改|变更|调整|修订|改为)/.test(summary);
  const hasReason = /(?:原因|理由|依据|reason)/i.test(summary);
  return hasBefore && hasAfter && hasChange && hasReason;
};

const hasValidRevisionHistory = (finding: Finding): boolean =>
  finding.revisionRecords.length > 0 &&
  finding.revisionRecords.every(isValidRevisionRecord);

const isReviewed = (finding: Finding): boolean => {
  if (finding.reviewStatus === "confirmed") return true;
  if (!hasValidRevisionHistory(finding)) return false;
  if (finding.reviewStatus === "modified") {
    return finding.revisionRecords.some(({ changeSummary }) =>
      describesModification(changeSummary),
    );
  }
  return finding.reviewStatus === "deleted";
};

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
  parseOutcomes?: readonly SourceParseOutcome[],
  officialPrimarySourceIds?: OfficialPrimarySourceIds,
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
    officialPrimarySourceIds,
  });
  const validations = new Map(
    evidenceFindings.map((finding) => [
      finding.findingId,
      validateFinding(finding, index),
    ]),
  );
  const parseComplete = parsingEvidenceComplete(
    project,
    parsedUnits,
    parseOutcomes,
  );
  const reversePassed = parseComplete
    ? evidenceFindings.filter((finding) =>
        validations.get(finding.findingId)?.every(({ passed }) => passed),
      ).length
    : 0;
  let unsupportedFindingCount = activeFindings.filter((finding) => {
    if (finding.claimType === "pending_confirmation") return true;
    if (!isEvidenceFinding(finding)) return false;
    if (!hasCitation(finding, project)) return true;
    return validations
      .get(finding.findingId)
      ?.some(({ rule, passed }) => failedSupportRules.has(rule) && !passed);
  }).length;
  if (!parseComplete) {
    unsupportedFindingCount = Math.max(
      unsupportedFindingCount,
      evidenceFindings.length || 1,
    );
  }

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
  parseOutcomes: readonly SourceParseOutcome[] | undefined,
): boolean => {
  if (
    !project.parsingCompleted ||
    !parsedUnits ||
    parsedUnits.length === 0 ||
    !parseOutcomes
  )
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
  if (parseOutcomes.length !== project.sourceUnits.length) return false;
  const outcomeById = new Map(
    parseOutcomes.map((outcome) => [outcome.sourceId, outcome]),
  );
  if (outcomeById.size !== parseOutcomes.length) return false;
  for (const source of project.sourceUnits) {
    const outcome = outcomeById.get(source.sourceId);
    if (
      !outcome ||
      typeof outcome.sourceId !== "string" ||
      outcome.sourceId.length === 0 ||
      outcome.sourceType !== source.sourceType ||
      !Array.isArray(outcome.successfulPages) ||
      !Array.isArray(outcome.failedPages) ||
      !Array.isArray(outcome.ocrFailedPages) ||
      typeof outcome.finalizationBlocked !== "boolean" ||
      !Number.isFinite(outcome.extractionCoverage) ||
      (outcome.pageCount !== null && !Number.isInteger(outcome.pageCount))
    ) {
      return false;
    }
    const sourceUnits = parsedUnits.filter(
      (unit) =>
        unit.sourceId === source.sourceId &&
        unit.sourceType === source.sourceType,
    );
    if (
      outcome.finalizationBlocked !== false ||
      outcome.failedPages.length > 0 ||
      outcome.ocrFailedPages.length > 0 ||
      outcome.extractionCoverage !== 1
    ) {
      return false;
    }

    if (outcome.pageCount === null) {
      if (
        outcome.successfulPages.length > 0 ||
        sourceUnits.some((unit) => unit.page !== null)
      )
        return false;
      continue;
    }
    if (!Number.isInteger(outcome.pageCount) || outcome.pageCount <= 0)
      return false;
    const successfulPages = new Set(outcome.successfulPages);
    if (
      successfulPages.size !== outcome.successfulPages.length ||
      successfulPages.size !== outcome.pageCount
    ) {
      return false;
    }
    for (let page = 1; page <= outcome.pageCount; page += 1) {
      if (!successfulPages.has(page)) return false;
    }
    if (
      sourceUnits.some(
        (unit) =>
          unit.page === null ||
          !Number.isInteger(unit.page) ||
          unit.page < 1 ||
          unit.page > outcome.pageCount!,
      )
    ) {
      return false;
    }
  }
  if (parseOutcomes.some(({ sourceId }) => !sourceById.has(sourceId)))
    return false;
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
  parseOutcomes?: readonly SourceParseOutcome[],
  officialPrimarySourceIds?: OfficialPrimarySourceIds,
): boolean {
  if (!parsingEvidenceComplete(project, parsedUnits, parseOutcomes))
    return false;
  const activeFindings = project.findings.filter(
    ({ reviewStatus }) => reviewStatus !== "deleted",
  );
  if (activeFindings.length === 0) return false;
  return hasPassedQualityGate(
    calculateQuality(
      project,
      parsedUnits,
      parseOutcomes,
      officialPrimarySourceIds,
    ),
  );
}

export const calculateSessionQuality = (
  session: AnalysisEvidenceSession,
): QualityMetrics =>
  calculateQuality(
    session.project,
    session.parsedUnits,
    session.parseOutcomes,
    session.officialPrimarySourceIds,
  );

export const canFinalizeSession = (session: AnalysisEvidenceSession): boolean =>
  canFinalize(
    session.project,
    session.parsedUnits,
    session.parseOutcomes,
    session.officialPrimarySourceIds,
  );
