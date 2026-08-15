import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";

import { projectDatabase } from "../features/projects/db";
import {
  analysisVersionHash,
  attestValidationRule,
  confirmFinding,
  createAnalysisVersion,
  modifyFinding,
  returnForReanalysis,
} from "../features/review/review-actions";
import { buildAnchors } from "../features/parsing/build-anchors";
import {
  createEmptyWorkflowSession,
  sealWorkflowSession,
  workflowSessionRepository,
} from "./workflow-store";

beforeEach(async () => {
  await projectDatabase.workflowSessions.clear();
});

it("persists and restores workflow state without accepting API keys", async () => {
  const session = {
    ...createEmptyWorkflowSession("P-RESTORE", "恢复项目"),
    lastSavedAt: "2026-08-15T01:00:00.000Z",
  };
  const saved = await workflowSessionRepository.save(session, 0);
  expect(saved.revision).toBe(1);
  expect(await workflowSessionRepository.load("P-RESTORE")).toEqual(saved);

  await expect(
    workflowSessionRepository.save(
      { ...session, apiKey: "secret" } as never,
      0,
    ),
  ).rejects.toThrow(/未授权|字段/);
  const raw = await projectDatabase.workflowSessions.get("P-RESTORE");
  expect(JSON.stringify(raw)).not.toContain("secret");
});

it("fails closed on malformed restored workflow state", async () => {
  await projectDatabase.workflowSessions.put({
    projectId: "BAD",
    session: { project: { projectId: "BAD" }, reviewAudits: "not-an-array" },
    revision: 1,
    updatedAt: "2026-08-15T01:00:00.000Z",
  });
  await expect(workflowSessionRepository.load("BAD")).rejects.toThrow(/工作流/);
});

