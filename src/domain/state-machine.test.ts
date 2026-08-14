import { describe, expect, test } from "vitest";

import type { Project } from "./project";
import { canTransition } from "./state-machine";

const passingQualityMetrics = {
  factCitationCoverage: 1,
  citationReverseCheckRate: 1,
  unsupportedFindingCount: 0,
  inferenceMarkingRate: 1,
  requiredReviewCompletionRate: 1,
};

const regulatorySource = {
  sourceId: "SRC-REG-1",
  sourceType: "regulatory_text" as const,
  title: "监管文件",
  content: "金融机构应当建立相关制度。",
};

const emptyProject: Project = {
  projectId: "P1",
  projectName: "外规解读",
  workflowStep: "intake",
  sourceUnits: [],
  parsingCompleted: false,
  findings: [],
  qualityMetrics: {
    factCitationCoverage: 0,
    citationReverseCheckRate: 0,
    unsupportedFindingCount: 1,
    inferenceMarkingRate: 0,
    requiredReviewCompletionRate: 0,
  },
};

describe("canTransition", () => {
  test("blocks analysis before file parsing is complete", () => {
    expect(canTransition(emptyProject, "analysis")).toEqual({
      allowed: false,
      reason: "请先完成文件解析",
    });
  });

  test("blocks analysis when parsing is claimed complete without a regulatory source", () => {
    expect(
      canTransition({ ...emptyProject, parsingCompleted: true }, "analysis"),
    ).toEqual({
      allowed: false,
      reason: "请先上传监管文件",
    });
  });

  test("requires a regulatory file before parsing", () => {
    expect(canTransition(emptyProject, "parsing")).toEqual({
      allowed: false,
      reason: "请先上传监管文件",
    });
  });

  test("blocks review until analysis produces findings", () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          sourceUnits: [regulatorySource],
          parsingCompleted: true,
          workflowStep: "analysis",
        },
        "review",
      ),
    ).toEqual({ allowed: false, reason: "请先完成分析" });
  });

  test("blocks review until the regulatory file is parsed even when findings exist", () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          findings: [
            {
              findingId: "F1",
              category: "治理",
              statement: "应建立制度",
              claimType: "regulatory_fact",
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: "confirmed",
              requiredReview: true,
              revisionRecords: [],
            },
          ],
        },
        "review",
      ),
    ).toEqual({ allowed: false, reason: "请先上传监管文件" });
  });

  test("blocks report until required reviews are completed", () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          sourceUnits: [regulatorySource],
          parsingCompleted: true,
          workflowStep: "review",
          findings: [
            {
              findingId: "F1",
              category: "治理",
              statement: "应建立制度",
              claimType: "regulatory_fact",
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: "unreviewed",
              requiredReview: true,
              revisionRecords: [],
            },
          ],
        },
        "report",
        { evidenceReady: true },
      ),
    ).toEqual({ allowed: false, reason: "请先完成必审事项复核" });
  });

  test("blocks report until the quality gate passes", () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          sourceUnits: [regulatorySource],
          parsingCompleted: true,
          workflowStep: "review",
          findings: [
            {
              findingId: "F1",
              category: "治理",
              statement: "应建立制度",
              claimType: "regulatory_fact",
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: "confirmed",
              requiredReview: true,
              revisionRecords: [],
            },
          ],
        },
        "report",
        { evidenceReady: true },
      ),
    ).toEqual({ allowed: false, reason: "请先通过质量门槛" });
  });

  test("allows report when evidence review and quality gates are met", () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          sourceUnits: [regulatorySource],
          parsingCompleted: true,
          workflowStep: "review",
          qualityMetrics: passingQualityMetrics,
          findings: [
            {
              findingId: "F1",
              category: "治理",
              statement: "应建立制度",
              claimType: "regulatory_fact",
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: "modified",
              requiredReview: true,
              revisionRecords: [],
            },
          ],
        },
        "report",
        { evidenceReady: true },
      ),
    ).toEqual({ allowed: true });
  });

  test("counts a required finding with properly recorded deletion as reviewed", () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          sourceUnits: [regulatorySource],
          parsingCompleted: true,
          workflowStep: "review",
          qualityMetrics: passingQualityMetrics,
          findings: [
            {
              findingId: "F1",
              category: "治理",
              statement: "历史保留的已删结论",
              claimType: "pending_confirmation",
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: "deleted",
              requiredReview: true,
              revisionRecords: [
                {
                  revisedBy: "reviewer",
                  revisedAt: "2026-08-14T08:00:00.000Z",
                  changeSummary: "人工复核后删除",
                },
              ],
            },
          ],
        },
        "report",
        { evidenceReady: true },
      ),
    ).toEqual({ allowed: true });
  });

  test("does not allow a passing-looking report while any deterministic quality metric fails", () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          sourceUnits: [regulatorySource],
          parsingCompleted: true,
          workflowStep: "review",
          qualityMetrics: {
            ...passingQualityMetrics,
            unsupportedFindingCount: 1,
          },
          findings: [
            {
              findingId: "F1",
              category: "治理",
              statement: "应建立制度",
              claimType: "regulatory_fact",
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: "confirmed",
              requiredReview: true,
              revisionRecords: [],
            },
          ],
        },
        "report",
        { evidenceReady: true },
      ),
    ).toEqual({ allowed: false, reason: "请先通过质量门槛" });
  });
});

it("fails closed when authoritative parse or evidence context is missing/blocked", () => {
  const ready: Project = {
    ...emptyProject,
    workflowStep: "parsing",
    sourceUnits: [regulatorySource],
    parsingCompleted: true,
  };
  expect(canTransition(ready, "analysis", { parsingReady: false })).toEqual({
    allowed: false,
    reason: "解析或 OCR 质量未通过",
  });
  expect(canTransition(ready, "analysis")).toEqual({
    allowed: false,
    reason: "缺少权威解析与 OCR 校验上下文",
  });
  expect(canTransition(ready, "analysis", { parsingReady: true }).allowed).toBe(
    true,
  );

  const reviewed: Project = {
    ...ready,
    workflowStep: "review",
    findings: [
      {
        findingId: "F1",
        category: "治理",
        statement: "应建立制度",
        claimType: "regulatory_fact",
        sourceAnchors: [],
        inferenceParents: [],
        reviewStatus: "confirmed",
        requiredReview: true,
        revisionRecords: [],
      },
    ],
    qualityMetrics: passingQualityMetrics,
  };
  expect(
    canTransition(reviewed, "report", {
      parsingReady: true,
      evidenceReady: false,
    }),
  ).toEqual({
    allowed: false,
    reason: "证据校验或人工规则复核未通过",
  });
  expect(canTransition(reviewed, "report", { parsingReady: true })).toEqual({
    allowed: false,
    reason: "缺少证据质量与人工规则复核上下文",
  });
  expect(
    canTransition(reviewed, "review", {
      parsingReady: true,
      reanalysisPending: true,
    }),
  ).toEqual({
    allowed: false,
    reason: "定向重分析尚未完成",
  });
  expect(canTransition(reviewed, "intake").allowed).toBe(true);
  expect(canTransition(reviewed, "parsing").allowed).toBe(true);
});
