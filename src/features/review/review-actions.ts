import type { Finding } from "../../domain/finding";
import type { Project, WorkflowStep } from "../../domain/project";
import { FindingSchema, ProjectSchema } from "../../domain/schemas";
import type { SourceAnchor } from "../../domain/source";
import type {
  AnalysisStage,
  AtomicRequirement,
  InferenceRelationship,
  SourceConflict,
} from "../analysis/skill-orchestrator";
import {
  AnalysisArtifactsSchema,
  AtomicRequirementSchema,
  analysisStageForFinding as task7AnalysisStageForFinding,
} from "../analysis/skill-orchestrator";
import { evidenceDigest, stableValue } from "../evidence/evidence-hash";
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
  type SourceIndex,
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
  readonly inferenceRelationships: readonly InferenceRelationship[];
  readonly conflicts: readonly SourceConflict[];
  readonly replacedFindingIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly scope: readonly AnalysisStage[];
  readonly reanalysisProvenance: ReanalysisProvenance | null;
}

export interface ReanalysisTargetBinding {
  readonly findingId: string;
  readonly category: string;
  readonly claimType: Finding["claimType"];
  readonly atomicKind: "atomic" | "non_atomic";
}

export interface ReanalysisProvenance {
  readonly requestId: string;
  readonly directiveHash: string;
  readonly reason: string;
  readonly targetFindingIds: readonly string[];
  readonly priorTargets: readonly ReanalysisTargetBinding[];
  readonly allowedSourceIds: readonly string[];
  readonly allowedStages: readonly AnalysisStage[];
  readonly replacedDescendantIds: readonly string[];
  readonly replacementArtifactsHash: string;
  readonly parentVersionHash: string;
}

export interface AnalysisArtifactsInput {
  readonly findings: readonly Finding[];
  readonly atomicRequirements: readonly AtomicRequirement[];
  readonly inferenceRelationships: readonly InferenceRelationship[];
  readonly conflicts: readonly SourceConflict[];
}

export interface AuthoritativeAnalysisEvidence {
  readonly sources: ReviewWorkflowState["project"]["sourceUnits"];
  readonly parsedUnits: readonly ParsedSourceUnit[];
  readonly officialPrimarySourceIds?: Readonly<
    Record<string, readonly string[]>
  >;
}

/** Full structural and ParseResult-derived evidence validation. */
export const validateAnalysisArtifacts = (
  artifacts: AnalysisArtifactsInput,
  evidence: AuthoritativeAnalysisEvidence,
): void => {
  AnalysisArtifactsSchema.parse({
    findings: artifacts.findings,
    atomicRequirements: artifacts.atomicRequirements,
    inferenceRelationships: artifacts.inferenceRelationships,
    conflicts: artifacts.conflicts,
  });
  const index = createSourceIndex({
    sources: evidence.sources,
    parsedUnits: evidence.parsedUnits,
    findings: artifacts.findings,
    atomicRequirements: artifacts.atomicRequirements,
    officialPrimarySourceIds: evidence.officialPrimarySourceIds,
  });
  const anchors = [
    ...artifacts.findings.flatMap(({ sourceAnchors }) => sourceAnchors),
    ...artifacts.atomicRequirements.flatMap(
      ({ sourceAnchors }) => sourceAnchors,
    ),
    ...artifacts.inferenceRelationships.flatMap(
      ({ sourceAnchors }) => sourceAnchors,
    ),
    ...artifacts.conflicts.flatMap(({ sourceAnchors }) => sourceAnchors),
  ];
  if (anchors.some((anchor) => !findParsedUnitForAnchor(anchor, index)))
    throw new Error("分析工件锚点、定位或引文与权威 ParseResult 不一致");
};

const reanalysisDirectiveContent = (provenance: ReanalysisProvenance) => ({
  reason: provenance.reason,
  targetFindingIds: provenance.targetFindingIds,
  priorTargets: provenance.priorTargets,
  allowedSourceIds: provenance.allowedSourceIds,
  allowedStages: provenance.allowedStages,
});