it("restores current findings with append-only audit and attestation records and rejects tampering", async () => {
  const anchor = {
    sourceId: "REG-A",
    sourceType: "regulatory_text" as const,
    page: null,
    article: "第一条",
    paragraphIndex: 0,
    quote: "机构应建立制度",
  };
  const source = {
    sourceId: "REG-A",
    sourceType: "regulatory_text" as const,
    title: "办法",
    content: "第一条 机构应建立制度",
  };
  const unit = {
    unitId: "U1",
    sourceId: "REG-A",
    sourceType: "regulatory_text" as const,
    page: null,
    article: "第一条",
    paragraphIndex: 0,
    text: "第一条 机构应建立制度",
    extractionMethod: "plain_text" as const,
    confidence: 1,
  };
  const base = createEmptyWorkflowSession("P-AUDIT", "审计项目");
  const session = {
    ...base,
    project: {
      ...base.project,
      workflowStep: "review" as const,
      sourceUnits: [source],
      parsingCompleted: true,
      findings: [
        {
          findingId: "F1",
          category: "atomic_requirement",
          statement: "机构应建立制度",
          claimType: "regulatory_fact" as const,
          sourceAnchors: [anchor],
          inferenceParents: [],
          reviewStatus: "unreviewed" as const,
          requiredReview: true,
          revisionRecords: [],
        },
      ],
    },
    parsedUnits: [unit],
    parseResults: [
      {
        fileHash: "a".repeat(64),
        source,
        pageCount: null,
        successfulPages: [],
        failedPages: [],
        units: [unit],
        ocrReviews: [],
        anchors: buildAnchors([unit]),
        quality: {
          totalCharacters: source.content.length,
          parsedUnitCount: 1,
          failedPageCount: 0,
          lowTextPages: [],
          extractionCoverage: 1,
          ocrFailedPages: [],
          finalizationBlocked: false,
        },
      },
    ],
    atomicRequirements: [
      {
        requirementId: "AR1",
        findingId: "F1",
        subject: "机构",
        action: "建立",
        object: "制度",
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
      },
    ],
    analysisVersions: [
      createAnalysisVersion({
        versionId: "V1",
        projectId: "P-AUDIT",
        parentVersionHash: null,
        createdAt: "2026-08-15T01:00:00.000Z",
        reason: "首次分析",
        findings: [
          {
            findingId: "F1",
            category: "atomic_requirement",
            statement: "机构应建立制度",
            claimType: "regulatory_fact",
            sourceAnchors: [anchor],
            inferenceParents: [],
            reviewStatus: "unreviewed",
            requiredReview: true,
            revisionRecords: [],
          },
        ],
        atomicRequirements: [
          {
            requirementId: "AR1",
            findingId: "F1",
            subject: "机构",
            action: "建立",
            object: "制度",
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
          },
        ],
        inferenceRelationships: [],
        conflicts: [],
        replacedFindingIds: ["F1"],
        sourceIds: ["REG-A"],
        scope: ["atomic_clauses"],
      }),
    ],
  };
  const meta = {
    reviewer: "复核人",
    reason: "逐字核对",
    reviewedAt: "2026-08-15T02:00:00.000Z",
  };
  const reviewed = confirmFinding(session, "F1", meta);
  const attested = attestValidationRule(
    reviewed,
    "F1",
    "atomic_structure",
    "confirmed",
    meta,
  );
  const restorable = {
    ...session,
    ...attested,
    lastSavedAt: "2026-08-15T04:00:00.000Z",
  };
  const saved = await workflowSessionRepository.save(restorable, 0);
  expect(await workflowSessionRepository.load("P-AUDIT")).toEqual(saved);

  const tampered = {
    ...structuredClone(restorable),
    reviewAudits: [
      { ...restorable.reviewAudits[0], afterHash: "fnv1a64:0000000000000000" },
    ],
  };
  await expect(workflowSessionRepository.save(tampered, 0)).rejects.toThrow(
    /审计|哈希|派生/,
  );

  const originalVersion = saved.analysisVersions[0];
  const { versionHash: _originalVersionHash, ...missingAtomicVersionContent } =
    { ...originalVersion, atomicRequirements: [] };
  const missingAtomicVersion = {
    ...missingAtomicVersionContent,
    versionHash: analysisVersionHash(missingAtomicVersionContent),
  };
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        analysisVersions: [missingAtomicVersion],
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/分析版本|工件/);

  const { versionHash: _v1Hash, ...originalVersionContent } = originalVersion;
  const v2 = createAnalysisVersion({
    ...originalVersionContent,
    versionId: "V2",
    parentVersionHash: originalVersion.versionHash,
    createdAt: "2026-08-15T03:00:00.000Z",
    reason: "重分析",
    findings: [
      {
        ...originalVersion.findings[0],
        statement: "机构应建立健全制度",
      },
    ],
    atomicRequirements: [
      {
        ...originalVersion.atomicRequirements[0],
        object: "健全制度",
      },
    ],
  });
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: {
          ...saved.project,
          findings: [...structuredClone(originalVersion.findings)],
        },
        atomicRequirements: structuredClone(originalVersion.atomicRequirements),
        reviewAudits: [],
        reviewActions: [],
        ruleReviewAttestations: [],
        analysisVersions: [originalVersion, v2],
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/最新分析版本|派生/);

  const fakeHuman = {
    findingId: "H-FAKE",
    category: "human_review",
    statement: "伪造人工判断",
    claimType: "human_judgment" as const,
    sourceAnchors: [anchor],
    inferenceParents: [],
    reviewStatus: "confirmed" as const,
    requiredReview: true,
    revisionRecords: [
      {
        revisedBy: "伪造人",
        revisedAt: "2026-08-15T03:30:00.000Z",
        changeSummary: "仅伪造 revisionRecords",
      },
    ],
  };
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: {
          ...saved.project,
          findings: [...saved.project.findings, fakeHuman],
        },
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/ReviewAction|派生|复核动作/);

  const pending = returnForReanalysis(
    { ...saved, ...reviewed },
    {
      reason: "重核强度",
      targetFindingIds: ["F1"],
      sourceIds: ["REG-A"],
      scope: ["atomic_clauses"],
      requestedBy: "复核人",
      requestedAt: "2026-08-15T03:00:00.000Z",
    },
  );
  const stalePending = modifyFinding(pending, "F1", "机构应建立并维护制度", {
    reviewer: "复核人",
    reason: "请求发出后又修改",
    reviewedAt: "2026-08-15T03:10:00.000Z",
  });
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        ...stalePending,
        revision: saved.revision,
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/重分析|摘要|目标/);

  await expect(
    workflowSessionRepository.save(
      {
        ...saved,
        analysisVersions: [
          {
            ...saved.analysisVersions[0],
            versionHash: "fnv1a64:0000000000000000",
          },
        ],
      },
      saved.revision,
    ),
  ).rejects.toThrow(/分析版本/);

  await expect(
    workflowSessionRepository.save(
      {
        ...saved,
        atomicRequirements: [
          { ...saved.atomicRequirements[0], object: "被替换的制度" },
        ],
      },
      saved.revision,
    ),
  ).rejects.toThrow(/人工规则确认|原子工件|派生/);
});

