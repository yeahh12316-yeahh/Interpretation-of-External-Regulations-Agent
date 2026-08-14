import { z } from "zod";

import type { Project } from "../domain/project";
import { FindingSchema, ProjectSchema } from "../domain/schemas";
import { AtomicRequirementSchema } from "../features/analysis/skill-orchestrator";
import type { ParseResult } from "../features/parsing/parse-document";
import { projectDatabase } from "../features/projects/db";
import { reviewSnapshotHash } from "../features/evidence/calculate-quality";
import { stableValue } from "../features/evidence/evidence-hash";
import { RuleReviewAttestationsSchema } from "../features/evidence/review-attestation";
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
const AnalysisStageSchema = z.enum([
  "document_identity",
  "atomic_clauses",
  "key_matters",
  "institution_impact",
]);
const AnalysisVersionSchema = z
  .object({
    versionId: z.string().min(1),
    createdAt: z.string().datetime(),
    reason: z.string().min(1),
    findings: z.array(FindingSchema),
    sourceIds: z.array(z.string().min(1)),
    scope: z.array(AnalysisStageSchema),
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
  })
  .strict();

const WorkflowSessionSchema = z
  .object({
    project: ProjectSchema,
    parseResults: z.array(ParseResultSchema),
    parsedUnits: z.array(ParsedUnitSchema),
    atomicRequirements: z.array(AtomicRequirementSchema),
    reviewAudits: z.array(ReviewAuditSchema),
    ruleReviewAttestations: RuleReviewAttestationsSchema,
    analysisVersions: z.array(AnalysisVersionSchema),
    pendingReanalysis: ReanalysisRequestSchema.nullable(),
    selectedFindingId: z.string().nullable(),
    lastSavedAt: z.string().datetime().nullable(),
  })
  .strict();

export interface WorkflowSession extends ReviewWorkflowState {
  project: Project;
  parseResults: ParseResult[];
  selectedFindingId: string | null;
  lastSavedAt: string | null;
}

export const createEmptyWorkflowSession = (
  projectId = "LOCAL-PROJECT",
  projectName = "未命名外规项目",
): WorkflowSession => ({
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
  ruleReviewAttestations: [],
  analysisVersions: [],
  pendingReanalysis: null,
  selectedFindingId: null,
  lastSavedAt: null,
});

const parseSession = (value: unknown): WorkflowSession => {
  const result = WorkflowSessionSchema.safeParse(value);
  if (!result.success)
    throw new Error("工作流恢复数据格式无效或包含未授权字段");
  const session = result.data as WorkflowSession;
  const sourceIds = new Set(
    session.project.sourceUnits.map(({ sourceId }) => sourceId),
  );
  if (
    session.parseResults.some(({ source }) => !sourceIds.has(source.sourceId))
  )
    throw new Error("工作流解析结果与项目来源不一致");
  const findings = new Map(
    session.project.findings.map((finding) => [finding.findingId, finding]),
  );
  for (const [findingId, finding] of findings) {
    const chain = session.reviewAudits.filter(
      (audit) => audit.findingId === findingId,
    );
    for (let index = 0; index < chain.length; index += 1) {
      const audit = chain[index];
      if (
        audit.beforeHash !== reviewSnapshotHash(audit.beforeSnapshot) ||
        audit.afterHash !== reviewSnapshotHash(audit.afterSnapshot) ||
        audit.beforeHash === audit.afterHash ||
        (index > 0 &&
          stableValue(chain[index - 1].afterSnapshot) !==
            stableValue(audit.beforeSnapshot))
      )
        throw new Error("工作流复核审计哈希链无效");
    }
    if (
      chain.length > 0 &&
      stableValue(chain.at(-1)!.afterSnapshot) !== stableValue(finding)
    ) {
      throw new Error("工作流复核审计链未绑定当前结论");
    }
    if (
      (finding.reviewStatus === "modified" ||
        finding.reviewStatus === "deleted") &&
      chain.length === 0
    ) {
      throw new Error("工作流已修订结论缺少审计链");
    }
  }
  if (session.reviewAudits.some((audit) => !findings.has(audit.findingId)))
    throw new Error("工作流复核审计引用不存在的结论");
  return session;
};

export interface WorkflowSessionRepository {
  save(session: WorkflowSession): Promise<WorkflowSession>;
  load(projectId: string): Promise<WorkflowSession | null>;
}

export const workflowSessionRepository: WorkflowSessionRepository = {
  async save(session) {
    const saved = parseSession(session);
    await projectDatabase.workflowSessions.put({
      projectId: saved.project.projectId,
      session: saved,
      updatedAt: new Date().toISOString(),
    });
    return structuredClone(saved);
  },
  async load(projectId) {
    const record = await projectDatabase.workflowSessions.get(projectId);
    return record ? parseSession(record.session) : null;
  },
};