export const reanalysisDirectiveHash = (
  provenance: ReanalysisProvenance,
): string => evidenceDigest(reanalysisDirectiveContent(provenance));

export const createReanalysisProvenance = (input: {
  readonly requestId: string;
  readonly reason: string;
  readonly targetFindingIds: readonly string[];
  readonly priorTargets: readonly ReanalysisTargetBinding[];
  readonly allowedSourceIds: readonly string[];
  readonly allowedStages: readonly AnalysisStage[];
  readonly replacedDescendantIds: readonly string[];
  readonly replacement: AnalysisArtifactsInput;
  readonly parentVersionHash: string;
}): ReanalysisProvenance => {
  const directiveContent = {
    reason: input.reason,
    targetFindingIds: input.targetFindingIds,
    priorTargets: input.priorTargets,
    allowedSourceIds: input.allowedSourceIds,
    allowedStages: input.allowedStages,
  };
  return {
    requestId: input.requestId,
    directiveHash: evidenceDigest(directiveContent),
    ...directiveContent,
    replacedDescendantIds: input.replacedDescendantIds,
    replacementArtifactsHash: evidenceDigest(input.replacement),
    parentVersionHash: input.parentVersionHash,
  };
};

export type UnhashedAnalysisVersion = Omit<AnalysisVersion, "versionHash">;

export const analysisVersionHash = (version: UnhashedAnalysisVersion): string =>
  evidenceDigest(version);

export const createAnalysisVersion = (
  version: UnhashedAnalysisVersion,
): AnalysisVersion => {
  AnalysisArtifactsSchema.parse({
    findings: version.findings,
    atomicRequirements: version.atomicRequirements,
    inferenceRelationships: version.inferenceRelationships,
    conflicts: version.conflicts,
  });
  const sourceIds = new Set(version.sourceIds);
  const artifactAnchors = [
    ...version.findings.flatMap(({ sourceAnchors }) => sourceAnchors),
    ...version.atomicRequirements.flatMap(({ sourceAnchors }) => sourceAnchors),
    ...version.inferenceRelationships.flatMap(
      ({ sourceAnchors }) => sourceAnchors,
    ),
    ...version.conflicts.flatMap(({ sourceAnchors }) => sourceAnchors),
  ];
  if (
    !version.sourceIds.length ||
    sourceIds.size !== version.sourceIds.length ||
    !version.scope.length ||
    new Set(version.scope).size !== version.scope.length ||
    !version.replacedFindingIds.length ||
    new Set(version.replacedFindingIds).size !==
      version.replacedFindingIds.length ||
    version.replacedFindingIds.some(
      (findingId) =>
        !version.findings.some(({ findingId: id }) => id === findingId),
    ) ||
    artifactAnchors.some(({ sourceId }) => !sourceIds.has(sourceId)) ||
    (version.parentVersionHash === null) !==
      (version.reanalysisProvenance === null) ||
    (version.reanalysisProvenance !== null &&
      (version.reanalysisProvenance.parentVersionHash !==
        version.parentVersionHash ||
        version.reanalysisProvenance.directiveHash !==
          reanalysisDirectiveHash(version.reanalysisProvenance))) ||
    version.findings.some(
      ({ claimType, reviewStatus, revisionRecords }) =>
        claimType === "human_judgment" ||
        reviewStatus !== "unreviewed" ||
        revisionRecords.length !== 0,
    )
  )
    throw new Error("分析版本范围、来源、替换目标或 AI 基线状态无效");
  return { ...version, versionHash: analysisVersionHash(version) };
};

