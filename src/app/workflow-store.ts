import { z } from "zod";

import type { Project } from "../domain/project";
import { FindingSchema, ProjectSchema } from "../domain/schemas";
import {
  AnalysisArtifactsSchema,
  AtomicRequirementSchema,
  InferenceRelationshipSchema,
  SourceConflictSchema,
  assertReanalysisArtifactsAuthorized,
  assertReanalysisTargetAuthorized,
} from "../features/analysis/skill-orchestrator";
import type { ParseResult } from "../features/parsing/parse-document";
import { buildAnchors } from "../features/parsing/build-anchors";
import { projectDatabase } from "../features/projects/db";
import {
  hasAuthoritativeParsingEvidence,
  reviewSnapshotHash,
} from "../features/evidence/calculate-quality";
import {
  evidenceDigest,
  stableValue,
} from "../features/evidence/evidence-hash";
import {
  RuleReviewAttestationsSchema,
  ruleReviewBinding,
} from "../features/evidence/review-attestation";
import { createSourceIndex } from "../features/evidence/validate-finding";
import {
  analysisStageForFinding,
  analysisVersionHash,
  replayReviewedFindings,
  reanalysisDirectiveHash,
  reviewStateSubstantiveHash,
  validateAnalysisArtifacts,
} from "../features/review/review-actions";
import type { ReviewWorkflowState } from "../features/review/review-actions";

const SourceTypeSchema = z.enum(["regulatory_text", "official_interpretation"]);
const BoundingBoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
const AnchorSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceType: SourceTypeSchema,
    page: z.number().int().positive().nullable(),
    article: z.string().min(1).nullable(),
    paragraphIndex: z.number().int().nonnegative(),
    quote: z.string().min(1),
  })
  .strict();
