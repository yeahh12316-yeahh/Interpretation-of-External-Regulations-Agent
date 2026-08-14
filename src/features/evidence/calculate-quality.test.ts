import { describe, expect, test } from "vitest";

import type { Finding } from "../../domain/finding";
import type { Project } from "../../domain/project";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import type { ParseResult } from "../parsing/parse-document";
import {
  calculateQuality,
  calculateSessionQuality,
  canFinalize,
  canFinalizeSession,
  parseOutcomeFromResult,
  reviewSnapshotHash,
  type ReviewAudit,
  type SourceParseOutcome,
} from "./calculate-quality";

const source = {
  sourceId: "REG-1",
  sourceType: "regulatory_text" as const,
  title: "合成监管文件",
  content:
    "第一页 合成首页。\n第二页 合成中页。\n第十条 金融机构必须完成年度复核。",
};

const pageUnits: ParsedSourceUnit[] = [
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 1,
    article: null,
    paragraphIndex: 0,
    text: "第一页 合成首页。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 2,
    article: null,
    paragraphIndex: 0,
    text: "第二页 合成中页。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 3,
    article: "第十条",
    paragraphIndex: 0,
    text: "第十条 金融机构必须完成年度复核。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
];
const unit = pageUnits[2];

const completeOutcome = {
  sourceId: "REG-1",
  sourceType: "regulatory_text" as const,
  pageCount: 3,
  successfulPages: [1, 2, 3],
  failedPages: [] as Array<{ page: number; error: string }>,
  failedPageCount: 0,
  parsedUnitCount: 3,
  ocrFailedPages: [] as number[],
  finalizationBlocked: false,
  extractionCoverage: 1,
  units: pageUnits,
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
    expect(calculateQuality(project(), pageUnits, [completeOutcome])).toEqual({
      factCitationCoverage: 1,
      citationReverseCheckRate: 1,
      unsupportedFindingCount: 0,
      inferenceMarkingRate: 1,
      requiredReviewCompletionRate: 1,
    });
    expect(canFinalize(project(), pageUnits, [completeOutcome])).toBe(true);
    const session = {
      project: project(),
      parsedUnits: pageUnits,
      parseOutcomes: [completeOutcome],
    };
    expect(calculateSessionQuality(session)).toEqual(
      calculateQuality(project(), pageUnits, [completeOutcome]),
    );
    expect(canFinalizeSession(session)).toBe(true);
  });

  test("adapts the Task 4 parse result into the strict evidence session boundary", () => {
    const parseResult: ParseResult = {
      fileHash: "synthetic-sha256",
      source,
      pageCount: 3,
      successfulPages: [1, 2, 3],
      failedPages: [],
      units: pageUnits,
      ocrReviews: [],
      anchors: fact.sourceAnchors,
      quality: {
        totalCharacters: source.content.length,
        parsedUnitCount: 3,
        failedPageCount: 0,
        lowTextPages: [],
        ocrFailedPages: [],
        finalizationBlocked: false,
        extractionCoverage: 1,
      },
    };

    expect(parseOutcomeFromResult(parseResult)).toEqual(completeOutcome);
  });

  test("requires a complete parse outcome for every source instead of trusting parsingCompleted", () => {
    const missingMetrics = calculateQuality(project(), pageUnits);
    expect(missingMetrics.citationReverseCheckRate).toBe(0);
    expect(missingMetrics.unsupportedFindingCount).toBeGreaterThan(0);
    expect(canFinalize(project(), pageUnits)).toBe(false);

    const spoofedPageSummary = {
      ...completeOutcome,
      parsedUnitCount: 1,
      units: [unit],
    };
    expect(canFinalize(project(), [unit], [spoofedPageSummary])).toBe(false);
    const forgedUnits = [
      { ...pageUnits[0], text: "第一页 伪造内容。" },
      ...pageUnits.slice(1),
    ];
    expect(
      canFinalize(project(), forgedUnits, [
        { ...completeOutcome, units: forgedUnits },
      ]),
    ).toBe(false);

    const invalidOutcomes = [
      {
        ...completeOutcome,
        successfulPages: [1, 3],
        failedPages: [{ page: 2, error: "合成页面失败" }],
      },
      { ...completeOutcome, ocrFailedPages: [2] },
      { ...completeOutcome, finalizationBlocked: true },
      { ...completeOutcome, successfulPages: [1, 2] },
      { ...completeOutcome, extractionCoverage: 0.5 },
      { ...completeOutcome, pageCount: 2, successfulPages: [1, 2] },
      { ...completeOutcome, pageCount: null, successfulPages: [] },
    ];
    for (const outcome of invalidOutcomes) {
      expect(canFinalize(project(), pageUnits, [outcome])).toBe(false);
    }
    const malformedImported = {
      sourceId: "REG-1",
      sourceType: "regulatory_text",
    } as SourceParseOutcome;
    expect(() =>
      canFinalize(project(), pageUnits, [malformedImported]),
    ).not.toThrow();
    expect(canFinalize(project(), pageUnits, [malformedImported])).toBe(false);
  });

  test("fails closed without parsed units even when stale project metrics look passing", () => {
    const metrics = calculateQuality(project(), undefined);

    expect(metrics.citationReverseCheckRate).toBe(0);
    expect(metrics.unsupportedFindingCount).toBeGreaterThan(0);
    expect(canFinalize(project(), undefined)).toBe(false);
  });

  test("requires parsing completion and complete parsed source coverage", () => {
    expect(
      canFinalize({ ...project(), parsingCompleted: false }, pageUnits, [
        completeOutcome,
      ]),
    ).toBe(false);
    const officialSource = {
      sourceId: "OFF-1",
      sourceType: "official_interpretation" as const,
      title: "合成解读",
      content: "政策说明。",
    };
    const officialUnit: ParsedSourceUnit = {
      sourceId: "OFF-1",
      sourceType: "official_interpretation",
      page: null,
      article: null,
      paragraphIndex: 0,
      text: "政策说明。",
      extractionMethod: "docx_xml",
      confidence: 1,
    };
    expect(
      canFinalize(
        {
          ...project(),
          sourceUnits: [source, officialSource],
        },
        [...pageUnits, officialUnit],
        [completeOutcome],
      ),
    ).toBe(false);
  });

  test("handles a regulatory DOCX source with explicit no-real-page semantics", () => {
    const docxSource = {
      sourceId: "REG-DOCX",
      sourceType: "regulatory_text" as const,
      title: "合成监管材料.docx",
      content: "机构必须建立管理制度。",
    };
    const docxUnit: ParsedSourceUnit = {
      sourceId: docxSource.sourceId,
      sourceType: docxSource.sourceType,
      page: null,
      article: null,
      paragraphIndex: 0,
      text: docxSource.content,
      extractionMethod: "docx_xml",
      confidence: 1,
    };
    const docxFinding: Finding = {
      ...fact,
      sourceAnchors: [
        {
          sourceId: docxSource.sourceId,
          sourceType: docxSource.sourceType,
          page: null,
          article: null,
          paragraphIndex: 0,
          quote: docxSource.content,
        },
      ],
      statement: docxSource.content,
    };
    const docxProject: Project = {
      ...project([docxFinding]),
      sourceUnits: [docxSource],
    };
    const docxOutcome: SourceParseOutcome = {
      sourceId: docxSource.sourceId,
      sourceType: docxSource.sourceType,
      pageCount: null,
      successfulPages: [],
      failedPages: [],
      failedPageCount: 0,
      parsedUnitCount: 1,
      ocrFailedPages: [],
      finalizationBlocked: false,
      extractionCoverage: 1,
      units: [docxUnit],
    };

    expect(canFinalize(docxProject, [docxUnit], [docxOutcome])).toBe(true);
    expect(
      canFinalize(docxProject, [{ ...docxUnit, page: 1 }], [docxOutcome]),
    ).toBe(false);
  });

  test("blocks unresolved low-confidence OCR evidence", () => {
    const ocrUnits: ParsedSourceUnit[] = [
      ...pageUnits.slice(0, 2),
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
    ];
    expect(
      canFinalize(project(), ocrUnits, [
        { ...completeOutcome, units: ocrUnits },
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
    const metrics = calculateQuality(project([fact, unsupported]), pageUnits, [
      completeOutcome,
    ]);

    expect(metrics.factCitationCoverage).toBe(0.5);
    expect(metrics.unsupportedFindingCount).toBe(1);
    expect(metrics.requiredReviewCompletionRate).toBe(0.5);
    expect(
      canFinalize(project([fact, unsupported]), pageUnits, [completeOutcome]),
    ).toBe(false);
  });

  test("never treats free-text revision history as authoritative for a modified review", () => {
    const modifiedWithoutHistory: Finding = {
      ...fact,
      reviewStatus: "modified",
      revisionRecords: [],
    };
    expect(
      calculateQuality(project([modifiedWithoutHistory]), pageUnits, [
        completeOutcome,
      ]).requiredReviewCompletionRate,
    ).toBe(0);
    expect(
      canFinalize(project([modifiedWithoutHistory]), pageUnits, [
        completeOutcome,
      ]),
    ).toBe(false);

    const malformedImported = {
      ...modifiedWithoutHistory,
      revisionRecords: [
        { revisedBy: "", revisedAt: "not-a-date", changeSummary: "" },
      ],
    } as Finding;
    expect(
      calculateQuality(project([malformedImported]), pageUnits, [
        completeOutcome,
      ]).requiredReviewCompletionRate,
    ).toBe(0);

    const mismatchedImported = {
      ...modifiedWithoutHistory,
      revisionRecords: [
        {
          revisedBy: "reviewer-1",
          revisedAt: "2026-08-14T08:00:00.000Z",
          changeSummary: "其他发现已完成复核。",
        },
      ],
    } as Finding;
    expect(
      calculateQuality(project([mismatchedImported]), pageUnits, [
        completeOutcome,
      ]).requiredReviewCompletionRate,
    ).toBe(0);

    const validModified: Finding = {
      ...modifiedWithoutHistory,
      revisionRecords: [
        {
          revisedBy: "reviewer-1",
          revisedAt: "2026-08-14T08:00:00.000Z",
          changeSummary: "将原结论修改为复核后的结论；原因：人工核对原文。",
        },
      ],
    };
    expect(
      calculateQuality(project([validModified]), pageUnits, [completeOutcome])
        .requiredReviewCompletionRate,
    ).toBe(0);
  });

  test("accepts only a structured review audit whose hashes and after snapshot match the finding", () => {
    const before: Finding = {
      ...fact,
      statement: "金融机构应当完成年度复核。",
      reviewStatus: "unreviewed",
      revisionRecords: [],
    };
    const after: Finding = {
      ...fact,
      reviewStatus: "modified",
      revisionRecords: [
        {
          revisedBy: "reviewer-1",
          revisedAt: "2026-08-14T08:00:00.000Z",
          changeSummary: "人工复核后修改。",
        },
      ],
    };
    const audit: ReviewAudit = {
      findingId: after.findingId,
      beforeSnapshot: before,
      beforeHash: reviewSnapshotHash(before),
      afterSnapshot: after,
      afterHash: reviewSnapshotHash(after),
      reason: "依据权威原文纠正模态强度。",
      reviewer: "reviewer-1",
      reviewedAt: "2026-08-14T08:00:00.000Z",
    };
    const session = {
      project: project([after]),
      parsedUnits: pageUnits,
      parseOutcomes: [completeOutcome],
      reviewAudits: [audit],
    };
    expect(calculateSessionQuality(session).requiredReviewCompletionRate).toBe(
      1,
    );
    expect(canFinalizeSession(session)).toBe(true);

    const wrongAfter = {
      ...audit,
      afterSnapshot: { ...after, statement: "被篡改的结论。" },
    };
    expect(
      calculateSessionQuality({ ...session, reviewAudits: [wrongAfter] })
        .requiredReviewCompletionRate,
    ).toBe(0);
    expect(
      calculateSessionQuality({
        ...session,
        reviewAudits: [{ ...audit, beforeHash: audit.afterHash }],
      }).requiredReviewCompletionRate,
    ).toBe(0);
  });

  test("detects an institution-impact conclusion that is not marked as AI inference", () => {
    const unmarked = {
      ...fact,
      findingId: "BAD-IMPACT",
      category: "institution_impact:system",
    };

    expect(
      calculateQuality(project([fact, unmarked]), pageUnits, [completeOutcome])
        .inferenceMarkingRate,
    ).toBe(0);
    expect(
      canFinalize(project([fact, unmarked]), pageUnits, [completeOutcome]),
    ).toBe(false);
  });

  test("counts a changed mandatory number as unsupported", () => {
    const changedNumber = {
      ...fact,
      statement: "金融机构必须在2年内完成年度复核。",
    };

    expect(
      calculateQuality(project([changedNumber]), pageUnits, [completeOutcome])
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

    const metrics = calculateQuality(project([fact, pending]), pageUnits, [
      completeOutcome,
    ]);
    expect(metrics.unsupportedFindingCount).toBe(1);
    expect(
      canFinalize(project([fact, pending]), pageUnits, [completeOutcome]),
    ).toBe(false);
  });
});