export interface PriorFindingSummary {
  readonly findingId: string;
  readonly category: string;
  readonly claimType: Finding["claimType"];
  readonly atomicKind: "atomic" | "non_atomic";
  readonly statement: string;
  readonly sourceIds: readonly string[];
  readonly findingHash: string;
  readonly currentFindingHash: string;
  readonly atomicRequirementHash: string | null;
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
  readonly baselineSessionRevision: number;
  readonly baselineSubstantiveHash: string;
  readonly requestHash: string;
}

export interface ReviewDecisionAction {
  readonly actionId: string;
  readonly action: "confirm" | "soft_delete";
  readonly findingId: string;
  readonly beforeSnapshot: Finding;
  readonly beforeHash: string;
  readonly afterSnapshot: Finding;
  readonly afterHash: string;
  readonly reviewer: string;
  readonly reason: string;
  readonly actedAt: string;
}

export interface AddHumanReviewAction {
  readonly actionId: string;
  readonly action: "add_human";
  readonly findingId: string;
  readonly beforeHash: null;
  readonly afterSnapshot: Finding;
  readonly afterHash: string;
  readonly reviewer: string;
  readonly reason: string;
  readonly actedAt: string;
}

export type ReviewAction = ReviewDecisionAction | AddHumanReviewAction;

export interface ReviewWorkflowState {
  readonly project: Project;
  readonly parsedUnits: readonly ParsedSourceUnit[];
  readonly atomicRequirements: readonly AtomicRequirement[];
  readonly reviewAudits: readonly ReviewAudit[];
  readonly reviewActions: readonly ReviewAction[];
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

const stateParseResults = (state: ReviewWorkflowState): unknown =>
  (state as ReviewWorkflowState & { readonly parseResults?: unknown })
    .parseResults ?? null;

const stateRevision = (state: ReviewWorkflowState): number =>
  (state as ReviewWorkflowState & { readonly revision?: number }).revision ?? 0;

/** Substantive client-state consistency only; this is not authentication. */
export const reviewStateSubstantiveHash = (
  state: ReviewWorkflowState,
  workflowStep: WorkflowStep = state.project.workflowStep,
): string =>
  evidenceDigest({
    project: { ...state.project, workflowStep },
    parseResults: stateParseResults(state),
    parsedUnits: state.parsedUnits,
    atomicRequirements: state.atomicRequirements,
    reviewAudits: state.reviewAudits,
    reviewActions: state.reviewActions,
    ruleReviewAttestations: state.ruleReviewAttestations,
    analysisVersions: state.analysisVersions,
    officialPrimarySourceIds: state.officialPrimarySourceIds ?? {},
  });

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
  decisionAction?: ReviewDecisionAction["action"],
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
  const reviewAction: ReviewDecisionAction | null = decisionAction
    ? {
        actionId: evidenceDigest({
          action: decisionAction,
          findingId,
          beforeHash: audit.beforeHash,
          afterHash: audit.afterHash,
          reviewer,
          reason,
          actedAt: reviewedAt,
        }),
        action: decisionAction,
        findingId,
        beforeSnapshot: structuredClone(before),
        beforeHash: audit.beforeHash,
        afterSnapshot: structuredClone(after),
        afterHash: audit.afterHash,
        reviewer,
        reason,
        actedAt: reviewedAt,
      }
    : null;
  const project = ProjectSchema.parse({
    ...state.project,
    findings: state.project.findings.map((finding) =>
      finding.findingId === findingId ? after : finding,
    ),
  });
  return {
    ...state,
    project,
    reviewAudits: [...state.reviewAudits, audit],
    reviewActions: reviewAction
      ? [...state.reviewActions, reviewAction]
      : state.reviewActions,
  };
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
    "confirm",
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
    "soft_delete",
  );

export type HumanJudgmentPurpose = "generic" | "recommended_action";

export interface HumanJudgmentInput extends ReviewMeta {
  readonly findingId: string;
  readonly statement: string;
  readonly purpose: HumanJudgmentPurpose;
  readonly anchor: SourceAnchor;
}

