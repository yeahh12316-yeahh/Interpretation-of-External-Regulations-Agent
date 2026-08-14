import type { Finding } from "../../domain/finding";
import type { Project, WorkflowStep } from "../../domain/project";
import { FindingSchema, ProjectSchema } from "../../domain/schemas";
import type { SourceAnchor } from "../../domain/source";
import type {
  AnalysisStage,
  AtomicRequirement,
} from "../analysis/skill-orchestrator";
import { AtomicRequirementSchema } from "../analysis/skill-orchestrator";
import { evidenceDigest } from "../evidence/evidence-hash";
import {
  reviewSnapshotHash,
  type ReviewAudit,
} from "../evidence/calculate-quality";
import { normalizeText } from "../evidence/normalize-text";
import {
  RuleReviewAttestationSchema,
  ruleReviewBinding,
  type RuleReviewAttestation,
} from "../evidence/review-attestation";
import {
  createSourceIndex,
  findParsedUnitForAnchor,
  validateFinding,
  type ValidationRule,
} from "../evidence/validate-finding";
import type { ParsedSourceUnit } from "../parsing/build-anchors";

export interface AnalysisVersion {
  readonly versionId: string;
  readonly projectId: string;
  readonly parentVersionHash: string | null;
  readonly versionHash: string;
  readonly createdAt: string;
  readonly reason: string;
  readonly findings: readonly Finding[];
  readonly atomicRequirements: readonly AtomicRequirement[];
  readonly replacedFindingIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly scope: readonly AnalysisStage[];
}

export type UnhashedAnalysisVersion = Omit<AnalysisVersion, "versionHash">;

export const analysisVersionHash = (version: UnhashedAnalysisVersion): string =>
  evidenceDigest(version);

export const createAnalysisVersion = (
  version: UnhashedAnalysisVersion,
): AnalysisVersion => ({
  ...version,
  versionHash: analysisVersionHash(version),
});

export interface PriorFindingSummary {
  readonly findingId: string;
  readonly category: string;
  readonly claimType: Finding["claimType"];
  readonly statement: string;
  readonly sourceIds: readonly string[];
  readonly findingHash: string;
}

export interface ReanalysisRequest {
  readonly reason: string;
  readonly targetFindingIds: readonly string[];
  readonly invalidatedFindingIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly scope: readonly AnalysisStage[];
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly returnStep: WorkflowStep;
  readonly priorFindings: readonly PriorFindingSummary[];
}

export interface ReviewWorkflowState {
  readonly project: Project;
  readonly parsedUnits: readonly ParsedSourceUnit[];
  readonly atomicRequirements: readonly AtomicRequirement[];
  readonly reviewAudits: readonly ReviewAudit[];
  readonly ruleReviewAttestations: readonly RuleReviewAttestation[];
  readonly analysisVersions: readonly AnalysisVersion[];
  readonly pendingReanalysis: ReanalysisRequest | null;
  readonly officialPrimarySourceIds?: Readonly<
    Record<string, readonly string[]>
  >;
}

export interface ReviewMeta {
  readonly reviewer: string;
  readonly reason: string;
  readonly reviewedAt?: string;
}