const ParsedUnitSchema = z
  .object({
    unitId: z.string().optional(),
    sourceId: z.string().min(1),
    sourceType: SourceTypeSchema,
    page: z.number().int().positive().nullable(),
    article: z.string().nullable(),
    paragraphIndex: z.number().int().nonnegative(),
    text: z.string(),
    extractionMethod: z.enum(["text_layer", "docx_xml", "plain_text", "ocr"]),
    confidence: z.number().min(0).max(1),
    boundingBox: BoundingBoxSchema.optional(),
    originalOcrText: z.string().optional(),
    correctedText: z.string().nullable().optional(),
    reviewStatus: z.enum(["unreviewed", "corrected"]).optional(),
    reviewedAt: z.string().nullable().optional(),
    reviewedBy: z.string().nullable().optional(),
    correctionHistory: z
      .array(
        z
          .object({
            correctedText: z.string(),
            reviewedBy: z.string(),
            reviewedAt: z.string(),
          })
          .strict(),
      )
      .optional(),
    ocrRegions: z
      .array(
        z
          .object({
            text: z.string(),
            confidence: z.number(),
            boundingBox: BoundingBoxSchema,
            lowConfidence: z.boolean(),
          })
          .strict(),
      )
      .optional(),
    lowConfidenceCharacters: z
      .array(
        z
          .object({
            text: z.string(),
            confidence: z.number(),
            boundingBox: BoundingBoxSchema,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const OcrReviewSchema = z
  .object({
    unitId: z.string(),
    sourceId: z.string(),
    sourceType: SourceTypeSchema,
    page: z.number().int().positive(),
    method: z.literal("ocr"),
    confidence: z.number(),
    text: z.string(),
    originalOcrText: z.string(),
    correctedText: z.string().nullable(),
    reviewStatus: z.enum(["unreviewed", "corrected", "failed"]),
    reviewedAt: z.string().nullable(),
    reviewedBy: z.string().nullable(),
    correctionHistory: z.array(
      z
        .object({
          correctedText: z.string(),
          reviewedBy: z.string(),
          reviewedAt: z.string(),
        })
        .strict(),
    ),
    boundingBox: BoundingBoxSchema,
    regions: z.array(
      z
        .object({
          text: z.string(),
          confidence: z.number(),
          boundingBox: BoundingBoxSchema,
          lowConfidence: z.boolean(),
        })
        .strict(),
    ),
    lowConfidenceCharacters: z.array(
      z
        .object({
          text: z.string(),
          confidence: z.number(),
          boundingBox: BoundingBoxSchema,
        })
        .strict(),
    ),
    error: z.literal("页面 OCR 识别失败").optional(),
  })
  .strict();
const ParseResultSchema = z
  .object({
    fileHash: z.string().min(1),
    source: z
      .object({
        sourceId: z.string(),
        sourceType: SourceTypeSchema,
        title: z.string(),
        content: z.string(),
      })
      .strict(),
    pageCount: z.number().int().positive().nullable(),
    successfulPages: z.array(z.number().int().positive()),
    failedPages: z.array(
      z
        .object({ page: z.number().int().positive(), error: z.string() })
        .strict(),
    ),
    units: z.array(ParsedUnitSchema),
    ocrReviews: z.array(OcrReviewSchema),
    anchors: z.array(AnchorSchema),
    quality: z
      .object({
        totalCharacters: z.number().int().nonnegative(),
        parsedUnitCount: z.number().int().nonnegative(),
        failedPageCount: z.number().int().nonnegative(),
        lowTextPages: z.array(z.number().int().positive()),
        extractionCoverage: z.number().min(0).max(1),
        ocrFailedPages: z.array(z.number().int().positive()),
        finalizationBlocked: z.boolean(),
      })
      .strict(),
  })
  .strict();
const ReviewAuditSchema = z
  .object({
    findingId: z.string(),
    beforeSnapshot: FindingSchema,
    beforeHash: z.string(),
    afterSnapshot: FindingSchema,
    afterHash: z.string(),
    reason: z.string().min(1),
    reviewer: z.string().min(1),
    reviewedAt: z.string().datetime(),
  })
  .strict();
const ReviewActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      actionId: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
      action: z.enum(["confirm", "soft_delete"]),
      findingId: z.string().min(1),
      beforeSnapshot: FindingSchema,
      beforeHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
      afterSnapshot: FindingSchema,
      afterHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
      reviewer: z.string().min(1),
      reason: z.string().min(1),
      actedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      actionId: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
      action: z.literal("add_human"),
      findingId: z.string().min(1),
      beforeHash: z.null(),
      afterSnapshot: FindingSchema,
      afterHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
      reviewer: z.string().min(1),
      reason: z.string().min(1),
      actedAt: z.string().datetime(),
    })
    .strict(),
]);
const AnalysisStageSchema = z.enum([
  "document_identity",
  "atomic_clauses",
  "key_matters",
  "institution_impact",
]);
const ReanalysisTargetBindingSchema = z
  .object({
    findingId: z.string().min(1),
    category: z.string().min(1),
    claimType: z.enum([
      "regulatory_fact",
      "official_explanation",
      "ai_inference",
      "pending_confirmation",
      "human_judgment",
    ]),
    atomicKind: z.enum(["atomic", "non_atomic"]),
  })
  .strict();
const ReanalysisProvenanceSchema = z
  .object({
    requestId: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    directiveHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    reason: z.string().min(1),
    targetFindingIds: z.array(z.string().min(1)).min(1),
    priorTargets: z.array(ReanalysisTargetBindingSchema).min(1),
    allowedSourceIds: z.array(z.string().min(1)).min(1),
    allowedStages: z.array(AnalysisStageSchema).min(1),
    replacedDescendantIds: z.array(z.string().min(1)),
    replacementArtifactsHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    parentVersionHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  })
  .strict();
const AnalysisVersionSchema = z
  .object({
    versionId: z.string().min(1),
    projectId: z.string().min(1),
    parentVersionHash: z.string().nullable(),
    versionHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    createdAt: z.string().datetime(),
    reason: z.string().min(1),
    findings: z.array(FindingSchema),
    atomicRequirements: z.array(AtomicRequirementSchema),
    inferenceRelationships: z.array(InferenceRelationshipSchema),
    conflicts: z.array(SourceConflictSchema),
    replacedFindingIds: z.array(z.string().min(1)).min(1),
    sourceIds: z.array(z.string().min(1)).min(1),
    scope: z.array(AnalysisStageSchema).min(1),
    reanalysisProvenance: ReanalysisProvenanceSchema.nullable(),
  })
  .strict();
const ReanalysisRequestSchema = z
  .object({
    reason: z.string().min(1),
    targetFindingIds: z.array(z.string().min(1)).min(1),
    invalidatedFindingIds: z.array(z.string().min(1)).min(1),
    sourceIds: z.array(z.string().min(1)).min(1),
    scope: z.array(AnalysisStageSchema).min(1),
    requestedBy: z.string().min(1),
    requestedAt: z.string().datetime(),
    returnStep: z.enum(["intake", "parsing", "analysis", "review", "report"]),
    priorFindings: z
      .array(
        z
          .object({
            findingId: z.string().min(1),
            category: z.string().min(1),
            claimType: z.enum([
              "regulatory_fact",
              "official_explanation",
              "ai_inference",
              "pending_confirmation",
              "human_judgment",
            ]),
            atomicKind: z.enum(["atomic", "non_atomic"]),
            statement: z.string().min(1),
            sourceIds: z.array(z.string().min(1)).min(1),
            findingHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
            currentFindingHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
            atomicRequirementHash: z
              .string()
              .regex(/^fnv1a64:[0-9a-f]{16}$/u)
              .nullable(),
          })
          .strict(),
      )
      .min(1),
    baselineSessionRevision: z.number().int().nonnegative(),
    baselineSubstantiveHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    requestHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  })
  .strict();

const OfficialPrimarySourceIdsSchema = z.record(
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
);

const WorkflowSessionSchema = z
  .object({
    sessionVersion: z.literal(1),
    contentHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    revision: z.number().int().nonnegative(),
    project: ProjectSchema,
    parseResults: z.array(ParseResultSchema),
    parsedUnits: z.array(ParsedUnitSchema),
    atomicRequirements: z.array(AtomicRequirementSchema),
    reviewAudits: z.array(ReviewAuditSchema),
    reviewActions: z.array(ReviewActionSchema),
    ruleReviewAttestations: RuleReviewAttestationsSchema,
    analysisVersions: z.array(AnalysisVersionSchema),
    pendingReanalysis: ReanalysisRequestSchema.nullable(),
    officialPrimarySourceIds: OfficialPrimarySourceIdsSchema,
    selectedFindingId: z.string().nullable(),
    lastSavedAt: z.string().datetime().nullable(),
  })
  .strict();

export interface WorkflowSession extends ReviewWorkflowState {
  sessionVersion: 1;
  contentHash: string;
  revision: number;
  project: Project;
  parseResults: ParseResult[];
  officialPrimarySourceIds: Readonly<Record<string, readonly string[]>>;
  selectedFindingId: string | null;
  lastSavedAt: string | null;
}

export const createEmptyWorkflowSession = (
  projectId = "LOCAL-PROJECT",
  projectName = "未命名外规项目",
): WorkflowSession =>
  sealWorkflowSession({
    sessionVersion: 1,
    contentHash: "fnv1a64:0000000000000000",
    revision: 0,
    project: {
      projectId,
      projectName,
      workflowStep: "intake",
      sourceUnits: [],
      parsingCompleted: false,
      findings: [],
      qualityMetrics: {
        factCitationCoverage: 0,
        citationReverseCheckRate: 0,
        unsupportedFindingCount: 0,
        inferenceMarkingRate: 1,
        requiredReviewCompletionRate: 0,
      },
    },
    parseResults: [],
    parsedUnits: [],
    atomicRequirements: [],
    reviewAudits: [],
    reviewActions: [],
    ruleReviewAttestations: [],
    analysisVersions: [],
    pendingReanalysis: null,
    officialPrimarySourceIds: {},
    selectedFindingId: null,
    lastSavedAt: null,
  });

const workflowContent = (
  session: WorkflowSession,
): Omit<WorkflowSession, "contentHash"> => {
  const { contentHash: _contentHash, ...content } = session;
  return content;
};

/** Client-side consistency hash only; this is not authentication. */
export const workflowSessionContentHash = (session: WorkflowSession): string =>
  evidenceDigest(workflowContent(session));

export const sealWorkflowSession = (
  session: WorkflowSession,
): WorkflowSession => ({
  ...session,
  contentHash: workflowSessionContentHash(session),
});

const parseSession = (value: unknown): WorkflowSession => {
  const result = WorkflowSessionSchema.safeParse(value);
  if (!result.success)
    throw new Error("工作流恢复数据格式无效或包含未授权字段");
  const session = result.data as WorkflowSession;
  if (session.contentHash !== workflowSessionContentHash(session))
    throw new Error("工作流内容哈希不一致；该哈希仅用于一致性检查，不代表认证");
  const sourceIds = new Set(
    session.project.sourceUnits.map(({ sourceId }) => sourceId),
  );
  const sourceById = new Map(
    session.project.sourceUnits.map((source) => [source.sourceId, source]),
  );
  if (
    sourceById.size !== session.project.sourceUnits.length ||
    session.parseResults.some(({ source }) => !sourceIds.has(source.sourceId))
  )
    throw new Error("工作流解析结果与项目来源不一致");
  const parseSourceIds = session.parseResults.map(
    ({ source }) => source.sourceId,
  );
  if (new Set(parseSourceIds).size !== parseSourceIds.length)
    throw new Error("工作流解析结果来源不得重复");
  if (
    stableValue(session.parsedUnits) !==
    stableValue(session.parseResults.flatMap(({ units }) => units))
  )
    throw new Error("工作流解析单元必须由完整 ParseResult 唯一派生");
  for (const parseResult of session.parseResults) {
    const source = sourceById.get(parseResult.source.sourceId);
    if (
      !source ||
      stableValue(source) !== stableValue(parseResult.source) ||
      stableValue(parseResult.anchors) !==
        stableValue(buildAnchors(parseResult.units)) ||
      parseResult.quality.parsedUnitCount !== parseResult.units.length ||
      parseResult.quality.failedPageCount !== parseResult.failedPages.length ||
      parseResult.quality.totalCharacters !==
        parseResult.source.content.length ||
      parseResult.units.some(
        (unit) =>
          unit.sourceId !== source.sourceId ||
          unit.sourceType !== source.sourceType ||
          (unit.text.trim() && !source.content.includes(unit.text.trim())),
      )
    )
      throw new Error("工作流来源内容、解析单元、定位锚点或 OCR 元数据不一致");
  }
  if (
    session.project.parsingCompleted &&
    !hasAuthoritativeParsingEvidence(session)
  )
    throw new Error("工作流权威解析或 OCR 质量校验未通过");
  if (!session.project.parsingCompleted && session.project.findings.length > 0)
    throw new Error("未完成权威解析的工作流不得包含分析结论");

  for (const [officialId, primaryIds] of Object.entries(
    session.officialPrimarySourceIds,
  )) {
    if (
      sourceById.get(officialId)?.sourceType !== "official_interpretation" ||
      new Set(primaryIds).size !== primaryIds.length ||
      primaryIds.some(
        (sourceId) =>
          sourceById.get(sourceId)?.sourceType !== "regulatory_text",
      )
    )
      throw new Error("官方解读与监管原文配对无效");
  }
  for (const source of session.project.sourceUnits) {
    if (
      source.sourceType === "official_interpretation" &&
      !session.officialPrimarySourceIds[source.sourceId]
    )
      throw new Error("每份官方解读都必须显式配对监管原文");
  }

  const versionIds = new Set<string>();
  let parentVersionHash: string | null = null;
  let previousVersion: (typeof session.analysisVersions)[number] | undefined;
  for (const [versionIndex, version] of session.analysisVersions.entries()) {
    const { versionHash: _versionHash, ...unhashed } = version;
    const artifacts = AnalysisArtifactsSchema.safeParse({
      findings: version.findings,
      atomicRequirements: version.atomicRequirements,
      inferenceRelationships: version.inferenceRelationships,
      conflicts: version.conflicts,
    });
    try {
      validateAnalysisArtifacts(version, {
        sources: session.project.sourceUnits,
        parsedUnits: session.parsedUnits,
        officialPrimarySourceIds: session.officialPrimarySourceIds,
      });
    } catch {
      throw new Error(
        "历史分析版本的完整工件、定位锚点或引文与权威 ParseResult 不一致",
      );
    }
    if (
      versionIds.has(version.versionId) ||
      version.versionId !== `V${versionIndex + 1}` ||
      version.projectId !== session.project.projectId ||
      version.parentVersionHash !== parentVersionHash ||
      version.versionHash !== analysisVersionHash(unhashed) ||
      !artifacts.success ||
      new Set(version.sourceIds).size !== version.sourceIds.length ||
      version.sourceIds.some((sourceId) => !sourceIds.has(sourceId)) ||
      [
        ...version.findings.flatMap(({ sourceAnchors }) => sourceAnchors),
        ...version.atomicRequirements.flatMap(
          ({ sourceAnchors }) => sourceAnchors,
        ),
        ...version.inferenceRelationships.flatMap(
          ({ sourceAnchors }) => sourceAnchors,
        ),
        ...version.conflicts.flatMap(({ sourceAnchors }) => sourceAnchors),
      ].some(({ sourceId }) => !version.sourceIds.includes(sourceId)) ||
      version.findings.some(
        ({ claimType, reviewStatus, revisionRecords }) =>
          claimType === "human_judgment" ||
          reviewStatus !== "unreviewed" ||
          revisionRecords.length !== 0,
      ) ||
      new Set(version.replacedFindingIds).size !==
        version.replacedFindingIds.length ||
      version.replacedFindingIds.some(
        (findingId) =>
          !version.findings.some(({ findingId: id }) => id === findingId),
      )
    )
      throw new Error("工作流分析版本哈希、父链、项目或工件绑定无效");
    const replaced = new Set(version.replacedFindingIds);
    if (!previousVersion) {
      if (
        version.reanalysisProvenance !== null ||
        stableValue([...replaced].sort()) !==
          stableValue(version.findings.map(({ findingId }) => findingId).sort())
      )
        throw new Error("首个分析版本必须声明完整初始 Finding 范围");
    } else {
      const priorVersion = previousVersion;
      const provenance = version.reanalysisProvenance;
      const previousById = new Map(
        priorVersion.findings.map((finding) => [finding.findingId, finding]),
      );
      const currentById = new Map(
        version.findings.map((finding) => [finding.findingId, finding]),
      );
      const invalidated = new Set(replaced);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const finding of priorVersion.findings) {
          if (
            !invalidated.has(finding.findingId) &&
            finding.inferenceParents.some((parentId) =>
              invalidated.has(parentId),
            )
          ) {
            invalidated.add(finding.findingId);
            expanded = true;
          }
        }
      }
      const expectedCurrentIds = priorVersion.findings
        .filter(
          ({ findingId }) =>
            !invalidated.has(findingId) || replaced.has(findingId),
        )
        .map(({ findingId }) => findingId)
        .sort();
      const unchangedAtomic = (
        findingId: string,
        atomics: typeof version.atomicRequirements,
      ) => atomics.filter((item) => item.findingId === findingId);
      const targetBindings = version.replacedFindingIds.map((findingId) => {
        const finding = previousById.get(findingId);
        return finding
          ? {
              findingId,
              category: finding.category,
              claimType: finding.claimType,
              atomicKind:
                finding.category === "atomic_requirement"
                  ? ("atomic" as const)
                  : ("non_atomic" as const),
            }
          : null;
      });
      const expectedDescendants = [...invalidated].filter(
        (findingId) => !replaced.has(findingId),
      );
      const retainedFindingIds = new Set(
        priorVersion.findings
          .filter(({ findingId }) => !invalidated.has(findingId))
          .map(({ findingId }) => findingId),
      );
      const retainedRelationships = priorVersion.inferenceRelationships.filter(
        ({ toFindingId, fromFindingIds }) =>
          retainedFindingIds.has(toFindingId) &&
          fromFindingIds.every((findingId) =>
            retainedFindingIds.has(findingId),
          ),
      );
      const retainedConflicts = priorVersion.conflicts.filter(
        ({ conflictId, regulatoryFindingId, interpretationFindingId }) =>
          retainedFindingIds.has(conflictId) &&
          retainedFindingIds.has(regulatoryFindingId) &&
          retainedFindingIds.has(interpretationFindingId),
      );
      const isRetainedArtifact = <T>(artifact: T, retained: readonly T[]) =>
        retained.some(
          (candidate) => stableValue(candidate) === stableValue(artifact),
        );
      const replacementArtifacts = {
        findings: version.findings.filter(({ findingId }) =>
          replaced.has(findingId),
        ),
        atomicRequirements: version.atomicRequirements.filter(({ findingId }) =>
          replaced.has(findingId),
        ),
        inferenceRelationships: version.inferenceRelationships.filter(
          (artifact) => !isRetainedArtifact(artifact, retainedRelationships),
        ),
        conflicts: version.conflicts.filter(
          (artifact) => !isRetainedArtifact(artifact, retainedConflicts),
        ),
      };
      const replacementArtifactsTouchTargets =
        replacementArtifacts.inferenceRelationships.every(
          ({ toFindingId, fromFindingIds }) =>
            replaced.has(toFindingId) ||
            fromFindingIds.some((findingId) => replaced.has(findingId)),
        ) &&
        replacementArtifacts.conflicts.every(
          ({ conflictId, regulatoryFindingId, interpretationFindingId }) =>
            replaced.has(conflictId) ||
            replaced.has(regulatoryFindingId) ||
            replaced.has(interpretationFindingId),
        );
      if (provenance) {
        for (const findingId of version.replacedFindingIds) {
          const prior = previousById.get(findingId);
          if (!prior) continue;
          assertReanalysisTargetAuthorized(
            {
              category: prior.category,
              claimType: prior.claimType,
              sourceIds: [
                ...new Set(prior.sourceAnchors.map(({ sourceId }) => sourceId)),
              ],
            },
            provenance,
          );
        }
        assertReanalysisArtifactsAuthorized(replacementArtifacts, provenance);
      }
      if (
        !provenance ||
        provenance.parentVersionHash !== priorVersion.versionHash ||
        provenance.directiveHash !== reanalysisDirectiveHash(provenance) ||
        provenance.reason !== version.reason ||
        new Set(provenance.targetFindingIds).size !==
          provenance.targetFindingIds.length ||
        new Set(provenance.allowedSourceIds).size !==
          provenance.allowedSourceIds.length ||
        new Set(provenance.allowedStages).size !==
          provenance.allowedStages.length ||
        new Set(provenance.replacedDescendantIds).size !==
          provenance.replacedDescendantIds.length ||
        stableValue(provenance.targetFindingIds) !==
          stableValue(version.replacedFindingIds) ||
        stableValue(provenance.priorTargets) !== stableValue(targetBindings) ||
        stableValue([...provenance.replacedDescendantIds].sort()) !==
          stableValue([...expectedDescendants].sort()) ||
        provenance.allowedSourceIds.some(
          (sourceId) => !version.sourceIds.includes(sourceId),
        ) ||
        provenance.allowedStages.some(
          (stage) => !version.scope.includes(stage),
        ) ||
        stableValue([...version.sourceIds].sort()) !==
          stableValue(
            [
              ...new Set([
                ...priorVersion.sourceIds,
                ...provenance.allowedSourceIds,
              ]),
            ].sort(),
          ) ||
        stableValue([...version.scope].sort()) !==
          stableValue(
            [
              ...new Set([...priorVersion.scope, ...provenance.allowedStages]),
            ].sort(),
          ) ||
        provenance.replacementArtifactsHash !==
          evidenceDigest(replacementArtifacts) ||
        !replacementArtifactsTouchTargets ||
        version.replacedFindingIds.some(
          (findingId) =>
            !previousById.has(findingId) || !currentById.has(findingId),
        ) ||
        stableValue([...currentById.keys()].sort()) !==
          stableValue(expectedCurrentIds) ||
        version.findings.some((finding) => {
          if (!replaced.has(finding.findingId)) return false;
          const prior = previousById.get(finding.findingId);
          return (
            !prior ||
            finding.category !== prior.category ||
            finding.claimType !== prior.claimType ||
            (finding.category === "atomic_requirement"
              ? "atomic"
              : "non_atomic") !==
              (prior.category === "atomic_requirement"
                ? "atomic"
                : "non_atomic")
          );
        }) ||
        version.findings.some(
          (finding) =>
            !replaced.has(finding.findingId) &&
            stableValue(finding) !==
              stableValue(previousById.get(finding.findingId)),
        ) ||
        version.findings.some(
          (finding) =>
            !replaced.has(finding.findingId) &&
            stableValue(
              unchangedAtomic(finding.findingId, version.atomicRequirements),
            ) !==
              stableValue(
                unchangedAtomic(
                  finding.findingId,
                  priorVersion.atomicRequirements,
                ),
              ),
        ) ||
        stableValue(
          version.inferenceRelationships.filter((artifact) =>
            isRetainedArtifact(artifact, retainedRelationships),
          ),
        ) !== stableValue(retainedRelationships) ||
        stableValue(
          version.conflicts.filter((artifact) =>
            isRetainedArtifact(artifact, retainedConflicts),
          ),
        ) !== stableValue(retainedConflicts)
      )
        throw new Error(
          "分析版本 provenance 指令、替换目标、失效后代或未变工件派生无效",
        );
    }
    versionIds.add(version.versionId);
    parentVersionHash = version.versionHash;
    previousVersion = version;
  }
  const latestVersion = session.analysisVersions.at(-1);
  const authoritativeIndex = createSourceIndex({
    sources: session.project.sourceUnits,
    parsedUnits: session.parsedUnits,
    findings: latestVersion?.findings ?? [],
    officialPrimarySourceIds: session.officialPrimarySourceIds,
    atomicRequirements: latestVersion?.atomicRequirements ?? [],
  });
  const replayedFindings = replayReviewedFindings(
    latestVersion,
    session.reviewAudits,
    session.reviewActions,
    authoritativeIndex,
  );
  if (
    stableValue(replayedFindings) !== stableValue(session.project.findings) ||
    stableValue(latestVersion?.atomicRequirements ?? []) !==
      stableValue(session.atomicRequirements)
  )
    throw new Error(
      "当前结论或原子工件不能由最新分析版本及受控复核日志唯一派生",
    );
  const findings = new Map(
    session.project.findings.map((finding) => [finding.findingId, finding]),
  );
  if (
    findings.size !== session.project.findings.length ||
    (!latestVersion && session.project.findings.length > 0)
  )
    throw new Error("当前 Finding 与 AtomicRequirement 工件绑定无效");

  const attestationKeys = new Set<string>();
  for (const attestation of session.ruleReviewAttestations) {
    const finding = findings.get(attestation.findingId);
    const requirements = session.atomicRequirements.filter(
      ({ findingId }) => findingId === attestation.findingId,
    );
    const key = `${attestation.findingId}\u0000${attestation.rule}`;
    if (
      !finding ||
      attestationKeys.has(key) ||
      requirements.length > 1 ||
      stableValue(ruleReviewBinding(finding, requirements[0])) !==
        stableValue({
          findingId: attestation.findingId,
          sourceEvidenceHash: attestation.sourceEvidenceHash,
          findingHash: attestation.findingHash,
          atomicRequirementHash: attestation.atomicRequirementHash,
        })
    )
      throw new Error("人工规则确认记录重复、冲突或未绑定当前证据");
    attestationKeys.add(key);
  }

  if (session.pendingReanalysis) {
    const request = session.pendingReanalysis;
    const { requestHash: _requestHash, ...requestContent } = request;
    const invalidated = new Set(request.targetFindingIds);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const finding of session.project.findings) {
        if (
          !invalidated.has(finding.findingId) &&
          finding.inferenceParents.some((parentId) => invalidated.has(parentId))
        ) {
          invalidated.add(finding.findingId);
          expanded = true;
        }
      }
    }
    const expectedInvalidated = session.project.findings
      .filter(({ findingId }) => invalidated.has(findingId))
      .map(({ findingId }) => findingId);
    if (
      request.requestHash !== evidenceDigest(requestContent) ||
      session.revision < request.baselineSessionRevision ||
      reviewStateSubstantiveHash(session, request.returnStep) !==
        request.baselineSubstantiveHash ||
      session.project.workflowStep !== "analysis" ||
      new Set(request.targetFindingIds).size !==
        request.targetFindingIds.length ||
      request.targetFindingIds.length !== request.priorFindings.length ||
      new Set(request.sourceIds).size !== request.sourceIds.length ||
      new Set(request.scope).size !== request.scope.length ||
      request.sourceIds.some((sourceId) => !sourceIds.has(sourceId)) ||
      stableValue(request.invalidatedFindingIds) !==
        stableValue(expectedInvalidated) ||
      request.priorFindings.some((prior) => {
        const summary = {
          findingId: prior.findingId,
          category: prior.category,
          claimType: prior.claimType,
          atomicKind: prior.atomicKind,
          statement: prior.statement,
          sourceIds: prior.sourceIds,
        };
        const current = findings.get(prior.findingId);
        const requirements = session.atomicRequirements.filter(
          ({ findingId }) => findingId === prior.findingId,
        );
        const currentAtomicHash =
          requirements.length === 1 ? evidenceDigest(requirements[0]) : null;
        return (
          prior.findingHash !== evidenceDigest(summary) ||
          !current ||
          prior.currentFindingHash !== evidenceDigest(current) ||
          prior.atomicRequirementHash !== currentAtomicHash ||
          current.claimType === "human_judgment" ||
          !request.targetFindingIds.includes(prior.findingId) ||
          current.category !== prior.category ||
          current.claimType !== prior.claimType ||
          current.statement !== prior.statement ||
          (current.category === "atomic_requirement"
            ? "atomic"
            : "non_atomic") !== prior.atomicKind ||
          !request.scope.includes(analysisStageForFinding(current)) ||
          stableValue([
            ...new Set(current.sourceAnchors.map(({ sourceId }) => sourceId)),
          ]) !== stableValue(prior.sourceIds) ||
          prior.sourceIds.some(
            (sourceId) => !request.sourceIds.includes(sourceId),
          )
        );
      })
    )
      throw new Error("待处理重分析请求的目标、来源或摘要哈希无效");
  }
  return session;
};