export const addHumanJudgment = (
  state: ReviewWorkflowState,
  input: HumanJudgmentInput,
): ReviewWorkflowState => {
  const category =
    input.purpose === "recommended_action"
      ? "recommended_action:priority"
      : input.purpose === "generic"
        ? "human_review"
        : (() => {
            throw new Error("人工判断用途不在允许范围内");
          })();
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
    category,
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
    reviewActions: [
      ...state.reviewActions,
      {
        actionId: evidenceDigest({
          action: "add_human",
          findingId: finding.findingId,
          afterHash: reviewSnapshotHash(finding),
          reviewer,
          reason,
          actedAt: reviewedAt,
        }),
        action: "add_human",
        findingId: finding.findingId,
        beforeHash: null,
        afterSnapshot: structuredClone(finding),
        afterHash: reviewSnapshotHash(finding),
        reviewer,
        reason,
        actedAt: reviewedAt,
      },
    ],
  };
};

const actionIdFor = (action: ReviewAction): string =>
  evidenceDigest(
    action.action === "add_human"
      ? {
          action: action.action,
          findingId: action.findingId,
          afterHash: action.afterHash,
          reviewer: action.reviewer,
          reason: action.reason,
          actedAt: action.actedAt,
        }
      : {
          action: action.action,
          findingId: action.findingId,
          beforeHash: action.beforeHash,
          afterHash: action.afterHash,
          reviewer: action.reviewer,
          reason: action.reason,
          actedAt: action.actedAt,
        },
  );

