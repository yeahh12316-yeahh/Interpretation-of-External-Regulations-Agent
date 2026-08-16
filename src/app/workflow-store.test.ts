import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";

import { projectDatabase } from "../features/projects/db";
import { evidenceDigest } from "../features/evidence/evidence-hash";
import { reviewSnapshotHash } from "../features/evidence/calculate-quality";
import {
  analysisVersionHash,
  addHumanJudgment,
  attestValidationRule,
  confirmFinding,
  createAnalysisVersion,
  createReanalysisProvenance,
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
        reanalysisProvenance: null,
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
    reanalysisProvenance: createReanalysisProvenance({
      requestId: evidenceDigest("rollback-test-request"),
      reason: "重分析",
      targetFindingIds: ["F1"],
      priorTargets: [
        {
          findingId: "F1",
          category: "atomic_requirement",
          claimType: "regulatory_fact",
          atomicKind: "atomic",
        },
      ],
      allowedSourceIds: ["REG-A"],
      allowedStages: ["atomic_clauses"],
      replacedDescendantIds: [],
      replacement: {
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
        inferenceRelationships: [],
        conflicts: [],
      },
      parentVersionHash: originalVersion.versionHash,
    }),
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

  const fakeHumanWithAction = {
    ...fakeHuman,
    findingId: "H-FAKE-ACTION",
    sourceAnchors: [
      { ...anchor, paragraphIndex: 99, quote: "伪造且无法定位的人工依据" },
    ],
    revisionRecords: [
      {
        revisedBy: "伪造人",
        revisedAt: "2026-08-15T03:30:00.000Z",
        changeSummary: "仅伪造 action 与 session hash",
      },
    ],
  };
  const fakeHumanHash = reviewSnapshotHash(fakeHumanWithAction);
  const fakeActionContent = {
    action: "add_human" as const,
    findingId: fakeHumanWithAction.findingId,
    afterHash: fakeHumanHash,
    reviewer: "伪造人",
    reason: "仅伪造 action 与 session hash",
    actedAt: "2026-08-15T03:30:00.000Z",
    purpose: "generic" as const,
  };
  const fakeAction = {
    ...fakeActionContent,
    actionId: evidenceDigest(fakeActionContent),
    beforeHash: null,
    afterSnapshot: fakeHumanWithAction,
  };
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: {
          ...saved.project,
          findings: [...saved.project.findings, fakeHumanWithAction],
        },
        reviewActions: [...saved.reviewActions, fakeAction],
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/人工|依据|定位|证据/);

  const fabricatedAnchor = {
    ...anchor,
    paragraphIndex: 77,
    quote: "伪造的历史版本引文",
  };
  const fabricatedFinding = {
    ...originalVersion.findings[0],
    sourceAnchors: [fabricatedAnchor],
  };
  const fabricatedAtomic = {
    ...originalVersion.atomicRequirements[0],
    sourceAnchors: [fabricatedAnchor],
  };
  const fabricatedVersion = createAnalysisVersion({
    ...originalVersionContent,
    findings: [fabricatedFinding],
    atomicRequirements: [fabricatedAtomic],
  });
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: {
          ...saved.project,
          findings: [fabricatedFinding],
        },
        atomicRequirements: [fabricatedAtomic],
        reviewAudits: [],
        reviewActions: [],
        ruleReviewAttestations: [],
        analysisVersions: [fabricatedVersion],
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/历史|定位|引文|锚点|ParseResult/);

  const recategorizedFinding = {
    ...originalVersion.findings[0],
    category: "key_matter:core_requirement",
  };
  const recategorizedV2 = createAnalysisVersion({
    ...originalVersionContent,
    versionId: "V2",
    parentVersionHash: originalVersion.versionHash,
    createdAt: "2026-08-15T03:45:00.000Z",
    reason: "未声明的重新分类",
    findings: [recategorizedFinding],
    atomicRequirements: [],
    reanalysisProvenance: createReanalysisProvenance({
      requestId: evidenceDigest("category-drift-request"),
      reason: "未声明的重新分类",
      targetFindingIds: ["F1"],
      priorTargets: [
        {
          findingId: "F1",
          category: "atomic_requirement",
          claimType: "regulatory_fact",
          atomicKind: "atomic",
        },
      ],
      allowedSourceIds: ["REG-A"],
      allowedStages: ["atomic_clauses"],
      replacedDescendantIds: [],
      replacement: {
        findings: [recategorizedFinding],
        atomicRequirements: [],
        inferenceRelationships: [],
        conflicts: [],
      },
      parentVersionHash: originalVersion.versionHash,
    }),
  });
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: { ...saved.project, findings: [recategorizedFinding] },
        atomicRequirements: [],
        reviewAudits: [],
        reviewActions: [],
        ruleReviewAttestations: [],
        analysisVersions: [originalVersion, recategorizedV2],
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/provenance|指令|类别|category|重分析/);

  const changedAtomicFinding = {
    ...originalVersion.findings[0],
    statement: "机构应建立健全制度",
  };
  const changedAtomicRequirement = {
    ...originalVersion.atomicRequirements[0],
    object: "健全制度",
  };
  const wrongStageV2 = createAnalysisVersion({
    ...originalVersionContent,
    versionId: "V2",
    parentVersionHash: originalVersion.versionHash,
    createdAt: "2026-08-15T03:46:00.000Z",
    reason: "错误阶段重新封签",
    findings: [changedAtomicFinding],
    atomicRequirements: [changedAtomicRequirement],
    scope: ["atomic_clauses", "key_matters"],
    reanalysisProvenance: createReanalysisProvenance({
      requestId: evidenceDigest("wrong-stage-request"),
      reason: "错误阶段重新封签",
      targetFindingIds: ["F1"],
      priorTargets: [
        {
          findingId: "F1",
          category: "atomic_requirement",
          claimType: "regulatory_fact",
          atomicKind: "atomic",
        },
      ],
      allowedSourceIds: ["REG-A"],
      allowedStages: ["key_matters"],
      replacedDescendantIds: [],
      replacement: {
        findings: [changedAtomicFinding],
        atomicRequirements: [changedAtomicRequirement],
        inferenceRelationships: [],
        conflicts: [],
      },
      parentVersionHash: originalVersion.versionHash,
    }),
  });
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: { ...saved.project, findings: [changedAtomicFinding] },
        atomicRequirements: [changedAtomicRequirement],
        reviewAudits: [],
        reviewActions: [],
        ruleReviewAttestations: [],
        analysisVersions: [originalVersion, wrongStageV2],
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/阶段|stage|provenance|授权/);

  const sourceB = {
    sourceId: "REG-B",
    sourceType: "regulatory_text" as const,
    title: "乙办法",
    content: "第二条 机构应报告事项",
  };
  const unitB = {
    unitId: "U-B",
    sourceId: "REG-B",
    sourceType: "regulatory_text" as const,
    page: null,
    article: "第二条",
    paragraphIndex: 0,
    text: sourceB.content,
    extractionMethod: "plain_text" as const,
    confidence: 1,
  };
  const parseResultB = {
    fileHash: "b".repeat(64),
    source: sourceB,
    pageCount: null,
    successfulPages: [],
    failedPages: [],
    units: [unitB],
    ocrReviews: [],
    anchors: buildAnchors([unitB]),
    quality: {
      totalCharacters: sourceB.content.length,
      parsedUnitCount: 1,
      failedPageCount: 0,
      lowTextPages: [],
      extractionCoverage: 1,
      ocrFailedPages: [],
      finalizationBlocked: false,
    },
  };
  const wrongPriorSourceV2 = createAnalysisVersion({
    ...originalVersionContent,
    versionId: "V2",
    parentVersionHash: originalVersion.versionHash,
    createdAt: "2026-08-15T03:47:00.000Z",
    reason: "错误来源重新封签",
    findings: [changedAtomicFinding],
    atomicRequirements: [changedAtomicRequirement],
    sourceIds: ["REG-A", "REG-B"],
    reanalysisProvenance: createReanalysisProvenance({
      requestId: evidenceDigest("wrong-source-request"),
      reason: "错误来源重新封签",
      targetFindingIds: ["F1"],
      priorTargets: [
        {
          findingId: "F1",
          category: "atomic_requirement",
          claimType: "regulatory_fact",
          atomicKind: "atomic",
        },
      ],
      allowedSourceIds: ["REG-B"],
      allowedStages: ["atomic_clauses"],
      replacedDescendantIds: [],
      replacement: {
        findings: [changedAtomicFinding],
        atomicRequirements: [changedAtomicRequirement],
        inferenceRelationships: [],
        conflicts: [],
      },
      parentVersionHash: originalVersion.versionHash,
    }),
  });
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: {
          ...saved.project,
          sourceUnits: [source, sourceB],
          findings: [changedAtomicFinding],
        },
        parseResults: [saved.parseResults[0], parseResultB],
        parsedUnits: [unit, unitB],
        atomicRequirements: [changedAtomicRequirement],
        reviewAudits: [],
        reviewActions: [],
        ruleReviewAttestations: [],
        analysisVersions: [originalVersion, wrongPriorSourceV2],
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/来源|source|provenance|授权/);

  const keyAnchorB = {
    sourceId: "REG-B",
    sourceType: "regulatory_text" as const,
    page: null,
    article: "第二条",
    paragraphIndex: 0,
    quote: "机构应报告事项",
  };
  const priorAtomicFindingB = {
    ...originalVersion.findings[0],
    statement: "机构应报告事项",
    sourceAnchors: [keyAnchorB],
  };
  const priorAtomicRequirementB = {
    ...originalVersion.atomicRequirements[0],
    action: "报告",
    object: "事项",
    sourceAnchors: [keyAnchorB],
  };
  const sourceScopedV1 = createAnalysisVersion({
    ...originalVersionContent,
    findings: [priorAtomicFindingB],
    atomicRequirements: [priorAtomicRequirementB],
    sourceIds: ["REG-A", "REG-B"],
  });
  const unauthorizedReplacementV2 = createAnalysisVersion({
    ...originalVersionContent,
    versionId: "V2",
    parentVersionHash: sourceScopedV1.versionHash,
    createdAt: "2026-08-15T03:47:30.000Z",
    reason: "替换工件来源越权重新封签",
    findings: [changedAtomicFinding],
    atomicRequirements: [changedAtomicRequirement],
    sourceIds: ["REG-A", "REG-B"],
    reanalysisProvenance: createReanalysisProvenance({
      requestId: evidenceDigest("replacement-source-request"),
      reason: "替换工件来源越权重新封签",
      targetFindingIds: ["F1"],
      priorTargets: [
        {
          findingId: "F1",
          category: "atomic_requirement",
          claimType: "regulatory_fact",
          atomicKind: "atomic",
        },
      ],
      allowedSourceIds: ["REG-B"],
      allowedStages: ["atomic_clauses"],
      replacedDescendantIds: [],
      replacement: {
        findings: [changedAtomicFinding],
        atomicRequirements: [changedAtomicRequirement],
        inferenceRelationships: [],
        conflicts: [],
      },
      parentVersionHash: sourceScopedV1.versionHash,
    }),
  });
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: {
          ...saved.project,
          sourceUnits: [source, sourceB],
          findings: [changedAtomicFinding],
        },
        parseResults: [saved.parseResults[0], parseResultB],
        parsedUnits: [unit, unitB],
        atomicRequirements: [changedAtomicRequirement],
        reviewAudits: [],
        reviewActions: [],
        ruleReviewAttestations: [],
        analysisVersions: [sourceScopedV1, unauthorizedReplacementV2],
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/替换|锚点|来源|source|provenance|授权/);

  const keyFindingB = {
    ...originalVersion.findings[0],
    findingId: "KEY-B",
    category: "key_matter:core_requirement",
    statement: "机构应报告事项",
    sourceAnchors: [keyAnchorB],
  };
  const mixedV1 = createAnalysisVersion({
    ...originalVersionContent,
    projectId: "P-MIXED-AUTH",
    findings: [originalVersion.findings[0], keyFindingB],
    atomicRequirements: [originalVersion.atomicRequirements[0]],
    replacedFindingIds: ["F1", "KEY-B"],
    sourceIds: ["REG-A", "REG-B"],
    scope: ["atomic_clauses", "key_matters"],
  });
  const changedKeyFindingB = {
    ...keyFindingB,
    statement: "机构应准确报告事项",
  };
  const mixedReplacement = {
    findings: [changedAtomicFinding, changedKeyFindingB],
    atomicRequirements: [changedAtomicRequirement],
    inferenceRelationships: [],
    conflicts: [],
  };
  const mixedV2 = createAnalysisVersion({
    ...originalVersionContent,
    projectId: "P-MIXED-AUTH",
    versionId: "V2",
    parentVersionHash: mixedV1.versionHash,
    createdAt: "2026-08-15T03:48:00.000Z",
    reason: "双来源双目标重分析",
    ...mixedReplacement,
    replacedFindingIds: ["F1", "KEY-B"],
    sourceIds: ["REG-A", "REG-B"],
    scope: ["atomic_clauses", "key_matters"],
    reanalysisProvenance: createReanalysisProvenance({
      requestId: evidenceDigest("mixed-source-request"),
      reason: "双来源双目标重分析",
      targetFindingIds: ["F1", "KEY-B"],
      priorTargets: [
        {
          findingId: "F1",
          category: "atomic_requirement",
          claimType: "regulatory_fact",
          atomicKind: "atomic",
        },
        {
          findingId: "KEY-B",
          category: "key_matter:core_requirement",
          claimType: "regulatory_fact",
          atomicKind: "non_atomic",
        },
      ],
      allowedSourceIds: ["REG-A", "REG-B"],
      allowedStages: ["atomic_clauses", "key_matters"],
      replacedDescendantIds: [],
      replacement: mixedReplacement,
      parentVersionHash: mixedV1.versionHash,
    }),
  });
  const mixedSession = sealWorkflowSession({
    ...saved,
    revision: 0,
    project: {
      ...saved.project,
      projectId: "P-MIXED-AUTH",
      sourceUnits: [source, sourceB],
      findings: [changedAtomicFinding, changedKeyFindingB],
    },
    parseResults: [saved.parseResults[0], parseResultB],
    parsedUnits: [unit, unitB],
    atomicRequirements: [changedAtomicRequirement],
    reviewAudits: [],
    reviewActions: [],
    ruleReviewAttestations: [],
    analysisVersions: [mixedV1, mixedV2],
  });
  await expect(
    workflowSessionRepository.save(mixedSession, 0),
  ).resolves.toEqual(
    expect.objectContaining({ project: mixedSession.project }),
  );

  const officialSource = {
    sourceId: "OFF-A",
    sourceType: "official_interpretation" as const,
    title: "官方说明",
    content: "第一条 官方解释材料",
  };
  const officialUnit = {
    unitId: "OFF-U1",
    sourceId: "OFF-A",
    sourceType: "official_interpretation" as const,
    page: null,
    article: "第一条",
    paragraphIndex: 0,
    text: officialSource.content,
    extractionMethod: "plain_text" as const,
    confidence: 1,
  };
  const officialAnchor = {
    sourceId: "OFF-A",
    sourceType: "official_interpretation" as const,
    page: null,
    article: "第一条",
    paragraphIndex: 0,
    quote: "官方解释材料",
  };
  const regulatoryFinding = {
    ...originalVersion.findings[0],
    findingId: "REG-F",
    category: "key_matter:core_requirement",
  };
  const officialFinding = {
    ...originalVersion.findings[0],
    findingId: "OFF-F",
    category: "official_context:implementation_guidance",
    statement: "官方解释材料",
    claimType: "official_explanation" as const,
    sourceAnchors: [officialAnchor],
    inferenceParents: ["REG-F"],
  };
  const missingConflictFinding = {
    ...originalVersion.findings[0],
    findingId: "CONFLICT-MISSING",
    category: "pending_confirmation:source_conflict",
    statement: "待确认：来源冲突",
    claimType: "pending_confirmation" as const,
    sourceAnchors: [anchor, officialAnchor],
    inferenceParents: ["REG-F", "OFF-F"],
  };
  const missingConflictContent = {
    versionId: "V1",
    projectId: saved.project.projectId,
    parentVersionHash: null,
    createdAt: "2026-08-15T03:50:00.000Z",
    reason: "伪造缺失冲突记录的历史版本",
    findings: [regulatoryFinding, officialFinding, missingConflictFinding],
    atomicRequirements: [],
    inferenceRelationships: [],
    conflicts: [],
    replacedFindingIds: ["REG-F", "OFF-F", "CONFLICT-MISSING"],
    sourceIds: ["REG-A", "OFF-A"],
    scope: ["document_identity", "key_matters"] as const,
    reanalysisProvenance: null,
  };
  const missingConflictVersion = {
    ...missingConflictContent,
    versionHash: analysisVersionHash(missingConflictContent),
  };
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        project: {
          ...saved.project,
          sourceUnits: [source, officialSource],
          findings: missingConflictContent.findings,
        },
        parseResults: [
          saved.parseResults[0],
          {
            fileHash: "b".repeat(64),
            source: officialSource,
            pageCount: null,
            successfulPages: [],
            failedPages: [],
            units: [officialUnit],
            ocrReviews: [],
            anchors: buildAnchors([officialUnit]),
            quality: {
              totalCharacters: officialSource.content.length,
              parsedUnitCount: 1,
              failedPageCount: 0,
              lowTextPages: [],
              extractionCoverage: 1,
              ocrFailedPages: [],
              finalizationBlocked: false,
            },
          },
        ],
        parsedUnits: [unit, officialUnit],
        atomicRequirements: [],
        reviewAudits: [],
        reviewActions: [],
        ruleReviewAttestations: [],
        analysisVersions: [missingConflictVersion],
        officialPrimarySourceIds: { "OFF-A": ["REG-A"] },
      }),
      saved.revision,
    ),
  ).rejects.toThrow(/历史|冲突|工件/);

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

  const humanState = addHumanJudgment(saved, {
    findingId: "H-RESEALED-CATEGORY",
    statement: "优先完善制度",
    purpose: "recommended_action",
    anchor,
    reviewer: "复核人",
    reason: "验证用途闭合",
    reviewedAt: "2026-08-15T04:30:00.000Z",
  });
  const humanAction = humanState.reviewActions.at(-1);
  if (humanAction?.action !== "add_human") throw new Error("fixture action");
  const illegalHuman = {
    ...humanAction.afterSnapshot,
    category: "recommended_action:unapproved",
  };
  const illegalHash = reviewSnapshotHash(illegalHuman);
  const illegalActionContent = {
    action: "add_human" as const,
    findingId: humanAction.findingId,
    afterHash: illegalHash,
    reviewer: humanAction.reviewer,
    reason: humanAction.reason,
    actedAt: humanAction.actedAt,
    purpose: humanAction.purpose,
  };
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        ...humanState,
        revision: saved.revision,
        project: {
          ...humanState.project,
          findings: humanState.project.findings.map((finding) =>
            finding.findingId === humanAction.findingId
              ? illegalHuman
              : finding,
          ),
        },
        reviewActions: humanState.reviewActions.map((action) =>
          action === humanAction
            ? {
                ...humanAction,
                actionId: evidenceDigest(illegalActionContent),
                afterSnapshot: illegalHuman,
                afterHash: illegalHash,
              }
            : action,
        ),
      }),
      saved.revision,
    ),
  ).rejects.toThrow();

  const legacyActionId = evidenceDigest({
    action: "add_human",
    findingId: humanAction.findingId,
    afterHash: humanAction.afterHash,
    reviewer: humanAction.reviewer,
    reason: humanAction.reason,
    actedAt: humanAction.actedAt,
  });
  await expect(
    workflowSessionRepository.save(
      sealWorkflowSession({
        ...saved,
        ...humanState,
        revision: saved.revision,
        reviewActions: humanState.reviewActions.map((action) => {
          if (action !== humanAction) return action;
          const { purpose: _purpose, ...missingPurposeAction } = humanAction;
          return { ...missingPurposeAction, actionId: legacyActionId };
        }),
      } as never),
      saved.revision,
    ),
  ).rejects.toThrow(/工作流|用途|字段/);

  const legacyUnsealed = {
    ...saved,
    ...humanState,
    sessionVersion: 1 as const,
    revision: saved.revision,
    reviewActions: humanState.reviewActions.map((action) => {
      if (action !== humanAction) return action;
      const { purpose: _purpose, ...legacyAction } = humanAction;
      return { ...legacyAction, actionId: legacyActionId };
    }),
  };
  const { contentHash: _legacyHash, ...legacyContent } = legacyUnsealed;
  const legacySession = {
    ...legacyUnsealed,
    contentHash: evidenceDigest(legacyContent),
  };
  const downgradedIllegalActionContent = {
    action: "add_human" as const,
    findingId: humanAction.findingId,
    afterHash: illegalHash,
    reviewer: humanAction.reviewer,
    reason: humanAction.reason,
    actedAt: humanAction.actedAt,
  };
  const downgradedIllegalUnsealed = {
    ...legacyUnsealed,
    project: {
      ...legacyUnsealed.project,
      findings: legacyUnsealed.project.findings.map((finding) =>
        finding.findingId === humanAction.findingId ? illegalHuman : finding,
      ),
    },
    reviewActions: legacyUnsealed.reviewActions.map((action) =>
      action.findingId === humanAction.findingId
        ? {
            ...action,
            actionId: evidenceDigest(downgradedIllegalActionContent),
            afterSnapshot: illegalHuman,
            afterHash: illegalHash,
          }
        : action,
    ),
  };
  const { contentHash: _downgradedIllegalHash, ...downgradedIllegalContent } =
    downgradedIllegalUnsealed;
  await projectDatabase.workflowSessions.put({
    projectId: legacySession.project.projectId,
    session: {
      ...downgradedIllegalUnsealed,
      contentHash: evidenceDigest(downgradedIllegalContent),
    },
    revision: legacySession.revision,
    updatedAt: "2026-08-15T04:30:30.000Z",
  });
  await expect(
    workflowSessionRepository.load(legacySession.project.projectId),
  ).rejects.toThrow(/工作流|人工判断|类别|字段/);

  await projectDatabase.workflowSessions.put({
    projectId: legacySession.project.projectId,
    session: legacySession,
    revision: legacySession.revision,
    updatedAt: "2026-08-15T04:31:00.000Z",
  });
  await expect(
    workflowSessionRepository.load(legacySession.project.projectId),
  ).resolves.toMatchObject({
    sessionVersion: 2,
    project: {
      findings: expect.arrayContaining([
        expect.objectContaining({
          findingId: humanAction.findingId,
          category: "recommended_action:priority",
          claimType: "human_judgment",
        }),
      ]),
    },
    reviewActions: expect.arrayContaining([
      expect.objectContaining({
        action: "add_human",
        findingId: humanAction.findingId,
        purpose: "recommended_action",
      }),
    ]),
  });
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
