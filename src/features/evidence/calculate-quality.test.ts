import { describe, expect, test } from "vitest";

import type { Finding } from "../../domain/finding";
import type { Project } from "../../domain/project";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import { buildAnchors, type ParsedSourceUnit } from "../parsing/build-anchors";
import type { ParseResult } from "../parsing/parse-document";
import type { OcrPageResult } from "../parsing/ocr/ocr-pipeline";
import {
  calculateQuality,
  calculateSessionQuality,
  canFinalize,
  canFinalizeSession,
  parseOutcomeFromResult,
  reviewSnapshotHash,
  ruleReviewBinding,
  type ReviewAudit,
  type SourceParseOutcome,
} from "./calculate-quality";

const source = {
  sourceId: "REG-1",
  sourceType: "regulatory_text" as const,
  title: "合成监管文件",
  content:
    "第一页 合成首页。\n\n第二页 合成中页。\n\n第十条 金融机构必须完成年度复核。",
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

const completeParseResult: ParseResult = {
  fileHash: "a".repeat(64),
  source,
  pageCount: 3,
  successfulPages: [1, 2, 3],
  failedPages: [],
  units: pageUnits,
  ocrReviews: [],
  anchors: buildAnchors(pageUnits),
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
const completeOutcome = parseOutcomeFromResult(completeParseResult);

const fact: Finding = {
  findingId: "FACT-1",
  category: "key_matter:core_requirement",
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
      automaticValidationRuleCount: 22,
      manualConfirmedValidationRuleCount: 0,
      manualReviewPendingRuleCount: 0,
      manualRejectedValidationRuleCount: 0,
      failedValidationRuleCount: 0,
      attestationIntegrityFailureCount: 0,
    });
    expect(canFinalize(project(), pageUnits, [completeOutcome])).toBe(true);
    const session = { project: project(), parseResults: [completeParseResult] };
    expect(calculateSessionQuality(session)).toEqual(
      calculateQuality(project(), pageUnits, [completeOutcome]),
    );
    expect(canFinalizeSession(session)).toBe(true);
  });

  test("requires current rule-bound attestations before ambiguous atomic evidence can finalize", () => {
    const atomicSource = {
      sourceId: "REG-ATTEST",
      sourceType: "regulatory_text" as const,
      title: "合成人工确认材料",
      content: "机构应建立制度。",
    };
    const atomicUnit: ParsedSourceUnit = {
      sourceId: atomicSource.sourceId,
      sourceType: atomicSource.sourceType,
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: atomicSource.content,
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const atomicFinding: Finding = {
      ...fact,
      findingId: "FACT-ATTEST",
      category: "atomic_requirement",
      statement: atomicSource.content,
      sourceAnchors: [
        {
          sourceId: atomicSource.sourceId,
          sourceType: atomicSource.sourceType,
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: atomicSource.content,
        },
      ],
    };
    const atomicRequirement: AtomicRequirement = {
      requirementId: "AR-ATTEST",
      findingId: atomicFinding.findingId,
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
      sourceAnchors: atomicFinding.sourceAnchors,
      confidence: 1,
      manualVerificationRequired: false,
    };
    const atomicProject: Project = {
      ...project([atomicFinding]),
      sourceUnits: [atomicSource],
    };
    const atomicResult: ParseResult = {
      ...completeParseResult,
      fileHash: "f".repeat(64),
      source: atomicSource,
      pageCount: 1,
      successfulPages: [1],
      units: [atomicUnit],
      anchors: buildAnchors([atomicUnit]),
      quality: {
        ...completeParseResult.quality,
        totalCharacters: atomicSource.content.length,
        parsedUnitCount: 1,
      },
    };
    const binding = {
      ...ruleReviewBinding(atomicFinding, atomicRequirement),
      reviewer: "reviewer-attest",
      reviewedAt: "2026-08-15T00:00:00.000Z",
      reason: "已逐字核对原文并确认单字强度语义。",
    };
    const attestations = [
      {
        ...binding,
        rule: "atomic_structure" as const,
        decision: "confirmed" as const,
      },
      {
        ...binding,
        rule: "modal_strength" as const,
        decision: "confirmed" as const,
      },
    ];
    const session = {
      project: atomicProject,
      parseResults: [atomicResult],
      atomicRequirements: [atomicRequirement],
      ruleReviewAttestations: [],
    } as Parameters<typeof calculateSessionQuality>[0] & {
      ruleReviewAttestations: readonly (typeof attestations)[number][];
    };

    const pending = calculateSessionQuality(session);
    expect(pending).toMatchObject({
      automaticValidationRuleCount: 9,
      manualConfirmedValidationRuleCount: 0,
      manualReviewPendingRuleCount: 2,
      manualRejectedValidationRuleCount: 0,
      failedValidationRuleCount: 0,
      citationReverseCheckRate: 0,
      unsupportedFindingCount: 1,
    });
    expect(canFinalizeSession(session)).toBe(false);

    const confirmedSession = {
      ...session,
      ruleReviewAttestations: attestations,
    };
    expect(calculateSessionQuality(confirmedSession)).toMatchObject({
      automaticValidationRuleCount: 9,
      manualConfirmedValidationRuleCount: 2,
      manualReviewPendingRuleCount: 0,
      manualRejectedValidationRuleCount: 0,
      failedValidationRuleCount: 0,
      citationReverseCheckRate: 1,
      unsupportedFindingCount: 0,
    });
    expect(canFinalizeSession(confirmedSession)).toBe(true);

    const automaticRejectionSession = {
      ...confirmedSession,
      ruleReviewAttestations: [
        ...attestations,
        {
          ...binding,
          rule: "source_id" as const,
          decision: "rejected" as const,
        },
      ],
    };
    expect(calculateSessionQuality(automaticRejectionSession)).toMatchObject({
      automaticValidationRuleCount: 8,
      manualConfirmedValidationRuleCount: 2,
      manualRejectedValidationRuleCount: 1,
      citationReverseCheckRate: 0,
    });
    expect(canFinalizeSession(automaticRejectionSession)).toBe(false);

    for (const malformed of [
      null,
      {},
      [null],
      [{}],
      [
        {
          ...attestations[0],
          sourceEvidenceHash: { nested: "invalid" },
        },
      ],
    ]) {
      const malformedSession = {
        ...confirmedSession,
        ruleReviewAttestations: malformed,
      } as unknown as Parameters<typeof calculateSessionQuality>[0];
      expect(() => calculateSessionQuality(malformedSession)).not.toThrow();
      expect(calculateSessionQuality(malformedSession)).toMatchObject({
        attestationIntegrityFailureCount: 1,
        citationReverseCheckRate: 0,
      });
      expect(canFinalizeSession(malformedSession)).toBe(false);
    }

    for (const duplicate of [
      { ...attestations[0], reason: "" },
      {
        ...attestations[0],
        sourceEvidenceHash: `fnv1a64:${"4".repeat(16)}`,
      },
    ]) {
      const invalidDuplicateSession = {
        ...confirmedSession,
        ruleReviewAttestations: [...attestations, duplicate],
      };
      expect(calculateSessionQuality(invalidDuplicateSession)).toMatchObject({
        attestationIntegrityFailureCount: 1,
        citationReverseCheckRate: 0,
      });
      expect(canFinalizeSession(invalidDuplicateSession)).toBe(false);
    }

    const staleAtomic = { ...atomicRequirement, frequency: "每年" };
    expect(
      canFinalizeSession({
        ...confirmedSession,
        atomicRequirements: [staleAtomic],
      }),
    ).toBe(false);
    expect(
      canFinalizeSession({
        ...confirmedSession,
        ruleReviewAttestations: attestations.map((attestation) => ({
          ...attestation,
          decision: "rejected" as const,
        })),
      }),
    ).toBe(false);
    expect(
      canFinalizeSession({
        ...confirmedSession,
        ruleReviewAttestations: [
          attestations[0],
          { ...attestations[0], rule: "source_id" },
        ],
      }),
    ).toBe(false);

    const changedFinding = {
      ...atomicFinding,
      sourceAnchors: [
        { ...atomicFinding.sourceAnchors[0], quote: "机构不得建立制度。" },
      ],
    };
    expect(
      canFinalizeSession({
        ...confirmedSession,
        project: { ...atomicProject, findings: [changedFinding] },
        ruleReviewAttestations: attestations.map((attestation) => ({
          ...attestation,
          ...ruleReviewBinding(changedFinding, atomicRequirement),
        })),
      }),
    ).toBe(false);
  });

  test("adapts the Task 4 parse result into the strict evidence session boundary", () => {
    const outcome = parseOutcomeFromResult(completeParseResult);
    expect(outcome).toMatchObject({
      fileHash: "a".repeat(64),
      source,
      sourceId: "REG-1",
      sourceType: "regulatory_text",
      pageCount: 3,
      successfulPages: [1, 2, 3],
      failedPages: [],
      failedPageCount: 0,
      parsedUnitCount: 3,
      totalCharacters: source.content.length,
      ocrFailedPages: [],
      finalizationBlocked: false,
      extractionCoverage: 1,
      units: pageUnits,
      anchors: buildAnchors(pageUnits),
      ocrReviews: [],
      lowTextPages: [],
    });
    expect(outcome.orderedUnitDigest).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
    expect(
      parseOutcomeFromResult({
        ...completeParseResult,
        units: [...pageUnits].reverse(),
      }).orderedUnitDigest,
    ).not.toBe(outcome.orderedUnitDigest);
  });

  test("fails official provenance without pairing and passes the same rule with exact Task 7 pairing", () => {
    const officialSource = {
      sourceId: "OFF-QUALITY",
      sourceType: "official_interpretation" as const,
      title: "合成官方说明",
      content: "官方说明政策目标。",
    };
    const officialUnit: ParsedSourceUnit = {
      sourceId: officialSource.sourceId,
      sourceType: officialSource.sourceType,
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: officialSource.content,
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const officialFinding: Finding = {
      findingId: "OFF-FINDING",
      category: "official_context:policy_background",
      statement: `官方解读材料摘录（政策背景）：“${officialSource.content}”。该摘录仅作为官方说明材料，不建立或覆盖监管文件效力、适用性或其他法律结论，须经人工合规复核。`,
      claimType: "official_explanation",
      sourceAnchors: [
        {
          sourceId: officialSource.sourceId,
          sourceType: officialSource.sourceType,
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: officialSource.content,
        },
      ],
      inferenceParents: [fact.findingId],
      reviewStatus: "confirmed",
      requiredReview: true,
      revisionRecords: [],
    };
    const officialParseResult: ParseResult = {
      fileHash: "e".repeat(64),
      source: officialSource,
      pageCount: 1,
      successfulPages: [1],
      failedPages: [],
      units: [officialUnit],
      ocrReviews: [],
      anchors: buildAnchors([officialUnit]),
      quality: {
        totalCharacters: officialSource.content.length,
        parsedUnitCount: 1,
        failedPageCount: 0,
        lowTextPages: [],
        ocrFailedPages: [],
        finalizationBlocked: false,
        extractionCoverage: 1,
      },
    };
    const officialProject: Project = {
      ...project([fact, officialFinding]),
      sourceUnits: [source, officialSource],
    };
    const withoutPairing = calculateSessionQuality({
      project: officialProject,
      parseResults: [completeParseResult, officialParseResult],
    });
    expect(withoutPairing).toMatchObject({
      citationReverseCheckRate: 0.5,
      unsupportedFindingCount: 1,
    });
    expect(
      canFinalizeSession({
        project: officialProject,
        parseResults: [completeParseResult, officialParseResult],
      }),
    ).toBe(false);

    const pairedSession = {
      project: officialProject,
      parseResults: [completeParseResult, officialParseResult],
      officialPrimarySourceIds: {
        [officialSource.sourceId]: [source.sourceId],
      },
    };
    expect(calculateSessionQuality(pairedSession)).toMatchObject({
      citationReverseCheckRate: 1,
      unsupportedFindingCount: 0,
      attestationIntegrityFailureCount: 0,
    });
    expect(canFinalizeSession(pairedSession)).toBe(true);
  });

  test("rejects swapped, stale, missing, or duplicate authoritative ParseResult anchors", () => {
    expect(
      canFinalizeSession({
        project: project(),
        parseResults: [completeParseResult],
      }),
    ).toBe(true);

    const [firstAnchor, secondAnchor, thirdAnchor] =
      completeParseResult.anchors;
    for (const anchors of [
      [secondAnchor, firstAnchor, thirdAnchor],
      [{ ...firstAnchor, page: 2 }, secondAnchor, thirdAnchor],
      [firstAnchor, secondAnchor],
      [firstAnchor, firstAnchor, secondAnchor, thirdAnchor],
    ]) {
      expect(
        canFinalizeSession({
          project: project(),
          parseResults: [{ ...completeParseResult, anchors }],
        }),
      ).toBe(false);
    }
  });

  test("uses authoritative OCR reviews and low-text pages instead of unit-local corrected state", () => {
    const ocrSource = {
      sourceId: "REG-OCR-AUTHORITY",
      sourceType: "regulatory_text" as const,
      title: "合成校正 OCR 文件.pdf",
      content: "机构必须留存完整记录。",
    };
    const correction = {
      correctedText: ocrSource.content,
      reviewedBy: "reviewer-1",
      reviewedAt: "2026-08-14T12:00:00.000Z",
    };
    const ocrUnit: ParsedSourceUnit = {
      unitId: `${ocrSource.sourceId}:p1:ocr`,
      sourceId: ocrSource.sourceId,
      sourceType: ocrSource.sourceType,
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: ocrSource.content,
      extractionMethod: "ocr",
      confidence: 0.6,
      boundingBox: { x: 0, y: 0, width: 100, height: 20 },
      originalOcrText: "机构必领留存完整记录。",
      correctedText: correction.correctedText,
      reviewStatus: "corrected",
      reviewedAt: correction.reviewedAt,
      reviewedBy: correction.reviewedBy,
      correctionHistory: [correction],
      ocrRegions: [],
      lowConfidenceCharacters: [
        {
          text: "领",
          confidence: 0.3,
          boundingBox: { x: 20, y: 0, width: 10, height: 20 },
        },
      ],
    };
    const ocrReview: OcrPageResult = {
      unitId: ocrUnit.unitId!,
      sourceId: ocrUnit.sourceId,
      sourceType: ocrUnit.sourceType,
      page: 1,
      method: "ocr",
      confidence: ocrUnit.confidence,
      text: ocrUnit.text,
      originalOcrText: ocrUnit.originalOcrText!,
      correctedText: ocrUnit.correctedText!,
      reviewStatus: "corrected",
      reviewedAt: ocrUnit.reviewedAt!,
      reviewedBy: ocrUnit.reviewedBy!,
      correctionHistory: [correction],
      boundingBox: ocrUnit.boundingBox!,
      regions: [],
      lowConfidenceCharacters: ocrUnit.lowConfidenceCharacters!,
    };
    const ocrFinding: Finding = {
      ...fact,
      statement: ocrSource.content,
      sourceAnchors: buildAnchors([ocrUnit]),
    };
    const ocrProject: Project = {
      ...project([ocrFinding]),
      sourceUnits: [ocrSource],
    };
    const ocrResult: ParseResult = {
      fileHash: "f".repeat(64),
      source: ocrSource,
      pageCount: 1,
      successfulPages: [1],
      failedPages: [],
      units: [ocrUnit],
      ocrReviews: [ocrReview],
      anchors: buildAnchors([ocrUnit]),
      quality: {
        totalCharacters: ocrSource.content.length,
        parsedUnitCount: 1,
        failedPageCount: 0,
        lowTextPages: [1],
        extractionCoverage: 1,
        ocrFailedPages: [],
        finalizationBlocked: false,
      },
    };

    expect(
      canFinalizeSession({ project: ocrProject, parseResults: [ocrResult] }),
    ).toBe(true);
    for (const changed of [
      { ocrReviews: [] },
      { quality: { ...ocrResult.quality, lowTextPages: [] } },
      {
        ocrReviews: [{ ...ocrReview, page: 2 }],
      },
      {
        ocrReviews: [{ ...ocrReview, reviewStatus: "unreviewed" as const }],
      },
      {
        ocrReviews: [{ ...ocrReview, correctionHistory: [] }],
      },
      {
        ocrReviews: [
          {
            ...ocrReview,
            reviewStatus: "failed" as const,
            error: "页面 OCR 识别失败" as const,
          },
        ],
      },
    ]) {
      expect(
        canFinalizeSession({
          project: ocrProject,
          parseResults: [{ ...ocrResult, ...changed }],
        }),
      ).toBe(false);
    }
  });

  test("fails closed without throwing for malformed imported OCR reviews and correction history", () => {
    const correction = {
      correctedText: unit.text,
      reviewedBy: "reviewer-malformed",
      reviewedAt: "2026-08-14T13:00:00.000Z",
    };
    const ocrUnit: ParsedSourceUnit = {
      ...unit,
      unitId: `${unit.sourceId}:p${unit.page}:ocr`,
      extractionMethod: "ocr",
      boundingBox: { x: 0, y: 0, width: 100, height: 20 },
      originalOcrText: "第十条 金融机构必领完成年度复核。",
      correctedText: correction.correctedText,
      reviewStatus: "corrected",
      reviewedAt: correction.reviewedAt,
      reviewedBy: correction.reviewedBy,
      correctionHistory: [correction],
      ocrRegions: [],
      lowConfidenceCharacters: [],
    };
    const review: OcrPageResult = {
      unitId: ocrUnit.unitId!,
      sourceId: ocrUnit.sourceId,
      sourceType: ocrUnit.sourceType,
      page: ocrUnit.page!,
      method: "ocr",
      confidence: ocrUnit.confidence,
      text: ocrUnit.text,
      originalOcrText: ocrUnit.originalOcrText!,
      correctedText: ocrUnit.correctedText!,
      reviewStatus: "corrected",
      reviewedAt: ocrUnit.reviewedAt!,
      reviewedBy: ocrUnit.reviewedBy!,
      correctionHistory: [correction],
      boundingBox: ocrUnit.boundingBox!,
      regions: [],
      lowConfidenceCharacters: [],
    };
    const result: ParseResult = {
      ...completeParseResult,
      units: [...pageUnits.slice(0, 2), ocrUnit],
      ocrReviews: [review],
      anchors: buildAnchors([...pageUnits.slice(0, 2), ocrUnit]),
      quality: { ...completeParseResult.quality, lowTextPages: [3] },
    };
    expect(
      canFinalizeSession({ project: project(), parseResults: [result] }),
    ).toBe(true);

    const malformedReviews: unknown[] = [
      undefined,
      {},
      [{}],
      [{ ...review, correctionHistory: undefined }],
      [{ ...review, correctionHistory: {} }],
      [{ ...review, correctionHistory: [undefined] }],
      [
        {
          ...review,
          correctionHistory: [{ ...correction, unexpected: true }],
        },
      ],
    ];
    for (const ocrReviews of malformedReviews) {
      const malformedResult = {
        ...result,
        ocrReviews,
      } as unknown as ParseResult;
      const finalize = () =>
        canFinalizeSession({
          project: project(),
          parseResults: [malformedResult],
        });
      expect(finalize).not.toThrow();
      expect(finalize()).toBe(false);
    }
  });

  test("rejects omitted, reordered, or duplicated paragraphs on the same successful page", () => {
    const samePageSource = {
      sourceId: "REG-SAME-PAGE",
      sourceType: "regulatory_text" as const,
      title: "合成同页双段文件.pdf",
      content: "第一段说明适用主体。\n\n第二段说明办理流程。",
    };
    const samePageUnits: ParsedSourceUnit[] = [
      {
        sourceId: samePageSource.sourceId,
        sourceType: samePageSource.sourceType,
        page: 1,
        article: null,
        paragraphIndex: 0,
        text: "第一段说明适用主体。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
      {
        sourceId: samePageSource.sourceId,
        sourceType: samePageSource.sourceType,
        page: 1,
        article: null,
        paragraphIndex: 1,
        text: "第二段说明办理流程。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
    ];
    const samePageFinding: Finding = {
      ...fact,
      statement: samePageUnits[1].text,
      sourceAnchors: [
        {
          sourceId: samePageSource.sourceId,
          sourceType: samePageSource.sourceType,
          page: 1,
          article: null,
          paragraphIndex: 1,
          quote: samePageUnits[1].text,
        },
      ],
    };
    const samePageProject: Project = {
      ...project([samePageFinding]),
      sourceUnits: [samePageSource],
    };
    const samePageResult: ParseResult = {
      ...completeParseResult,
      fileHash: "b".repeat(64),
      source: samePageSource,
      pageCount: 1,
      successfulPages: [1],
      units: samePageUnits,
      anchors: buildAnchors(samePageUnits),
      quality: {
        ...completeParseResult.quality,
        totalCharacters: samePageSource.content.length,
        parsedUnitCount: 2,
      },
    };

    expect(
      canFinalizeSession({
        project: samePageProject,
        parseResults: [samePageResult],
      }),
    ).toBe(true);
    for (const units of [
      [samePageUnits[0]],
      [...samePageUnits].reverse(),
      [samePageUnits[0], samePageUnits[0], samePageUnits[1]],
    ]) {
      expect(
        canFinalizeSession({
          project: samePageProject,
          parseResults: [{ ...samePageResult, units }],
        }),
      ).toBe(false);
    }
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

  test("fails closed instead of throwing when imported session parse results are absent", () => {
    const malformedSession = {
      project: project(),
      parseResults: undefined,
    } as unknown as Parameters<typeof calculateSessionQuality>[0];

    expect(() => calculateSessionQuality(malformedSession)).not.toThrow();
    expect(
      calculateSessionQuality(malformedSession).citationReverseCheckRate,
    ).toBe(0);
    expect(canFinalizeSession(malformedSession)).toBe(false);
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
    const docxOutcome: SourceParseOutcome = parseOutcomeFromResult({
      ...completeParseResult,
      fileHash: "c".repeat(64),
      source: docxSource,
      pageCount: null,
      successfulPages: [],
      failedPages: [],
      units: [docxUnit],
      anchors: docxFinding.sourceAnchors,
      quality: {
        ...completeParseResult.quality,
        totalCharacters: docxSource.content.length,
        parsedUnitCount: 1,
      },
    });

    expect(canFinalize(docxProject, [docxUnit], [docxOutcome])).toBe(true);
    expect(
      canFinalize(docxProject, [{ ...docxUnit, page: 1 }], [docxOutcome]),
    ).toBe(false);
  });

  test.each([
    { method: "docx_xml" as const, page: null, pageCount: null },
    { method: "plain_text" as const, page: null, pageCount: null },
    { method: "ocr" as const, page: 1, pageCount: 1 },
  ])(
    "accepts a complete $method Task 4 ParseResult without inventing page semantics",
    ({ method, page, pageCount }) => {
      const formatSource = {
        sourceId: `REG-${method}`,
        sourceType: "regulatory_text" as const,
        title: `合成${method}监管材料`,
        content: "机构必须留存完整记录。",
      };
      const formatCorrection = {
        correctedText: formatSource.content,
        reviewedBy: "reviewer-format",
        reviewedAt: "2026-08-14T12:00:00.000Z",
      };
      const formatUnit: ParsedSourceUnit = {
        sourceId: formatSource.sourceId,
        sourceType: formatSource.sourceType,
        page,
        article: null,
        paragraphIndex: 0,
        text: formatSource.content,
        extractionMethod: method,
        confidence: 1,
        ...(method === "ocr"
          ? {
              unitId: `${formatSource.sourceId}:p1:ocr`,
              boundingBox: { x: 0, y: 0, width: 100, height: 20 },
              originalOcrText: formatSource.content,
              correctedText: formatSource.content,
              reviewStatus: "corrected" as const,
              reviewedAt: formatCorrection.reviewedAt,
              reviewedBy: formatCorrection.reviewedBy,
              correctionHistory: [formatCorrection],
              ocrRegions: [],
              lowConfidenceCharacters: [],
            }
          : {}),
      };
      const formatOcrReviews: OcrPageResult[] =
        method === "ocr"
          ? [
              {
                unitId: formatUnit.unitId!,
                sourceId: formatUnit.sourceId,
                sourceType: formatUnit.sourceType,
                page: formatUnit.page!,
                method: "ocr",
                confidence: formatUnit.confidence,
                text: formatUnit.text,
                originalOcrText: formatUnit.originalOcrText!,
                correctedText: formatUnit.correctedText!,
                reviewStatus: "corrected",
                reviewedAt: formatUnit.reviewedAt!,
                reviewedBy: formatUnit.reviewedBy!,
                correctionHistory: [formatCorrection],
                boundingBox: formatUnit.boundingBox!,
                regions: [],
                lowConfidenceCharacters: [],
              },
            ]
          : [];
      const formatFinding: Finding = {
        ...fact,
        statement: formatSource.content,
        sourceAnchors: [
          {
            sourceId: formatSource.sourceId,
            sourceType: formatSource.sourceType,
            page,
            article: null,
            paragraphIndex: 0,
            quote: formatSource.content,
          },
        ],
      };
      const formatProject: Project = {
        ...project([formatFinding]),
        sourceUnits: [formatSource],
      };
      const formatResult: ParseResult = {
        ...completeParseResult,
        fileHash: method === "docx_xml" ? "d".repeat(64) : "e".repeat(64),
        source: formatSource,
        pageCount,
        successfulPages: page === null ? [] : [page],
        units: [formatUnit],
        ocrReviews: formatOcrReviews,
        anchors: buildAnchors([formatUnit]),
        quality: {
          ...completeParseResult.quality,
          totalCharacters: formatSource.content.length,
          parsedUnitCount: 1,
          lowTextPages: method === "ocr" ? [1] : [],
        },
      };

      expect(
        canFinalizeSession({
          project: formatProject,
          parseResults: [formatResult],
        }),
      ).toBe(true);
    },
  );

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

  test("accepts an append-only structured review audit chain and rejects gaps, reorder, forks, or tamper", () => {
    const before: Finding = {
      ...fact,
      statement: "金融机构应当完成年度复核。",
      reviewStatus: "unreviewed",
      revisionRecords: [],
    };
    const middle: Finding = {
      ...fact,
      statement: "金融机构应当完成年度复核并留痕。",
      reviewStatus: "modified",
      revisionRecords: [
        {
          revisedBy: "reviewer-1",
          revisedAt: "2026-08-14T08:00:00.000Z",
          changeSummary: "首次人工复核。",
        },
      ],
    };
    const after: Finding = {
      ...fact,
      reviewStatus: "modified",
      revisionRecords: [
        {
          revisedBy: "reviewer-1",
          revisedAt: "2026-08-14T09:00:00.000Z",
          changeSummary: "二次人工复核。",
        },
      ],
    };
    const firstAudit: ReviewAudit = {
      findingId: middle.findingId,
      beforeSnapshot: before,
      beforeHash: reviewSnapshotHash(before),
      afterSnapshot: middle,
      afterHash: reviewSnapshotHash(middle),
      reason: "首次补充留痕要求。",
      reviewer: "reviewer-1",
      reviewedAt: "2026-08-14T08:00:00.000Z",
    };
    const secondAudit: ReviewAudit = {
      findingId: after.findingId,
      beforeSnapshot: middle,
      beforeHash: reviewSnapshotHash(middle),
      afterSnapshot: after,
      afterHash: reviewSnapshotHash(after),
      reason: "依据权威原文纠正模态强度。",
      reviewer: "reviewer-1",
      reviewedAt: "2026-08-14T09:00:00.000Z",
    };
    const session = {
      project: project([after]),
      parseResults: [completeParseResult],
      reviewAudits: [firstAudit, secondAudit],
    };
    expect(calculateSessionQuality(session).requiredReviewCompletionRate).toBe(
      1,
    );
    expect(canFinalizeSession(session)).toBe(true);

    const wrongAfter = {
      ...secondAudit,
      afterSnapshot: { ...after, statement: "被篡改的结论。" },
    };
    expect(
      calculateSessionQuality({
        ...session,
        reviewAudits: [firstAudit, wrongAfter],
      }).requiredReviewCompletionRate,
    ).toBe(0);
    expect(
      calculateSessionQuality({
        ...session,
        reviewAudits: [
          firstAudit,
          { ...secondAudit, beforeHash: secondAudit.afterHash },
        ],
      }).requiredReviewCompletionRate,
    ).toBe(0);
    const gap = {
      ...secondAudit,
      beforeSnapshot: before,
      beforeHash: reviewSnapshotHash(before),
    };
    const fork = {
      ...secondAudit,
      beforeSnapshot: { ...middle, statement: "分叉版本。" },
      beforeHash: reviewSnapshotHash({ ...middle, statement: "分叉版本。" }),
    };
    for (const invalidAudits of [
      [secondAudit, firstAudit],
      [firstAudit, gap],
      [firstAudit, fork],
      [firstAudit, { ...secondAudit, reviewedAt: firstAudit.reviewedAt }],
    ]) {
      expect(
        calculateSessionQuality({ ...session, reviewAudits: invalidAudits })
          .requiredReviewCompletionRate,
      ).toBe(0);
    }
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

  test("does not finalize a human judgment whose cited basis has a fabricated locator or quote", () => {
    const fakeHuman: Finding = {
      ...fact,
      findingId: "H-FAKE-EVIDENCE",
      category: "human_review",
      statement: "经人工判断，本项目仍需进一步核验。",
      claimType: "human_judgment",
      sourceAnchors: [
        {
          ...fact.sourceAnchors[0],
          paragraphIndex: 99,
          quote: "并不存在的人工判断依据",
        },
      ],
      inferenceParents: [],
      reviewStatus: "confirmed",
      requiredReview: true,
      revisionRecords: [
        {
          revisedBy: "reviewer-1",
          revisedAt: "2026-08-15T08:00:00.000Z",
          changeSummary: "人工判断",
        },
      ],
    };
    const session = {
      project: project([fakeHuman]),
      parseResults: [completeParseResult],
    };
    expect(calculateSessionQuality(session).unsupportedFindingCount).toBe(1);
    expect(canFinalizeSession(session)).toBe(false);
  });
});
