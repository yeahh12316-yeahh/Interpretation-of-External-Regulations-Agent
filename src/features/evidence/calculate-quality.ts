import { z } from "zod";

import type { Finding } from "../../domain/finding";
import {
  hasInvalidInstitutionImpactSemantics,
  isInstitutionImpactNamespaceCategory,
} from "../../domain/closed-categories";
import type { Project } from "../../domain/project";
import type { SourceAnchor, SourceType, SourceUnit } from "../../domain/source";
import {
  hasPassedQualityGate,
  type QualityMetrics,
} from "../../domain/quality";
import { buildAnchors, type ParsedSourceUnit } from "../parsing/build-anchors";
import type { ParseResult } from "../parsing/parse-document";
import type { OcrPageResult } from "../parsing/ocr/ocr-pipeline";
import { normalizeText } from "./normalize-text";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import {
  createSourceIndex,
  type OfficialPrimarySourceIds,
  validateFinding,
} from "./validate-finding";
import { evidenceDigest, stableValue } from "./evidence-hash";
import {
  resolveValidationResults,
  type ValidationResolution,
} from "./review-attestation";

export {
  RuleReviewAttestationSchema,
  RuleReviewAttestationsSchema,
  parseRuleReviewAttestations,
  ruleReviewBinding,
  type RuleReviewAttestation,
} from "./review-attestation";

export interface SourceParseOutcome {
  fileHash: string;
  source: SourceUnit;
  sourceId: string;
  sourceType: SourceType;
  pageCount: number | null;
  successfulPages: readonly number[];
  failedPages: readonly { page: number; error: string }[];
  failedPageCount: number;
  parsedUnitCount: number;
  totalCharacters: number;
  orderedUnitDigest: string;
  ocrFailedPages: readonly number[];
  lowTextPages: readonly number[];
  ocrReviews: readonly OcrPageResult[];
  anchors: readonly SourceAnchor[];
  finalizationBlocked: boolean;
  extractionCoverage: number;
  units: readonly ParsedSourceUnit[];
}

/** Task 9 can pass this session boundary without expanding the strict Project schema. */
export interface AnalysisEvidenceSession {
  project: Project;
  parseResults: readonly ParseResult[];
  officialPrimarySourceIds?: OfficialPrimarySourceIds;
  atomicRequirements?: readonly AtomicRequirement[];
  reviewAudits?: readonly ReviewAudit[];
  ruleReviewAttestations?: unknown;
}

export interface EvidenceQualityMetrics extends QualityMetrics {
  automaticValidationRuleCount: number;
  manualConfirmedValidationRuleCount: number;
  manualReviewPendingRuleCount: number;
  manualRejectedValidationRuleCount: number;
  failedValidationRuleCount: number;
  attestationIntegrityFailureCount: number;
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

const BoundingBoxSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
  })
  .strict();

const OcrCorrectionRecordSchema = z
  .object({
    correctedText: z.string(),
    reviewedBy: z.string(),
    reviewedAt: z.string(),
  })
  .strict();

const OcrRegionSchema = z
  .object({
    text: z.string(),
    confidence: z.number().finite(),
    boundingBox: BoundingBoxSchema,
    lowConfidence: z.boolean(),
  })
  .strict();

const OcrCharacterSchema = z
  .object({
    text: z.string(),
    confidence: z.number().finite(),
    boundingBox: BoundingBoxSchema,
  })
  .strict();

const OcrPageResultSchema = z
  .object({
    unitId: z.string(),
    sourceId: z.string(),
    sourceType: z.enum(["regulatory_text", "official_interpretation"]),
    page: z.number().int().positive(),
    method: z.literal("ocr"),
    confidence: z.number().finite(),
    text: z.string(),
    originalOcrText: z.string(),
    correctedText: z.string().nullable(),
    reviewStatus: z.enum(["unreviewed", "corrected", "failed"]),
    reviewedAt: z.string().nullable(),
    reviewedBy: z.string().nullable(),
    correctionHistory: z.array(OcrCorrectionRecordSchema),
    boundingBox: BoundingBoxSchema,
    regions: z.array(OcrRegionSchema),
    lowConfidenceCharacters: z.array(OcrCharacterSchema),
    error: z.literal("页面 OCR 识别失败").optional(),
  })
  .strict();

