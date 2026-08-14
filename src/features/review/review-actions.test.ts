import { describe, expect, it } from "vitest";

import type { Project } from "../../domain/project";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import { resolveValidationResults } from "../evidence/review-attestation";
import {
  createSourceIndex,
  validateFinding,
} from "../evidence/validate-finding";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import {
  addHumanJudgment,
  attestValidationRule,
  cancelReanalysis,
  completeReanalysis,
  confirmFinding,
  createAnalysisVersion,
  deleteFinding,
  modifyFinding,
  returnForReanalysis,
  type ReviewWorkflowState,
} from "./review-actions";

const anchor = {
  sourceId: "REG-A",
  sourceType: "regulatory_text" as const,
  page: 1,
  article: "第一条",
  paragraphIndex: 0,
  quote: "商业银行应建立管理机制",
};

const project: Project = {
  projectId: "P1",
  projectName: "外规项目",
  workflowStep: "review",
  sourceUnits: [
    {
      sourceId: "REG-A",
      sourceType: "regulatory_text",
      title: "监管办法",
      content: "第一条 商业银行应建立管理机制。",
    },
  ],
  parsingCompleted: true,
  findings: [
    {
      findingId: "F1",
      category: "atomic_requirement",
      statement: "商业银行应建立管理机制",
      claimType: "regulatory_fact",
      sourceAnchors: [anchor],
      inferenceParents: [],
      reviewStatus: "unreviewed",
      requiredReview: true,
      revisionRecords: [],
    },
    {
      findingId: "F2",
      category: "institution_impact",
      statement: "可能需要完善内部流程",
      claimType: "ai_inference",
      sourceAnchors: [anchor],
      inferenceParents: ["F1"],
      reviewStatus: "unreviewed",
      requiredReview: true,
      revisionRecords: [],
    },
  ],
  qualityMetrics: {
    factCitationCoverage: 0,
    citationReverseCheckRate: 0,
    unsupportedFindingCount: 2,
    inferenceMarkingRate: 1,
    requiredReviewCompletionRate: 0,
  },
};

const parsedUnit: ParsedSourceUnit = {
  unitId: "REG-A-u1",
  sourceId: "REG-A",
  sourceType: "regulatory_text",
  page: 1,
  article: "第一条",
  paragraphIndex: 0,
  text: "第一条 商业银行应建立管理机制。",
  extractionMethod: "text_layer",
  confidence: 1,
};

const atomic: AtomicRequirement = {
  requirementId: "AR-1",
  findingId: "F1",
  subject: "商业银行",
  action: "建立",
  object: "管理机制",
  condition: null,
  frequency: null,
  deadline: null,
  strength: "应",
  responsibility: null,
  exceptions: null,
  sharedContext: null,
  missingFacts: [],
  sourceAnchors: [anchor],
  confidence: 1,
  manualVerificationRequired: true,
};

const state = (): ReviewWorkflowState => ({
  project: structuredClone(project),
  parsedUnits: [parsedUnit],
  atomicRequirements: [atomic],
  reviewAudits: [],
  ruleReviewAttestations: [],
  analysisVersions: [
    createAnalysisVersion({
      versionId: "V1",
      projectId: "P1",
      parentVersionHash: null,
      createdAt: "2026-08-15T00:00:00.000Z",
      reason: "首次分析",
      findings: structuredClone(project.findings),
      atomicRequirements: [atomic],
      replacedFindingIds: project.findings.map(({ findingId }) => findingId),
      sourceIds: ["REG-A"],
      scope: [
        "document_identity",
        "key_matters",
        "atomic_clauses",
        "institution_impact",
      ],
    }),
  ],
  pendingReanalysis: null,
});

const meta = {
  reviewer: "合规复核人",
  reason: "保持原文强度",
  reviewedAt: "2026-08-15T01:00:00.000Z",
};