const required = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}必填`);
  return normalized;
};

const utc = (value = new Date().toISOString()): string => {
  if (Number.isNaN(Date.parse(value)) || !value.endsWith("Z")) {
    throw new Error("复核时间必须为 UTC ISO 时间");
  }
  return value;
};

const findCurrent = (
  state: ReviewWorkflowState,
  findingId: string,
): Finding => {
  const finding = state.project.findings.find(
    (item) => item.findingId === findingId,
  );
  if (!finding) throw new Error("未找到待复核结论");
  return finding;
};

const applyFindingChange = (
  state: ReviewWorkflowState,
  findingId: string,
  mutate: (
    finding: Finding,
    record: Finding["revisionRecords"][number],
  ) => Finding,
  meta: ReviewMeta,
): ReviewWorkflowState => {
  const reviewer = required(meta.reviewer, "复核人");
  const reason = required(meta.reason, "复核理由");
  const reviewedAt = utc(meta.reviewedAt);
  const before = structuredClone(findCurrent(state, findingId));
  const record = {
    revisedBy: reviewer,
    revisedAt: reviewedAt,
    changeSummary: reason,
  };
  const after = FindingSchema.parse(mutate(before, record));
  if (reviewSnapshotHash(before) === reviewSnapshotHash(after)) {
    throw new Error("复核动作必须改变当前结论");
  }
  const audit: ReviewAudit = {
    findingId,
    beforeSnapshot: before,
    beforeHash: reviewSnapshotHash(before),
    afterSnapshot: structuredClone(after),
    afterHash: reviewSnapshotHash(after),
    reason,
    reviewer,
    reviewedAt,
  };
  const project = ProjectSchema.parse({
    ...state.project,
    findings: state.project.findings.map((finding) =>
      finding.findingId === findingId ? after : finding,
    ),
  });
  return { ...state, project, reviewAudits: [...state.reviewAudits, audit] };
};

export const confirmFinding = (
  state: ReviewWorkflowState,
  findingId: string,
  meta: ReviewMeta,
): ReviewWorkflowState =>
  applyFindingChange(
    state,
    findingId,
    (finding, record) => ({
      ...finding,
      reviewStatus: "confirmed",
      revisionRecords: [...finding.revisionRecords, record],
    }),
    meta,
  );

export const modifyFinding = (
  state: ReviewWorkflowState,
  findingId: string,
  statement: string,
  meta: ReviewMeta,
): ReviewWorkflowState => {
  const nextStatement = required(statement, "修改后陈述");
  if (nextStatement === findCurrent(state, findingId).statement) {
    throw new Error("修改后陈述必须与当前陈述不同");
  }
  return applyFindingChange(
    state,
    findingId,
    (finding, record) => ({
      ...finding,
      statement: nextStatement,
      reviewStatus: "modified",
      revisionRecords: [...finding.revisionRecords, record],
    }),
    meta,
  );
};

export const deleteFinding = (
  state: ReviewWorkflowState,
  findingId: string,
  meta: ReviewMeta,
): ReviewWorkflowState =>
  applyFindingChange(
    state,
    findingId,
    (finding, record) => ({
      ...finding,
      reviewStatus: "deleted",
      revisionRecords: [...finding.revisionRecords, record],
    }),
    meta,
  );

export interface HumanJudgmentInput extends ReviewMeta {
  readonly findingId: string;
  readonly statement: string;
  readonly category: string;
  readonly anchor: SourceAnchor;
}

export const addHumanJudgment = (
  state: ReviewWorkflowState,
  input: HumanJudgmentInput,
): ReviewWorkflowState => {
  const reviewer = required(input.reviewer, "复核人");
  const reason = required(input.reason, "判断理由");
  const reviewedAt = utc(input.reviewedAt);
  if (
    state.project.findings.some(
      ({ findingId }) => findingId === input.findingId,
    )
  ) {
    throw new Error("结论 ID 已存在");
  }
  const source = state.project.sourceUnits.find(
    ({ sourceId, sourceType }) =>
      sourceId === input.anchor.sourceId &&
      sourceType === input.anchor.sourceType,
  );
  const unit = findParsedUnitForAnchor(
    input.anchor,
    createSourceIndex({
      sources: state.project.sourceUnits,
      parsedUnits: state.parsedUnits,
      findings: state.project.findings,
      atomicRequirements: state.atomicRequirements,
    }),
  );
  if (
    !source ||
    !unit ||
    !normalizeText(source.content).includes(normalizeText(input.anchor.quote))
  ) {
    throw new Error("人工判断必须关联项目内真实且可定位的依据");
  }
  const finding = FindingSchema.parse({
    findingId: required(input.findingId, "结论 ID"),
    category: required(input.category, "判断类别"),
    statement: required(input.statement, "人工判断陈述"),
    claimType: "human_judgment",
    sourceAnchors: [input.anchor],
    inferenceParents: [],
    reviewStatus: "confirmed",
    requiredReview: true,
    revisionRecords: [
      { revisedBy: reviewer, revisedAt: reviewedAt, changeSummary: reason },
    ],
  });
  return {
    ...state,
    project: ProjectSchema.parse({
      ...state.project,
      findings: [...state.project.findings, finding],
    }),
  };
};

export const attestValidationRule = (
  state: ReviewWorkflowState,
  findingId: string,
  rule: ValidationRule,
  decision: "confirmed" | "rejected",
  meta: ReviewMeta,
): ReviewWorkflowState => {
  const finding = findCurrent(state, findingId);
  const requirements = state.atomicRequirements.filter(
    (item) => item.findingId === findingId,
  );
  if (requirements.length > 1)
    throw new Error("原子要求绑定不唯一，不能人工确认");
  const currentRule = validateFinding(
    finding,
    createSourceIndex({
      sources: state.project.sourceUnits,
      parsedUnits: state.parsedUnits,
      findings: state.project.findings,
      atomicRequirements: state.atomicRequirements,
    }),
  ).find((result) => result.rule === rule);
  if (!currentRule || currentRule.status !== "manual_review_required") {
    throw new Error("仅当前待人工确认的证据规则可生成确认记录");
  }
  const binding = ruleReviewBinding(finding, requirements[0]);
  const attestation = RuleReviewAttestationSchema.parse({
    ...binding,
    rule,
    decision,
    reviewer: required(meta.reviewer, "复核人"),
    reviewedAt: utc(meta.reviewedAt),
    reason: required(meta.reason, "复核理由"),
  });
  if (
    state.ruleReviewAttestations.some(
      (item) =>
        item.findingId === findingId &&
        item.rule === rule &&
        item.findingHash === binding.findingHash,
    )
  ) {
    throw new Error("当前规则已有人工确认记录");
  }
  return {
    ...state,
    ruleReviewAttestations: [...state.ruleReviewAttestations, attestation],
  };
};

export interface ReturnForReanalysisInput {
  readonly reason: string;
  readonly targetFindingIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly scope: readonly AnalysisStage[];
  readonly requestedBy: string;
  readonly requestedAt?: string;
}

const uniqueNonEmpty = (
  values: readonly string[],
  label: string,
): readonly string[] => {
  if (values.length === 0 || values.some((value) => !value.trim())) {
    throw new Error(`${label}必填`);
  }
  if (new Set(values).size !== values.length)
    throw new Error(`${label}不得重复`);
  return values;
};

const analysisStageForFinding = (finding: Finding): AnalysisStage => {
  if (finding.category === "atomic_requirement") return "atomic_clauses";
  if (finding.category.startsWith("pending_confirmation:atomic_conflict"))
    return "atomic_clauses";
  if (
    finding.category.startsWith("document_identity:") ||
    finding.category.startsWith("pending_confirmation:document_identity:") ||
    finding.category.startsWith("official_context:") ||
    finding.category.startsWith("pending_confirmation:file_profile") ||
    finding.category.startsWith("pending_confirmation:source_conflict")
  )
    return "document_identity";
  if (
    finding.claimType === "ai_inference" ||
    finding.category.startsWith("institution_impact")
  )
    return "institution_impact";
  return "key_matters";
};

export const returnForReanalysis = (
  state: ReviewWorkflowState,
  input: ReturnForReanalysisInput,
): ReviewWorkflowState => {
  if (state.pendingReanalysis) throw new Error("已有重分析请求正在处理");
  const targetFindingIds = uniqueNonEmpty(input.targetFindingIds, "目标结论");
  const sourceIds = uniqueNonEmpty(input.sourceIds, "来源范围");
  if (
    input.scope.length === 0 ||
    new Set(input.scope).size !== input.scope.length
  ) {
    throw new Error("分析范围必填且不得重复");
  }
  if (
    targetFindingIds.some(
      (id) => !state.project.findings.some((f) => f.findingId === id),
    )
  ) {
    throw new Error("重分析目标必须属于当前项目");
  }
  if (
    sourceIds.some(
      (id) => !state.project.sourceUnits.some((s) => s.sourceId === id),
    )
  ) {
    throw new Error("重分析来源必须属于当前项目");
  }
  if (
    sourceIds.some((sourceId) => {
      const source = state.project.sourceUnits.find(
        ({ sourceId: id }) => id === sourceId,
      );
      if (source?.sourceType !== "official_interpretation") return false;
      const paired = state.officialPrimarySourceIds?.[sourceId];
      return !paired?.length || paired.some((id) => !sourceIds.includes(id));
    })
  )
    throw new Error("重分析官方解读必须连同完整显式配对的监管原文提交");
  const targetFindings = targetFindingIds.map((id) =>
    state.project.findings.find((finding) => finding.findingId === id)!,
  );
  if (
    targetFindings.some(
      (finding) =>
        finding.claimType === "human_judgment" ||
        !input.scope.includes(analysisStageForFinding(finding)) ||
        finding.sourceAnchors.length === 0 ||
        finding.sourceAnchors.some(
          ({ sourceId }) => !sourceIds.includes(sourceId),
        ),
    )
  ) {
    throw new Error("重分析目标必须由授权来源完整覆盖，且不得替换人工判断");
  }
  const invalidated = new Set(targetFindingIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const finding of state.project.findings) {
      if (
        !invalidated.has(finding.findingId) &&
        finding.inferenceParents.some((parentId) => invalidated.has(parentId))
      ) {
        invalidated.add(finding.findingId);
        expanded = true;
      }
    }
  }
  const request: ReanalysisRequest = {
    reason: required(input.reason, "退回原因"),
    targetFindingIds,
    invalidatedFindingIds: state.project.findings
      .filter(({ findingId }) => invalidated.has(findingId))
      .map(({ findingId }) => findingId),
    sourceIds,
    scope: input.scope,
    requestedBy: required(input.requestedBy, "发起人"),
    requestedAt: utc(input.requestedAt),
    returnStep: state.project.workflowStep,
    priorFindings: targetFindings.map((finding) => {
      const sourceIds = [
        ...new Set(finding.sourceAnchors.map(({ sourceId }) => sourceId)),
      ];
      const summary = {
        findingId: finding.findingId,
        category: finding.category,
        claimType: finding.claimType,
        statement: finding.statement,
        sourceIds,
      };
      return { ...summary, findingHash: evidenceDigest(summary) };
    }),
  };
  return {
    ...state,
    project: ProjectSchema.parse({
      ...state.project,
      workflowStep: "analysis",
    }),
    pendingReanalysis: request,
  };
};

export const cancelReanalysis = (
  state: ReviewWorkflowState,
): ReviewWorkflowState => {
  if (!state.pendingReanalysis) return state;
  return {
    ...state,
    project: ProjectSchema.parse({
      ...state.project,
      workflowStep: state.pendingReanalysis.returnStep,
    }),
    pendingReanalysis: null,
  };
};

export const completeReanalysis = (
  state: ReviewWorkflowState,
  replacement: {
    readonly findings: readonly Finding[];
    readonly atomicRequirements: readonly AtomicRequirement[];
  },
  completedAt = new Date().toISOString(),
): ReviewWorkflowState => {
  const request = state.pendingReanalysis;
  if (!request) throw new Error("没有待完成的重分析请求");
  const replacementById = new Map(
    replacement.findings.map((finding) => [
      finding.findingId,
      FindingSchema.parse(finding),
    ]),
  );
  if (
    replacementById.size !== replacement.findings.length ||
    replacementById.size !== request.targetFindingIds.length ||
    request.targetFindingIds.some((id) => !replacementById.has(id)) ||
    replacement.findings.some(
      (finding) =>
        !request.targetFindingIds.includes(finding.findingId) ||
        finding.sourceAnchors.length === 0 ||
        finding.sourceAnchors.some(
          ({ sourceId }) => !request.sourceIds.includes(sourceId),
        ),
    )
  ) {
    throw new Error("重分析结果必须精确覆盖全部授权目标结论");
  }
  const findings = state.project.findings.flatMap((finding) => {
    if (request.targetFindingIds.includes(finding.findingId))
      return [replacementById.get(finding.findingId)!];
    return request.invalidatedFindingIds.includes(finding.findingId)
      ? []
      : [finding];
  });
  const retainedAtomicRequirements = state.atomicRequirements.filter(
    ({ findingId }) => !request.invalidatedFindingIds.includes(findingId),
  );
  const replacementAtomicRequirements = replacement.atomicRequirements.map(
    (item) => AtomicRequirementSchema.parse(item),
  );
  if (
    replacementAtomicRequirements.some(
      (item) =>
        !request.targetFindingIds.includes(item.findingId) ||
        item.sourceAnchors.some(
          ({ sourceId }) => !request.sourceIds.includes(sourceId),
        ),
    ) ||
    replacement.findings.some(
      (finding) =>
        finding.category === "atomic_requirement" &&
        replacementAtomicRequirements.filter(
          ({ findingId }) => findingId === finding.findingId,
        ).length !== 1,
    ) ||
    replacementAtomicRequirements.some(
      ({ findingId }) =>
        replacement.findings.find(({ findingId: id }) => id === findingId)
          ?.category !== "atomic_requirement",
    )
  )
    throw new Error("重分析原子要求必须精确绑定授权目标及来源");
  const atomicRequirements = [
    ...retainedAtomicRequirements,
    ...replacementAtomicRequirements,
  ];
  const priorVersion = state.analysisVersions.at(-1);
  const version = createAnalysisVersion({
    versionId: `V${state.analysisVersions.length + 1}`,
    projectId: state.project.projectId,
    parentVersionHash: priorVersion?.versionHash ?? null,
    createdAt: utc(completedAt),
    reason: request.reason,
    findings: structuredClone(findings),
    atomicRequirements: structuredClone(atomicRequirements),
    replacedFindingIds: request.targetFindingIds,
    sourceIds: request.sourceIds,
    scope: request.scope,
  });
  const invalidatedIds = new Set(request.invalidatedFindingIds);
  return {
    ...state,
    project: ProjectSchema.parse({
      ...state.project,
      workflowStep: request.returnStep,
      findings,
    }),
    analysisVersions: [...state.analysisVersions, version],
    atomicRequirements,
    reviewAudits: state.reviewAudits.filter(
      ({ findingId }) => !invalidatedIds.has(findingId),
    ),
    ruleReviewAttestations: state.ruleReviewAttestations.filter(
      ({ findingId }) => !invalidatedIds.has(findingId),
    ),
    pendingReanalysis: null,
  };
};