const OcrReviewsSchema = z.array(OcrPageResultSchema);

export const reviewSnapshotHash = (finding: Finding): string => {
  return evidenceDigest(finding);
};

export const orderedUnitDigest = (units: readonly ParsedSourceUnit[]): string =>
  evidenceDigest(units);

export const parseOutcomeFromResult = (
  result: ParseResult,
): SourceParseOutcome => ({
  fileHash: result.fileHash,
  source: result.source,
  sourceId: result.source.sourceId,
  sourceType: result.source.sourceType,
  pageCount: result.pageCount,
  successfulPages: result.successfulPages,
  failedPages: result.failedPages,
  failedPageCount: result.quality.failedPageCount,
  parsedUnitCount: result.quality.parsedUnitCount,
  totalCharacters: result.quality.totalCharacters,
  orderedUnitDigest: orderedUnitDigest(result.units),
  ocrFailedPages: result.quality.ocrFailedPages,
  lowTextPages: result.quality.lowTextPages,
  ocrReviews: result.ocrReviews,
  anchors: result.anchors,
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
  stableValue(audit.beforeSnapshot) !== stableValue(audit.afterSnapshot);

const isValidReviewAuditChain = (
  finding: Finding,
  audits: readonly ReviewAudit[],
): boolean => {
  if (
    audits.length === 0 ||
    !audits.every((audit) => isValidReviewAudit(finding, audit))
  ) {
    return false;
  }
  for (let index = 0; index < audits.length; index += 1) {
    if (
      index > 0 &&
      (Date.parse(audits[index - 1].reviewedAt) >=
        Date.parse(audits[index].reviewedAt) ||
        stableValue(audits[index - 1].afterSnapshot) !==
          stableValue(audits[index].beforeSnapshot))
    ) {
      return false;
    }
  }
  return (
    stableValue(audits[audits.length - 1].afterSnapshot) ===
    stableValue(finding)
  );
};

const isReviewed = (
  finding: Finding,
  auditsByFindingId: ReadonlyMap<string, readonly ReviewAudit[]>,
): boolean => {
  if (finding.reviewStatus === "confirmed") return true;
  if (finding.reviewStatus === "modified") {
    const audits = auditsByFindingId.get(finding.findingId) ?? [];
    return isValidReviewAuditChain(finding, audits);
  }
  if (!hasValidRevisionHistory(finding)) return false;
  return finding.reviewStatus === "deleted";
};

const isEvidenceFinding = (finding: Finding): boolean =>
  finding.claimType === "regulatory_fact" ||
  finding.claimType === "official_explanation" ||
  finding.claimType === "ai_inference" ||
  finding.claimType === "human_judgment";

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
  "atomic_structure",
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
  ruleReviewAttestations: unknown = [],
): EvidenceQualityMetrics {
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
      resolveValidationResults(
        finding,
        validateFinding(finding, index),
        atomicRequirements,
        ruleReviewAttestations,
      ),
    ]),
  );
  const parseComplete = parsingEvidenceComplete(
    project,
    parsedUnits,
    parseOutcomes,
  );
  const reversePassed = parseComplete
    ? evidenceFindings.filter((finding) =>
        validations
          .get(finding.findingId)
          ?.every(({ effectivePassed }) => effectivePassed),
      ).length
    : 0;
  let unsupportedFindingCount = activeFindings.filter((finding) => {
    if (hasInvalidInstitutionImpactSemantics(finding)) return true;
    if (finding.claimType === "pending_confirmation") return true;
    if (!isEvidenceFinding(finding)) return false;
    if (!hasCitation(finding, project)) return true;
    return validations
      .get(finding.findingId)
      ?.some(
        ({ rule, effectivePassed }) =>
          failedSupportRules.has(rule) && !effectivePassed,
      );
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
      isInstitutionImpactNamespaceCategory(finding.category),
  );
  const markedInferences = inferenceCandidates.filter(
    (finding) =>
      finding.claimType === "ai_inference" &&
      validations
        .get(finding.findingId)
        ?.find(({ rule }) => rule === "inference_parent")?.effectivePassed,
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

  const resolutionCounts = [...validations.values()]
    .flat()
    .reduce<Record<ValidationResolution, number>>(
      (counts, validation) => ({
        ...counts,
        [validation.resolution]: counts[validation.resolution] + 1,
      }),
      {
        automatic_passed: 0,
        manual_confirmed: 0,
        manual_review_pending: 0,
        manual_rejected: 0,
        attestation_integrity_failed: 0,
        failed: 0,
      },
    );
  const attestationIntegrityKeys = new Set(
    [...validations.entries()].flatMap(([findingId, results]) =>
      results.flatMap((validation) =>
        validation.resolution === "attestation_integrity_failed"
          ? [
              validation.rule === "attestation_integrity"
                ? "attestation_import"
                : `${findingId}:${validation.rule}`,
            ]
          : [],
      ),
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
    automaticValidationRuleCount: resolutionCounts.automatic_passed,
    manualConfirmedValidationRuleCount: resolutionCounts.manual_confirmed,
    manualReviewPendingRuleCount: resolutionCounts.manual_review_pending,
    manualRejectedValidationRuleCount: resolutionCounts.manual_rejected,
    failedValidationRuleCount: resolutionCounts.failed,
    attestationIntegrityFailureCount: attestationIntegrityKeys.size,
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
      typeof outcome.fileHash !== "string" ||
      !/^[0-9a-f]{64}$/iu.test(outcome.fileHash) ||
      !outcome.source ||
      stableValue(outcome.source) !== stableValue(source) ||
      typeof outcome.sourceId !== "string" ||
      outcome.sourceId.length === 0 ||
      outcome.sourceType !== source.sourceType ||
      !Array.isArray(outcome.successfulPages) ||
      !Array.isArray(outcome.failedPages) ||
      !Array.isArray(outcome.ocrFailedPages) ||
      !Array.isArray(outcome.lowTextPages) ||
      !Array.isArray(outcome.ocrReviews) ||
      !Array.isArray(outcome.anchors) ||
      !Array.isArray(outcome.units) ||
      !Number.isInteger(outcome.failedPageCount) ||
      outcome.failedPageCount < 0 ||
      !Number.isInteger(outcome.parsedUnitCount) ||
      outcome.parsedUnitCount < 0 ||
      !Number.isInteger(outcome.totalCharacters) ||
      outcome.totalCharacters < 0 ||
      typeof outcome.orderedUnitDigest !== "string" ||
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
    const outcomeUnitKeys = outcome.units.map(stableValue);
    const sessionUnitKeys = sourceUnits.map(stableValue);
    const reconstructedContent = outcome.units
      .map((unit) => unit.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .replace(/\r\n?/gu, "\n")
      .trim();
    const authoritativeContent = source.content.replace(/\r\n?/gu, "\n").trim();
    const parsedOcrReviews = OcrReviewsSchema.safeParse(outcome.ocrReviews);
    if (!parsedOcrReviews.success) return false;
    const expectedAnchors = buildAnchors(outcome.units);
    const locatorKeys = expectedAnchors.map(({ quote: _quote, ...locator }) =>
      stableValue(locator),
    );
    const unitIds = outcome.units.flatMap(({ unitId }) =>
      unitId === undefined ? [] : [unitId],
    );
    if (
      outcome.finalizationBlocked !== false ||
      outcome.failedPages.length > 0 ||
      outcome.failedPageCount !== outcome.failedPages.length ||
      outcome.parsedUnitCount !== outcome.units.length ||
      outcome.parsedUnitCount !== sourceUnits.length ||
      outcome.totalCharacters !== source.content.length ||
      outcome.orderedUnitDigest !== orderedUnitDigest(outcome.units) ||
      outcomeUnitKeys.join("\u0000") !== sessionUnitKeys.join("\u0000") ||
      reconstructedContent !== authoritativeContent ||
      stableValue(outcome.anchors) !== stableValue(expectedAnchors) ||
      new Set(locatorKeys).size !== locatorKeys.length ||
      unitIds.some((unitId) => !unitId.trim()) ||
      new Set(unitIds).size !== unitIds.length ||
      outcome.units.some(
        (unit) =>
          unit.sourceId !== source.sourceId ||
          unit.sourceType !== source.sourceType ||
          !normalizeText(source.content).includes(normalizeText(unit.text)),
      ) ||
      outcome.ocrFailedPages.length > 0 ||
      !ocrEvidenceComplete(outcome, parsedOcrReviews.data) ||
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
    // OCR is an automatic extraction step, not a mandatory data-entry task.
    // Successful OCR pages are authoritative enough to continue; confidence
    // warnings remain visible in the parsing screen for optional spot checks.
    // Only an explicit OCR failure (handled above) blocks the workflow.
    return true;
  });
};

const isValidDateTime = (value: string | null): value is string =>
  value !== null &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
  !Number.isNaN(Date.parse(value));

const ocrEvidenceComplete = (
  outcome: SourceParseOutcome,
  ocrReviews: readonly OcrPageResult[],
): boolean => {
  const ocrUnits = outcome.units.filter(
    ({ extractionMethod }) => extractionMethod === "ocr",
  );
  const lowTextPages = outcome.lowTextPages;
  if (
    new Set(lowTextPages).size !== lowTextPages.length ||
    lowTextPages.some(
      (page) =>
        !Number.isInteger(page) ||
        page < 1 ||
        outcome.pageCount === null ||
        page > outcome.pageCount,
    ) ||
    ocrReviews.length !== ocrUnits.length
  ) {
    return false;
  }
  const reviewPages = ocrReviews.map(({ page }) => page);
  if (
    new Set(reviewPages).size !== reviewPages.length ||
    stableValue([...reviewPages].sort((left, right) => left - right)) !==
      stableValue([...lowTextPages].sort((left, right) => left - right))
  ) {
    return false;
  }

  return ocrReviews.every((review) => {
    const matchingUnits = ocrUnits.filter(
      (unit) =>
        unit.unitId === review.unitId &&
        unit.sourceId === review.sourceId &&
        unit.sourceType === review.sourceType &&
        unit.page === review.page,
    );
    if (matchingUnits.length !== 1) return false;
    const [unit] = matchingUnits;
    const commonIdentity =
      review.method === "ocr" &&
      review.sourceId === outcome.sourceId &&
      review.sourceType === outcome.sourceType &&
      !review.error &&
      unit.text === review.text &&
      unit.confidence === review.confidence &&
      unit.originalOcrText === review.originalOcrText &&
      stableValue(unit.boundingBox) === stableValue(review.boundingBox) &&
      stableValue(unit.ocrRegions ?? []) === stableValue(review.regions) &&
      stableValue(unit.lowConfidenceCharacters ?? []) ===
        stableValue(review.lowConfidenceCharacters);
    if (!commonIdentity) return false;

    if (review.reviewStatus === "unreviewed") {
      return (
        review.correctedText === null &&
        review.reviewedAt === null &&
        review.reviewedBy === null &&
        review.correctionHistory.length === 0 &&
        unit.correctedText === null &&
        unit.reviewStatus === "unreviewed" &&
        unit.reviewedAt === null &&
        unit.reviewedBy === null &&
        stableValue(unit.correctionHistory ?? []) ===
          stableValue(review.correctionHistory)
      );
    }

    if (review.reviewStatus !== "corrected") return false;
    const lastCorrection = review.correctionHistory.at(-1);
    return (
      typeof review.correctedText === "string" &&
      review.correctedText.trim().length > 0 &&
      review.text === review.correctedText &&
      typeof review.reviewedBy === "string" &&
      review.reviewedBy.trim().length > 0 &&
      isValidDateTime(review.reviewedAt) &&
      review.correctionHistory.length > 0 &&
      lastCorrection?.correctedText === review.correctedText &&
      lastCorrection.reviewedBy === review.reviewedBy &&
      lastCorrection.reviewedAt === review.reviewedAt &&
      unit.correctedText === review.correctedText &&
      unit.reviewStatus === review.reviewStatus &&
      unit.reviewedAt === review.reviewedAt &&
      unit.reviewedBy === review.reviewedBy &&
      stableValue(unit.correctionHistory ?? []) ===
        stableValue(review.correctionHistory)
    );
  });
};

export function canFinalize(
  project: Project,
  parsedUnits?: readonly ParsedSourceUnit[],
  parseOutcomes?: readonly SourceParseOutcome[],
  officialPrimarySourceIds?: OfficialPrimarySourceIds,
  atomicRequirements: readonly AtomicRequirement[] = [],
  reviewAudits: readonly ReviewAudit[] = [],
  ruleReviewAttestations: unknown = [],
): boolean {
  if (!parsingEvidenceComplete(project, parsedUnits, parseOutcomes))
    return false;
  const activeFindings = project.findings.filter(
    ({ reviewStatus }) => reviewStatus !== "deleted",
  );
  if (activeFindings.length === 0) return false;
  const quality = calculateQuality(
    project,
    parsedUnits,
    parseOutcomes,
    officialPrimarySourceIds,
    atomicRequirements,
    reviewAudits,
    ruleReviewAttestations,
  );
  return (
    quality.attestationIntegrityFailureCount === 0 &&
    hasPassedQualityGate(quality)
  );
}

const evidenceFromSession = (
  session: AnalysisEvidenceSession,
): {
  parsedUnits: readonly ParsedSourceUnit[] | undefined;
  parseOutcomes: readonly SourceParseOutcome[] | undefined;
} => {
  if (
    !Array.isArray(session.parseResults) ||
    session.parseResults.some(
      (result) =>
        !result ||
        !result.source ||
        !Array.isArray(result.units) ||
        !result.quality,
    )
  ) {
    return { parsedUnits: undefined, parseOutcomes: undefined };
  }
  return {
    parsedUnits: session.parseResults.flatMap(({ units }) => units),
    parseOutcomes: session.parseResults.map(parseOutcomeFromResult),
  };
};

export const calculateSessionQuality = (
  session: AnalysisEvidenceSession,
): EvidenceQualityMetrics => {
  const { parsedUnits, parseOutcomes } = evidenceFromSession(session);
  return calculateQuality(
    session.project,
    parsedUnits,
    parseOutcomes,
    session.officialPrimarySourceIds,
    session.atomicRequirements,
    session.reviewAudits,
    session.ruleReviewAttestations,
  );
};

/**
 * Authoritative Task 4/8 parse and OCR integrity gate for workflow transitions.
 * This is a client-side consistency check, not cryptographic authentication.
 */
export const hasAuthoritativeParsingEvidence = (
  session: AnalysisEvidenceSession,
): boolean => {
  const { parsedUnits, parseOutcomes } = evidenceFromSession(session);
  return parsingEvidenceComplete(session.project, parsedUnits, parseOutcomes);
};

export const canFinalizeSession = (
  session: AnalysisEvidenceSession,
): boolean => {
  const { parsedUnits, parseOutcomes } = evidenceFromSession(session);
  return canFinalize(
    session.project,
    parsedUnits,
    parseOutcomes,
    session.officialPrimarySourceIds,
    session.atomicRequirements,
    session.reviewAudits,
    session.ruleReviewAttestations,
  );
};