describe("immutable review actions", () => {
  it("confirms without mutating the AI original", () => {
    const before = state();
    const updated = confirmFinding(before, "F1", meta);

    expect(before.project.findings[0].reviewStatus).toBe("unreviewed");
    expect(updated.project.findings[0]).toMatchObject({
      reviewStatus: "confirmed",
    });
    expect(updated.reviewAudits).toHaveLength(1);
    expect(updated.reviewAudits[0].beforeSnapshot.statement).toBe(
      "商业银行应建立管理机制",
    );
  });

  it("modifies the current finding twice and creates a valid chained audit", () => {
    const first = modifyFinding(
      state(),
      "F1",
      "商业银行必须建立管理机制",
      meta,
    );
    const second = modifyFinding(first, "F1", "商业银行必须建立健全管理机制", {
      ...meta,
      reviewedAt: "2026-08-15T02:00:00.000Z",
      reason: "补充健全要求",
    });

    expect(second.project.findings[0].statement).toBe(
      "商业银行必须建立健全管理机制",
    );
    expect(second.reviewAudits).toHaveLength(2);
    expect(second.reviewAudits[0].afterSnapshot).toEqual(
      second.reviewAudits[1].beforeSnapshot,
    );
    expect(second.reviewAudits[0].afterHash).toBe(
      second.reviewAudits[1].beforeHash,
    );
    expect(second.reviewAudits[0].beforeSnapshot.statement).toBe(
      "商业银行应建立管理机制",
    );
  });

  it("soft-deletes while preserving the finding and history", () => {
    const updated = deleteFinding(state(), "F1", meta);
    expect(updated.project.findings).toHaveLength(2);
    expect(updated.project.findings[0]).toMatchObject({
      statement: "商业银行应建立管理机制",
      reviewStatus: "deleted",
    });
    expect(updated.reviewAudits[0].beforeSnapshot.reviewStatus).toBe(
      "unreviewed",
    );
  });

  it("adds a human judgment only with real authorized evidence", () => {
    const updated = addHumanJudgment(state(), {
      findingId: "H1",
      statement: "本项目应由法律合规部门进一步确认适用范围",
      category: "human_review",
      anchor,
      reviewer: meta.reviewer,
      reason: "适用范围涉及机构事实",
      reviewedAt: meta.reviewedAt,
    });
    expect(updated.project.findings.at(-1)).toMatchObject({
      findingId: "H1",
      claimType: "human_judgment",
      reviewStatus: "confirmed",
      sourceAnchors: [anchor],
    });
    expect(() =>
      addHumanJudgment(state(), {
        findingId: "H2",
        statement: "没有依据的判断",
        category: "human_review",
        anchor: { ...anchor, quote: "并不存在的原文" },
        reviewer: meta.reviewer,
        reason: meta.reason,
        reviewedAt: meta.reviewedAt,
      }),
    ).toThrow(/依据/);
  });
});

