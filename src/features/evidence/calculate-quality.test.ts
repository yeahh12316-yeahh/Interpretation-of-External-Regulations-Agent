import { describe, expect, test } from "vitest";

import type { Finding } from "../../domain/finding";
import type { Project } from "../../domain/project";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import { calculateQuality, canFinalize } from "./calculate-quality";

const source = {
  sourceId: "REG-1",
  sourceType: "regulatory_text" as const,
  title: "合成监管文件",
  content: "第十条 金融机构必须完成年度复核。",
};

const unit: ParsedSourceUnit = {
  sourceId: "REG-1",
  sourceType: "regulatory_text",
  page: 3,
  article: "第十条",
  paragraphIndex: 0,
  text: source.content,
  extractionMethod: "text_layer",
  confidence: 1,
};

const fact: Finding = {
  findingId: "FACT-1",
  category: "atomic_requirement",
  statement: "金融机构必须完成年度复核。",
  claimType: "regulatory_fact",
  sourceAnchors: [
    {
      sourceId: "REG-1",
      sourceType: "regulatory_text",
      page: 3,
      article: "第十条",
      paragraphIndex: 0,
      quote: "金融机构必须完成年度复核。",
    },
  ],
  inferenceParents: [],
  reviewStatus: "confirmed",
  requiredReview: true,
  revisionRecords: [],
};

const inference: Finding = {
  findingId: "INF-1",
  category: "institution_impact:process",
  statement: "可能需要评估流程维度的相关影响（AI推导）。",
  claimType: "ai_inference",
  sourceAnchors: fact.sourceAnchors,
  inferenceParents: ["FACT-1"],
  reviewStatus: "confirmed",
  requiredReview: true,
  revisionRecords: [],
};

const project = (findings: Finding[] = [fact, inference]): Project => ({
  projectId: "P1",
  projectName: "合成项目",
  workflowStep: "review",
  sourceUnits: [source],
  parsingCompleted: true,
  findings,
  qualityMetrics: {
    factCitationCoverage: 0,
    citationReverseCheckRate: 0,
    unsupportedFindingCount: 999,
    inferenceMarkingRate: 0,
    requiredReviewCompletionRate: 0,
  },
});

describe("calculateQuality", () => {
  test("derives all five gate metrics from current project evidence", () => {
    expect(calculateQuality(project(), [unit])).toEqual({
      factCitationCoverage: 1,
      citationReverseCheckRate: 1,
      unsupportedFindingCount: 0,
      inferenceMarkingRate: 1,
      requiredReviewCompletionRate: 1,
    });
    expect(canFinalize(project(), [unit])).toBe(true);
  });

  test("fails closed without parsed units even when stale project metrics look passing", () => {
    const metrics = calculateQuality(project(), undefined);

    expect(metrics.citationReverseCheckRate).toBe(0);
    expect(metrics.unsupportedFindingCount).toBeGreaterThan(0);
    expect(canFinalize(project(), undefined)).toBe(false);
  });

  test("requires parsing completion and complete parsed source coverage", () => {
    expect(canFinalize({ ...project(), parsingCompleted: false }, [unit])).toBe(
      false,
    );
    expect(
      canFinalize(
        {
          ...project(),
          sourceUnits: [
            source,
            {
              sourceId: "OFF-1",
              sourceType: "official_interpretation",
              title: "合成解读",
              content: "政策说明。",
            },
          ],
        },
        [unit],
      ),
    ).toBe(false);
  });

  test("blocks unresolved low-confidence OCR evidence", () => {
    expect(
      canFinalize(project(), [
        {
          ...unit,
          extractionMethod: "ocr",
          confidence: 0.55,
          reviewStatus: "unreviewed",
          lowConfidenceCharacters: [
            {
              text: "必",
              confidence: 0.55,
              boundingBox: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
      ]),
    ).toBe(false);
  });

  test("counts unsupported findings and incomplete mandatory reviews from actual records", () => {
    const unsupported: Finding = {
      ...fact,
      findingId: "FACT-2",
      sourceAnchors: [],
      reviewStatus: "unreviewed",
    };
    const metrics = calculateQuality(project([fact, unsupported]), [unit]);

    expect(metrics.factCitationCoverage).toBe(0.5);
    expect(metrics.unsupportedFindingCount).toBe(1);
    expect(metrics.requiredReviewCompletionRate).toBe(0.5);
    expect(canFinalize(project([fact, unsupported]), [unit])).toBe(false);
  });

  test("detects an institution-impact conclusion that is not marked as AI inference", () => {
    const unmarked = {
      ...fact,
      findingId: "BAD-IMPACT",
      category: "institution_impact:system",
    };

    expect(
      calculateQuality(project([fact, unmarked]), [unit]).inferenceMarkingRate,
    ).toBe(0);
    expect(canFinalize(project([fact, unmarked]), [unit])).toBe(false);
  });

  test("counts a changed mandatory number as unsupported", () => {
    const changedNumber = {
      ...fact,
      statement: "金融机构必须在2年内完成年度复核。",
    };

    expect(
      calculateQuality(project([changedNumber]), [unit])
        .unsupportedFindingCount,
    ).toBe(1);
  });

  test("keeps a confirmed pending conclusion unsupported until it is resolved or deleted", () => {
    const pending: Finding = {
      ...fact,
      findingId: "PENDING",
      category: "pending_confirmation:file_profile",
      statement: "效力状态待确认。",
      claimType: "pending_confirmation",
      sourceAnchors: [],
      reviewStatus: "confirmed",
    };

    const metrics = calculateQuality(project([fact, pending]), [unit]);
    expect(metrics.unsupportedFindingCount).toBe(1);
    expect(canFinalize(project([fact, pending]), [unit])).toBe(false);
  });
});