export interface WorkflowSessionRepository {
  save(
    session: WorkflowSession,
    expectedRevision: number,
  ): Promise<WorkflowSession>;
  load(projectId: string): Promise<WorkflowSession | null>;
}

export const workflowSessionRepository: WorkflowSessionRepository = {
  async save(session, expectedRevision) {
    if (session.revision !== expectedRevision)
      throw new Error("工作流保存基线 revision 与当前状态不一致");
    const candidate = parseSession(sealWorkflowSession(session));
    return projectDatabase.transaction(
      "rw",
      projectDatabase.workflowSessions,
      async () => {
        const existing = await projectDatabase.workflowSessions.get(
          candidate.project.projectId,
        );
        const currentRevision = existing?.revision ?? 0;
        if (currentRevision !== expectedRevision)
          throw new Error("工作流已被更新，拒绝覆盖较新的本地版本");
        const saved = parseSession(
          sealWorkflowSession({ ...candidate, revision: currentRevision + 1 }),
        );
        await projectDatabase.workflowSessions.put({
          projectId: saved.project.projectId,
          session: saved,
          revision: saved.revision,
          updatedAt: new Date().toISOString(),
        });
        return structuredClone(saved);
      },
    );
  },
  async load(projectId) {
    const record = await projectDatabase.workflowSessions.get(projectId);
    if (!record) return null;
    const session = parseSession(record.session);
    if (record.revision !== session.revision)
      throw new Error("工作流存储 revision 与内容不一致");
    return session;
  },
};