describe("rule attestations and reanalysis", () => {
  it("appends current-bound confirmation/rejection and old attestations become stale after edits", () => {
    const initial = state();
    const validations = validateFinding(
      initial.project.findings[0],
      createSourceIndex({
        sources: initial.project.sourceUnits,
        parsedUnits: initial.parsedUnits,
        findings: initial.project.findings,
        atomicRequirements: initial.atomicRequirements,
      }),
    );
    expect(
      validations.some(({ status }) => status === "manual_review_required"),
    ).toBe(true);
    const rule = validations.find(
      ({ status }) => status === "manual_review_required",
    )!.rule;
    const attested = attestValidationRule(
      initial,
      "F1",
      rule,
      "confirmed",
      meta,
    );
    const resolved = resolveValidationResults(
      attested.project.findings[0],
      validations,
      attested.atomicRequirements,
      attested.ruleReviewAttestations,
    );
    expect(resolved.find((item) => item.rule === rule)?.resolution).toBe(
      "manual_confirmed",
    );

    const edited = modifyFinding(attested, "F1", "商业银行必须建立管理机制", {
      ...meta,
      reviewedAt: "2026-08-15T02:00:00.000Z",
    });
    const stale = resolveValidationResults(
      edited.project.findings[0],
      validateFinding(
        edited.project.findings[0],
        createSourceIndex({
          sources: edited.project.sourceUnits,
          parsedUnits: edited.parsedUnits,
          findings: edited.project.findings,
          atomicRequirements: edited.atomicRequirements,
        }),
      ),
      edited.atomicRequirements,
      edited.ruleReviewAttestations,
    );
    expect(
      stale.some(
        ({ resolution }) => resolution === "attestation_integrity_failed",
      ),
    ).toBe(true);
  });

  it("preserves the prior version, scopes invalidation, supports cancel, and returns a new version", () => {
    const reviewed = confirmFinding(state(), "F1", meta);
    const reviewedAndAttested = attestValidationRule(
      reviewed,
      "F1",
      "atomic_structure",
      "confirmed",
      { ...meta, reviewedAt: "2026-08-15T02:00:00.000Z" },
    );
    const requested = returnForReanalysis(reviewedAndAttested, {
      reason: "重新核对要求强度",
      targetFindingIds: ["F1"],
      sourceIds: ["REG-A"],
      scope: ["atomic_clauses"],
      requestedBy: "合规复核人",
      requestedAt: "2026-08-15T03:00:00.000Z",
    });
    expect(requested.project.workflowStep).toBe("analysis");
    expect(requested.analysisVersions).toHaveLength(1);
    expect(requested.pendingReanalysis?.targetFindingIds).toEqual(["F1"]);
    expect(requested.pendingReanalysis?.invalidatedFindingIds).toEqual([
      "F1",
      "F2",
    ]);
    expect(
      requested.project.findings.find(({ findingId }) => findingId === "F2"),
    ).toBeDefined();
    expect(cancelReanalysis(requested).project.workflowStep).toBe("review");

    const completed = completeReanalysis(
      requested,
      {
        findings: [
          {
            ...project.findings[0],
            statement: "商业银行应建立健全管理机制",
          },
        ],
        atomicRequirements: [{ ...atomic, object: "健全管理机制" }],
      },
      "2026-08-15T04:00:00.000Z",
    );
    expect(completed.pendingReanalysis).toBeNull();
    expect(completed.analysisVersions).toHaveLength(2);
    expect(
      completed.project.findings.find(({ findingId }) => findingId === "F1")
        ?.statement,
    ).toContain("健全");
    expect(
      completed.project.findings.find(({ findingId }) => findingId === "F2"),
    ).toBeUndefined();
    expect(
      completed.analysisVersions[0].findings.some(
        ({ findingId }) => findingId === "F2",
      ),
    ).toBe(true);
    expect(completed.atomicRequirements).toEqual([
      expect.objectContaining({ findingId: "F1", object: "健全管理机制" }),
    ]);
    expect(completed.reviewAudits).toHaveLength(0);
    expect(completed.ruleReviewAttestations).toHaveLength(0);
  });

  it("rejects incomplete or over-broad reanalysis scope", () => {
    expect(() =>
      returnForReanalysis(state(), {
        reason: "",
        targetFindingIds: ["F1"],
        sourceIds: ["REG-A"],
        scope: ["atomic_clauses"],
        requestedBy: "合规复核人",
        requestedAt: meta.reviewedAt,
      }),
    ).toThrow();
    expect(() =>
      returnForReanalysis(state(), {
        reason: "重新分析",
        targetFindingIds: ["F9"],
        sourceIds: ["REG-A"],
        scope: ["atomic_clauses"],
        requestedBy: "合规复核人",
        requestedAt: meta.reviewedAt,
      }),
    ).toThrow();
    expect(() =>
      returnForReanalysis(state(), {
        reason: "错误阶段",
        targetFindingIds: ["F1"],
        sourceIds: ["REG-A"],
        scope: ["key_matters"],
        requestedBy: "合规复核人",
        requestedAt: meta.reviewedAt,
      }),
    ).toThrow(/阶段|范围|覆盖/);
  });

  it("routes closed pending identity and atomic-conflict categories to their owning stages", () => {
    const base = state();
    const identityFinding = {
      ...base.project.findings[0],
      category: "pending_confirmation:document_identity:document_title",
      claimType: "pending_confirmation" as const,
    };
    const identity = {
      ...base,
      project: { ...base.project, findings: [identityFinding] },
      atomicRequirements: [],
    };
    expect(
      returnForReanalysis(identity, {
        reason: "重核文件身份",
        targetFindingIds: ["F1"],
        sourceIds: ["REG-A"],
        scope: ["document_identity"],
        requestedBy: "合规复核人",
        requestedAt: meta.reviewedAt,
      }).pendingReanalysis?.scope,
    ).toEqual(["document_identity"]);

    const conflictFinding = {
      ...identityFinding,
      category: "pending_confirmation:atomic_conflict",
    };
    expect(
      returnForReanalysis(
        {
          ...identity,
          project: { ...identity.project, findings: [conflictFinding] },
        },
        {
          reason: "重核原子冲突",
          targetFindingIds: ["F1"],
          sourceIds: ["REG-A"],
          scope: ["atomic_clauses"],
          requestedBy: "合规复核人",
          requestedAt: meta.reviewedAt,
        },
      ).pendingReanalysis?.scope,
    ).toEqual(["atomic_clauses"]);
  });
});