it("uses compare-and-swap revisions and rejects stale concurrent saves", async () => {
  const initial = createEmptyWorkflowSession("P-CAS", "并发项目");
  const saved = await workflowSessionRepository.save(initial, 0);
  const first = workflowSessionRepository.save(
    { ...saved, lastSavedAt: "2026-08-15T05:00:00.000Z" },
    1,
  );
  const stale = workflowSessionRepository.save(
    { ...saved, lastSavedAt: "2026-08-15T06:00:00.000Z" },
    1,
  );
  const outcomes = await Promise.allSettled([first, stale]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
    1,
  );
});

it("rejects a legitimate-shaped restored session whose source content or hash was tampered", async () => {
  const initial = createEmptyWorkflowSession("P-HASH", "完整性项目");
  const saved = await workflowSessionRepository.save(initial, 0);
  const raw = await projectDatabase.workflowSessions.get("P-HASH");
  await projectDatabase.workflowSessions.put({
    ...raw!,
    session: { ...saved, project: { ...saved.project, projectName: "被篡改" } },
  });
  await expect(workflowSessionRepository.load("P-HASH")).rejects.toThrow(
    /哈希/,
  );

  const resealed = sealWorkflowSession({
    ...saved,
    project: {
      ...saved.project,
      sourceUnits: [
        {
          sourceId: "REG-X",
          sourceType: "regulatory_text",
          title: "伪造",
          content: "伪造内容",
        },
      ],
      parsingCompleted: true,
    },
  });
  await projectDatabase.workflowSessions.put({
    projectId: "P-HASH",
    session: resealed,
    revision: resealed.revision,
    updatedAt: "2026-08-15T07:00:00.000Z",
  });
  await expect(workflowSessionRepository.load("P-HASH")).rejects.toThrow(
    /解析|来源|ParseResult/,
  );
});

it("persists only strict official-interpretation to regulatory-primary pairings", async () => {
  const empty = createEmptyWorkflowSession("P-OFFICIAL", "配对项目");
  const sources = [
    {
      sourceId: "REG-A",
      sourceType: "regulatory_text" as const,
      title: "办法",
      content: "原文",
    },
    {
      sourceId: "OFF-A",
      sourceType: "official_interpretation" as const,
      title: "解读",
      content: "说明",
    },
  ];
  const base = {
    ...empty,
    project: { ...empty.project, sourceUnits: sources },
  };
  await expect(
    workflowSessionRepository.save(
      { ...base, officialPrimarySourceIds: { "OFF-A": ["OFF-A"] } },
      0,
    ),
  ).rejects.toThrow(/配对/);
  const saved = await workflowSessionRepository.save(
    { ...base, officialPrimarySourceIds: { "OFF-A": ["REG-A"] } },
    0,
  );
  expect(saved.officialPrimarySourceIds).toEqual({ "OFF-A": ["REG-A"] });
});
