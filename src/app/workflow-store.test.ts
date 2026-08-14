import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";

import { projectDatabase } from "../features/projects/db";
import {
  attestValidationRule,
  modifyFinding,
} from "../features/review/review-actions";
import {
  createEmptyWorkflowSession,
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
  await workflowSessionRepository.save(session);
  expect(await workflowSessionRepository.load("P-RESTORE")).toEqual(session);

  await expect(
    workflowSessionRepository.save({ ...session, apiKey: "secret" } as never),
  ).rejects.toThrow(/未授权|字段/);
  const raw = await projectDatabase.workflowSessions.get("P-RESTORE");
  expect(JSON.stringify(raw)).not.toContain("secret");
});

it("fails closed on malformed restored workflow state", async () => {
  await projectDatabase.workflowSessions.put({
    projectId: "BAD",
    session: { project: { projectId: "BAD" }, reviewAudits: "not-an-array" },
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
  };
  const meta = {
    reviewer: "复核人",
    reason: "逐字核对",
    reviewedAt: "2026-08-15T02:00:00.000Z",
  };
  const attested = attestValidationRule(
    session,
    "F1",
    "atomic_structure",
    "confirmed",
    meta,
  );
  const reviewed = modifyFinding(attested, "F1", "机构必须建立制度", {
    ...meta,
    reason: "调整强度",
    reviewedAt: "2026-08-15T03:00:00.000Z",
  });
  const restorable = {
    ...session,
    ...reviewed,
    lastSavedAt: "2026-08-15T04:00:00.000Z",
  };
  await workflowSessionRepository.save(restorable);
  expect(await workflowSessionRepository.load("P-AUDIT")).toEqual(restorable);

  const tampered = {
    ...structuredClone(restorable),
    reviewAudits: [
      { ...restorable.reviewAudits[0], afterHash: "fnv1a64:0000000000000000" },
    ],
  };
  await expect(workflowSessionRepository.save(tampered)).rejects.toThrow(
    /哈希链/,
  );
});