/** Pure replay from the latest immutable AI version plus controlled review logs. */
export const replayReviewedFindings = (
  latestVersion: AnalysisVersion | undefined,
  reviewAudits: readonly ReviewAudit[],
  reviewActions: readonly ReviewAction[],
  evidenceIndex: SourceIndex,
): Finding[] => {
  if (!latestVersion) {
    if (reviewAudits.length || reviewActions.length)
      throw new Error("复核动作缺少最新分析版本基线");
    return [];
  }
  const actionIds = new Set<string>();
  const current = new Map(
    latestVersion.findings.map((finding) => [
      finding.findingId,
      structuredClone(finding),
    ]),
  );
  const humanOrder: string[] = [];
  const lastActionTimeByFinding = new Map<string, number>();
  const decisionActions: ReviewDecisionAction[] = [];
  for (const action of reviewActions) {
    if (
      actionIds.has(action.actionId) ||
      action.actionId !== actionIdFor(action) ||
      action.afterHash !== reviewSnapshotHash(action.afterSnapshot)
    )
      throw new Error("复核动作 ID、快照或哈希无效");
    actionIds.add(action.actionId);
    if (action.action === "add_human") {
      if (
        action.beforeHash !== null ||
        current.has(action.findingId) ||
        action.afterSnapshot.findingId !== action.findingId ||
        action.afterSnapshot.claimType !== "human_judgment" ||
        action.afterSnapshot.reviewStatus !== "confirmed" ||
        action.afterSnapshot.sourceAnchors.length === 0 ||
        action.afterSnapshot.sourceAnchors.some(
          (anchor) =>
            findParsedUnitForAnchor(anchor, evidenceIndex) === undefined,
        ) ||
        action.afterSnapshot.revisionRecords.length !== 1 ||
        stableValue(action.afterSnapshot.revisionRecords[0]) !==
          stableValue({
            revisedBy: action.reviewer,
            revisedAt: action.actedAt,
            changeSummary: action.reason,
          })
      )
        throw new Error("人工判断新增动作未绑定完整证据与复核元数据");
      current.set(action.findingId, structuredClone(action.afterSnapshot));
      humanOrder.push(action.findingId);
      lastActionTimeByFinding.set(action.findingId, Date.parse(action.actedAt));
    } else {
      if (
        action.beforeHash !== reviewSnapshotHash(action.beforeSnapshot) ||
        action.beforeSnapshot.findingId !== action.findingId ||
        action.afterSnapshot.findingId !== action.findingId
      )
        throw new Error("复核决定前后快照绑定无效");
      decisionActions.push(action);
    }
  }

  const usedDecisions = new Set<string>();
  for (const audit of reviewAudits) {
    const before = current.get(audit.findingId);
    const reviewedAt = Date.parse(audit.reviewedAt);
    if (
      !before ||
      audit.beforeHash !== reviewSnapshotHash(audit.beforeSnapshot) ||
      audit.afterHash !== reviewSnapshotHash(audit.afterSnapshot) ||
      audit.beforeHash === audit.afterHash ||
      stableValue(before) !== stableValue(audit.beforeSnapshot) ||
      reviewedAt < (lastActionTimeByFinding.get(audit.findingId) ?? 0)
    )
      throw new Error("复核审计未从最新分析版本或前一动作连续派生");
    const record = {
      revisedBy: audit.reviewer,
      revisedAt: audit.reviewedAt,
      changeSummary: audit.reason,
    };
    const expectedRevisionRecords = [
      ...audit.beforeSnapshot.revisionRecords,
      record,
    ];
    const statusOnly =
      audit.beforeSnapshot.statement === audit.afterSnapshot.statement &&
      (audit.afterSnapshot.reviewStatus === "confirmed" ||
        audit.afterSnapshot.reviewStatus === "deleted");
    const expected = statusOnly
      ? {
          ...audit.beforeSnapshot,
          reviewStatus: audit.afterSnapshot.reviewStatus,
          revisionRecords: expectedRevisionRecords,
        }
      : {
          ...audit.beforeSnapshot,
          statement: audit.afterSnapshot.statement,
          reviewStatus: "modified" as const,
          revisionRecords: expectedRevisionRecords,
        };
    if (
      (!statusOnly &&
        audit.beforeSnapshot.statement === audit.afterSnapshot.statement) ||
      stableValue(expected) !== stableValue(audit.afterSnapshot)
    )
      throw new Error("复核审计包含未授权字段变更或伪造修订记录");
    if (statusOnly) {
      const expectedAction =
        audit.afterSnapshot.reviewStatus === "confirmed"
          ? "confirm"
          : "soft_delete";
      const matches = decisionActions.filter(
        (action) =>
          action.action === expectedAction &&
          action.findingId === audit.findingId &&
          action.beforeHash === audit.beforeHash &&
          action.afterHash === audit.afterHash &&
          action.reviewer === audit.reviewer &&
          action.reason === audit.reason &&
          action.actedAt === audit.reviewedAt &&
          stableValue(action.beforeSnapshot) ===
            stableValue(audit.beforeSnapshot) &&
          stableValue(action.afterSnapshot) ===
            stableValue(audit.afterSnapshot),
      );
      if (matches.length !== 1)
        throw new Error("确认或软删除缺少唯一的结构化 ReviewAction");
      usedDecisions.add(matches[0].actionId);
    }
    current.set(audit.findingId, structuredClone(audit.afterSnapshot));
    lastActionTimeByFinding.set(audit.findingId, reviewedAt);
  }
  if (decisionActions.some((action) => !usedDecisions.has(action.actionId)))
    throw new Error("存在未绑定审计链的复核决定动作");
  return [
    ...latestVersion.findings.map((finding) => current.get(finding.findingId)!),
    ...humanOrder.map((findingId) => current.get(findingId)!),
  ];
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

/** Compatibility export backed by Task 7's single authoritative mapping. */
export const analysisStageForFinding = task7AnalysisStageForFinding;

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
  const requestContent: Omit<ReanalysisRequest, "requestHash"> = {
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
        atomicKind:
          finding.category === "atomic_requirement"
            ? ("atomic" as const)
            : ("non_atomic" as const),
        statement: finding.statement,
        sourceIds,
      };
      const requirements = state.atomicRequirements.filter(
        ({ findingId }) => findingId === finding.findingId,
      );
      return {
        ...summary,
        findingHash: evidenceDigest(summary),
        currentFindingHash: evidenceDigest(finding),
        atomicRequirementHash:
          requirements.length === 1 ? evidenceDigest(requirements[0]) : null,
      };
    }),
    baselineSessionRevision: stateRevision(state),
    baselineSubstantiveHash: reviewStateSubstantiveHash(state),
  };
  for (const prior of requestContent.priorFindings) {
    const atomicCount = state.atomicRequirements.filter(
      ({ findingId }) => findingId === prior.findingId,
    ).length;
    if (
      (prior.atomicKind === "atomic" && atomicCount !== 1) ||
      (prior.atomicKind === "non_atomic" && atomicCount !== 0)
    )
      throw new Error("重分析目标的原子类型与当前工件不一致");
  }
  const request: ReanalysisRequest = {
    ...requestContent,
    requestHash: evidenceDigest(requestContent),
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
    readonly inferenceRelationships: readonly InferenceRelationship[];
    readonly conflicts: readonly SourceConflict[];
  },
  completedAt = new Date().toISOString(),
): ReviewWorkflowState => {
  const request = state.pendingReanalysis;
  if (!request) throw new Error("没有待完成的重分析请求");
  const { requestHash: _requestHash, ...requestContent } = request;
  if (
    request.requestHash !== evidenceDigest(requestContent) ||
    stateRevision(state) < request.baselineSessionRevision ||
    reviewStateSubstantiveHash(state, request.returnStep) !==
      request.baselineSubstantiveHash
  )
    throw new Error("重分析请求哈希或基线会话已过期");
  for (const prior of request.priorFindings) {
    const current = state.project.findings.find(
      ({ findingId }) => findingId === prior.findingId,
    );
    const summary = {
      findingId: prior.findingId,
      category: prior.category,
      claimType: prior.claimType,
      atomicKind: prior.atomicKind,
      statement: prior.statement,
      sourceIds: prior.sourceIds,
    };
    const requirements = state.atomicRequirements.filter(
      ({ findingId }) => findingId === prior.findingId,
    );
    const currentAtomicHash =
      requirements.length === 1 ? evidenceDigest(requirements[0]) : null;
    if (
      !current ||
      prior.findingHash !== evidenceDigest(summary) ||
      prior.currentFindingHash !== evidenceDigest(current) ||
      prior.atomicRequirementHash !== currentAtomicHash ||
      current.category !== prior.category ||
      current.claimType !== prior.claimType ||
      current.statement !== prior.statement ||
      stableValue([
        ...new Set(current.sourceAnchors.map(({ sourceId }) => sourceId)),
      ]) !== stableValue(prior.sourceIds) ||
      (current.category === "atomic_requirement" ? "atomic" : "non_atomic") !==
        prior.atomicKind
    )
      throw new Error("重分析请求已过期或未绑定当前目标快照");
  }
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
    ) ||
    [...replacement.inferenceRelationships, ...replacement.conflicts].some(
      (artifact) =>
        artifact.sourceAnchors.some(
          ({ sourceId }) => !request.sourceIds.includes(sourceId),
        ),
    )
  ) {
    throw new Error("重分析结果必须精确覆盖全部授权目标结论");
  }
  const priorById = new Map(
    request.priorFindings.map((finding) => [finding.findingId, finding]),
  );
  for (const finding of replacement.findings) {
    const prior = priorById.get(finding.findingId)!;
    if (
      finding.category !== prior.category ||
      finding.claimType !== prior.claimType ||
      (finding.category === "atomic_requirement" ? "atomic" : "non_atomic") !==
        prior.atomicKind
    )
      throw new Error("重分析结果违反目标 category、claimType 或原子类型约束");
  }
  AnalysisArtifactsSchema.parse(replacement);
  const priorVersion = state.analysisVersions.at(-1);
  if (!priorVersion) throw new Error("重分析缺少不可变的先前分析版本");
  const retainedFindings = priorVersion.findings.filter(
    ({ findingId }) => !request.invalidatedFindingIds.includes(findingId),
  );
  const findings = [...retainedFindings, ...replacement.findings];
  const retainedAtomicRequirements = priorVersion.atomicRequirements.filter(
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
  const retainedFindingIds = new Set(
    retainedFindings.map(({ findingId }) => findingId),
  );
  const inferenceRelationships = [
    ...priorVersion.inferenceRelationships.filter(
      ({ toFindingId, fromFindingIds }) =>
        retainedFindingIds.has(toFindingId) &&
        fromFindingIds.every((findingId) => retainedFindingIds.has(findingId)),
    ),
    ...replacement.inferenceRelationships,
  ];
  const conflicts = [
    ...priorVersion.conflicts.filter(
      ({ conflictId, regulatoryFindingId, interpretationFindingId }) =>
        retainedFindingIds.has(conflictId) &&
        retainedFindingIds.has(regulatoryFindingId) &&
        retainedFindingIds.has(interpretationFindingId),
    ),
    ...replacement.conflicts,
  ];
  const priorTargets: ReanalysisTargetBinding[] = request.priorFindings.map(
    ({ findingId, category, claimType, atomicKind }) => ({
      findingId,
      category,
      claimType,
      atomicKind,
    }),
  );
  const reanalysisProvenance = createReanalysisProvenance({
    requestId: request.requestHash,
    reason: request.reason,
    targetFindingIds: [...request.targetFindingIds],
    priorTargets,
    allowedSourceIds: [...request.sourceIds],
    allowedStages: [...request.scope],
    replacedDescendantIds: request.invalidatedFindingIds.filter(
      (findingId) => !request.targetFindingIds.includes(findingId),
    ),
    replacement,
    parentVersionHash: priorVersion.versionHash,
  });
  const version = createAnalysisVersion({
    versionId: `V${state.analysisVersions.length + 1}`,
    projectId: state.project.projectId,
    parentVersionHash: priorVersion?.versionHash ?? null,
    createdAt: utc(completedAt),
    reason: request.reason,
    findings: structuredClone(findings),
    atomicRequirements: structuredClone(atomicRequirements),
    inferenceRelationships: structuredClone(inferenceRelationships),
    conflicts: structuredClone(conflicts),
    replacedFindingIds: request.targetFindingIds,
    sourceIds: [...new Set([...priorVersion.sourceIds, ...request.sourceIds])],
    scope: [...new Set([...priorVersion.scope, ...request.scope])],
    reanalysisProvenance,
  });
  validateAnalysisArtifacts(version, {
    sources: state.project.sourceUnits,
    parsedUnits: state.parsedUnits,
    officialPrimarySourceIds: state.officialPrimarySourceIds,
  });
  const invalidatedIds = new Set(request.invalidatedFindingIds);
  const reviewAudits = state.reviewAudits.filter(
    ({ findingId }) => !invalidatedIds.has(findingId),
  );
  const reviewActions = state.reviewActions.filter(
    ({ findingId }) => !invalidatedIds.has(findingId),
  );
  const currentFindings = replayReviewedFindings(
    version,
    reviewAudits,
    reviewActions,
    createSourceIndex({
      sources: state.project.sourceUnits,
      parsedUnits: state.parsedUnits,
      findings: version.findings,
      officialPrimarySourceIds: state.officialPrimarySourceIds,
      atomicRequirements,
    }),
  );
  return {
    ...state,
    project: ProjectSchema.parse({
      ...state.project,
      workflowStep: request.returnStep,
      findings: currentFindings,
    }),
    analysisVersions: [...state.analysisVersions, version],
    atomicRequirements,
    reviewAudits,
    reviewActions,
    ruleReviewAttestations: state.ruleReviewAttestations.filter(
      ({ findingId }) => !invalidatedIds.has(findingId),
    ),
    pendingReanalysis: null,
  };
};
