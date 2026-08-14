import type { Finding } from "../../domain/finding";
import type { Project } from "../../domain/project";
import type { SourceType } from "../../domain/source";
import {
  hasPassedQualityGate,
  type QualityMetrics,
} from "../../domain/quality";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import type { ParseResult } from "../parsing/parse-document";
import { normalizeText } from "./normalize-text";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
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
  failedPageCount: number;
  parsedUnitCount: number;
  ocrFailedPages: readonly number[];
  finalizationBlocked: boolean;
  extractionCoverage: number;
  units: readonly ParsedSourceUnit[];
}

/** Task 9 can pass this session boundary without expanding the strict Project schema. */
export interface AnalysisEvidenceSession {
  project: Project;
  parsedUnits: readonly ParsedSourceUnit[];
  parseOutcomes: readonly SourceParseOutcome[];
  officialPrimarySourceIds?: OfficialPrimarySourceIds;
  atomicRequirements?: readonly AtomicRequirement[];
  reviewAudits?: readonly ReviewAudit[];
}

export interface ReviewAudit {
  readonly findingId: string;
  readonly beforeSnapshot: Finding;
  readonly beforeHash: string;
  readonly afterSnapshot: Finding;
  readonly afterHash: string;
  readonly reason: string;
  readonly reviewer: string;
  readonly reviewedAt: string;
}

const stableValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

export const reviewSnapshotHash = (finding: Finding): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(stableValue(finding))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
};

export const parseOutcomeFromResult = (
  result: ParseResult,
): SourceParseOutcome => ({
  sourceId: result.source.sourceId,
  sourceType: result.source.sourceType,
  pageCount: result.pageCount,
  successfulPages: result.successfulPages,
  failedPages: result.failedPages,
  failedPageCount: result.quality.failedPageCount,
  parsedUnitCount: result.quality.parsedUnitCount,
  ocrFailedPages: result.quality.ocrFailedPages,
  finalizationBlocked: result.quality.finalizationBlocked,
  extractionCoverage: result.quality.extractionCoverage,
  units: result.units,
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

const hasValidRevisionHistory = (finding: Finding): boolean =>
  finding.revisionRecords.length > 0 &&
  finding.revisionRecords.every(isValidRevisionRecord);

const isValidReviewAudit = (finding: Finding, audit: ReviewAudit): boolean =>
  audit.findingId === finding.findingId &&
  audit.beforeSnapshot.findingId === finding.findingId &&
  audit.afterSnapshot.findingId === finding.findingId &&
  audit.reason.trim().length > 0 &&
  audit.reviewer.trim().length > 0 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(audit.reviewedAt) &&
  !Number.isNaN(Date.parse(audit.reviewedAt)) &&
  audit.beforeHash === reviewSnapshotHash(audit.beforeSnapshot) &&
  audit.afterHash === reviewSnapshotHash(audit.afterSnapshot) &&
  audit.beforeHash !== audit.afterHash &&
  stableValue(audit.beforeSnapshot) !== stableValue(audit.afterSnapshot) &&
  stableValue(audit.afterSnapshot) === stableValue(finding);

const isReviewed = (
  finding: Finding,
  auditsByFindingId: ReadonlyMap<string, readonly ReviewAudit[]>,
): boolean => {
  if (finding.reviewStatus === "confirmed") return true;
  if (finding.reviewStatus === "modified") {
    const audits = auditsByFindingId.get(finding.findingId) ?? [];
    return audits.length === 1 && isValidReviewAudit(finding, audits[0]);
  }
  if (!hasValidRevisionHistory(finding)) return false;
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
  atomicRequirements: readonly AtomicRequirement[] = [],
  reviewAudits: readonly ReviewAudit[] = [],
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
    atomicRequirements,
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
  const auditsByFindingId = new Map(
    [...new Set(reviewAudits.map(({ findingId }) => findingId))].map(
      (findingId) => [
        findingId,
        reviewAudits.filter((audit) => audit.findingId === findingId),
      ],
    ),
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
      requiredReviews.filter((finding) =>
        isReviewed(finding, auditsByFindingId),
      ).length,
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
      !Array.isArray(outcome.units) ||
      !Number.isInteger(outcome.failedPageCount) ||
      outcome.failedPageCount < 0 ||
      !Number.isInteger(outcome.parsedUnitCount) ||
      outcome.parsedUnitCount < 0 ||
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
    const outcomeUnitKeys = outcome.units.map(stableValue).sort();
    const sessionUnitKeys = sourceUnits.map(stableValue).sort();
    if (
      outcome.finalizationBlocked !== false ||
      outcome.failedPages.length > 0 ||
      outcome.failedPageCount !== outcome.failedPages.length ||
      outcome.parsedUnitCount !== outcome.units.length ||
      outcome.parsedUnitCount !== sourceUnits.length ||
      outcomeUnitKeys.join("\u0000") !== sessionUnitKeys.join("\u0000") ||
      outcome.units.some(
        (unit) =>
          unit.sourceId !== source.sourceId ||
          unit.sourceType !== source.sourceType ||
          !normalizeText(source.content).includes(normalizeText(unit.text)),
      ) ||
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
      if (
        !successfulPages.has(page) ||
        !outcome.units.some((unit) => unit.page === page)
      )
        return false;
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
  atomicRequirements: readonly AtomicRequirement[] = [],
  reviewAudits: readonly ReviewAudit[] = [],
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
      atomicRequirements,
      reviewAudits,
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
    session.atomicRequirements,
    session.reviewAudits,
  );

export const canFinalizeSession = (session: AnalysisEvidenceSession): boolean =>
  canFinalize(
    session.project,
    session.parsedUnits,
    session.parseOutcomes,
    session.officialPrimarySourceIds,
    session.atomicRequirements,
    session.reviewAudits,
  );
