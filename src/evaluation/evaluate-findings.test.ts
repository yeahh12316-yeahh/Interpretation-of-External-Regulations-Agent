import { describe, expect, it } from "vitest";

import type { Finding } from "../domain/finding";
import type { SourceAnchor } from "../domain/source";
import type { AtomicRequirement } from "../features/analysis/skill-orchestrator";
import {
  EvaluationCorpusSchema,
  evaluateFindings,
  type EvaluationCorpus,
} from "./evaluate-findings";
import {
  BenchmarkManifestSchema,
  renderEvaluationSummary,
} from "./evaluation-report";

const anchor = (sourceId = "SYNTH-REG-A"): SourceAnchor => ({
  sourceId,
  sourceType: "regulatory_text",
  page: 1,
  article: "第一条",
  paragraphIndex: 0,
  quote: "第一条 示例机构必须建立控制机制。",
});

const finding = (
  findingId: string,
  category: string,
  statement = "示例机构必须建立控制机制",
  sourceAnchor = anchor(),
): Finding => ({
  findingId,
  category,
  statement,
  claimType: "regulatory_fact",
  sourceAnchors: [sourceAnchor],
  inferenceParents: [],
  reviewStatus: "unreviewed",
  requiredReview: false,
  revisionRecords: [],
});

const atomic = (
  findingId: string,
  overrides: Partial<AtomicRequirement> = {},
): AtomicRequirement => ({
  requirementId: `AR-${findingId}`,
  findingId,
  subject: "示例机构",
  action: "建立",
  object: "控制机制",
  condition: "开展示例业务时",
  frequency: "每年",
  deadline: "二〇二六年一月一日前",
  strength: "必须",
  responsibility: "合规部门",
  exceptions: "依法豁免的除外",
  sharedContext: null,
  missingFacts: [],
  sourceAnchors: [anchor()],
  confidence: 1,
  manualVerificationRequired: false,
  ...overrides,
});

const corpus = (
  findings: Finding[],
  atomicRequirements: AtomicRequirement[] = [],
  ocrPages: EvaluationCorpus["ocrPages"] = [],
): EvaluationCorpus => ({ findings, atomicRequirements, ocrPages });

describe("evaluateFindings", () => {
  it("strictly rejects malformed corpora and incomplete benchmark modality coverage", () => {
    expect(
      EvaluationCorpusSchema.safeParse({
        findings: [],
        atomicRequirements: [],
        ocrPages: [],
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      BenchmarkManifestSchema.safeParse({
        benchmarkId: "synthetic-regression-v1",
        benchmarkVersion: "1.0.0",
        description: "合成回归基准",
        disclaimer:
          "合成回归基准，仅证明该测试语料/版本，不代表未知文件95%正确率",
        expectedFile: "expected-findings.json",
        actualFile: "actual-findings.json",
        failingActualFile: "actual-findings-failing.json",
        coverage: {
          fileTypes: ["txt"],
          regulatorTypes: ["示例监管机构"],
          modalities: ["text"],
          officialInterpretation: ["with"],
          requiredCriticalCategories: [
            "core_requirement",
            "prohibition",
            "key_date",
            "transition_period",
          ],
          sampleCount: 1,
        },
        samples: [],
      }).success,
    ).toBe(false);
    expect(
      BenchmarkManifestSchema.safeParse({
        benchmarkId: "synthetic-regression-v1",
        benchmarkVersion: "1.0.0",
        description: "合成回归基准",
        disclaimer:
          "合成回归基准，仅证明该测试语料/版本，不代表未知文件95%正确率",
        expectedFile: "expected-findings.json",
        actualFile: "actual-findings.json",
        failingActualFile: "actual-findings-failing.json",
        coverage: {
          fileTypes: ["pdf_text", "pdf_scan", "docx", "txt"],
          regulatorTypes: ["示例监管机构"],
          modalities: [
            "text",
            "scanned",
            "table",
            "attachment",
            "long_document",
          ],
          officialInterpretation: ["with", "without"],
          requiredCriticalCategories: [
            "core_requirement",
            "prohibition",
            "key_date",
            "transition_period",
          ],
          sampleCount: 1,
        },
        samples: [
          {
            sampleId: "ONLY-TXT",
            fileType: "txt",
            regulatorType: "示例监管机构",
            modalities: ["text"],
            officialInterpretation: "without",
            synthetic: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("matches one-to-one and reports the unmatched critical expected ID", () => {
    const expected = corpus([
      finding("CRITICAL-001", "key_matter:core_requirement"),
      finding("CRITICAL-002", "key_matter:core_requirement"),
    ]);
    const actual = corpus([
      finding("SYSTEM-DIFFERENT-ID", "key_matter:core_requirement"),
    ]);

    const metrics = evaluateFindings(expected, actual);

    expect(metrics.critical).toEqual({
      tp: 1,
      fp: 0,
      fn: 1,
      precision: 1,
      recall: 0.5,
      evaluable: true,
    });
    expect(metrics.matches).toEqual([
      {
        expectedFindingId: "CRITICAL-001",
        actualFindingId: "SYSTEM-DIFFERENT-ID",
      },
    ]);
    expect(metrics.criticalOmissions).toEqual(["CRITICAL-002"]);
  });

  it("rejects substring, atomic-field, category, and source-anchor near matches", () => {
    const expectedFinding = finding("ATOMIC-EXPECTED", "atomic_requirement");
    const actualBase = finding("ATOMIC-ACTUAL", "atomic_requirement");
    const expected = corpus(
      [expectedFinding],
      [atomic(expectedFinding.findingId)],
    );

    const variants: Array<{
      actual: EvaluationCorpus;
      expectedAtomicFalsePositives: number;
    }> = [
      {
        actual: corpus(
          [{ ...actualBase, statement: `${actualBase.statement}补充文字` }],
          [atomic(actualBase.findingId)],
        ),
        expectedAtomicFalsePositives: 1,
      },
      {
        actual: corpus(
          [actualBase],
          [atomic(actualBase.findingId, { action: "完善" })],
        ),
        expectedAtomicFalsePositives: 1,
      },
      {
        actual: corpus(
          [{ ...actualBase, category: "key_matter:core_requirement" }],
          [],
        ),
        expectedAtomicFalsePositives: 0,
      },
      {
        actual: corpus(
          [
            {
              ...actualBase,
              sourceAnchors: [anchor("SYNTH-REG-B")],
            },
          ],
          [
            atomic(actualBase.findingId, {
              sourceAnchors: [anchor("SYNTH-REG-B")],
            }),
          ],
        ),
        expectedAtomicFalsePositives: 1,
      },
    ];

    for (const { actual, expectedAtomicFalsePositives } of variants) {
      const metrics = evaluateFindings(expected, actual);
      expect(metrics.atomic.tp).toBe(0);
      expect(metrics.atomic.fn).toBe(1);
      expect(metrics.atomic.fp).toBe(expectedAtomicFalsePositives);
      expect(metrics.matches).toEqual([]);
    }
  });

  it("uses explicit null ratios and blocks release for uncovered required categories", () => {
    const metrics = evaluateFindings(corpus([]), corpus([]));

    expect(metrics.critical.precision).toBeNull();
    expect(metrics.critical.recall).toBeNull();
    expect(metrics.critical.evaluable).toBe(false);
    expect(metrics.atomic.precision).toBeNull();
    expect(metrics.citationValidity.rate).toBeNull();
    expect(metrics.ocr.accuracy).toBeNull();
    expect(metrics.releaseGate.passed).toBe(false);
    expect(metrics.releaseGate.failures).toEqual(
      expect.arrayContaining([
        "critical_category_not_evaluable:core_requirement",
        "critical_category_not_evaluable:prohibition",
        "critical_category_not_evaluable:key_date",
        "critical_category_not_evaluable:transition_period",
        "atomic_not_evaluable",
        "citation_not_evaluable",
        "ocr_not_evaluable",
      ]),
    );
  });

  it("passes all bound thresholds only with complete categories, citations, AI labels, and OCR", () => {
    const critical = [
      finding("CORE-1", "key_matter:core_requirement"),
      finding("BAN-1", "key_matter:prohibition", "示例机构不得虚构记录"),
      finding(
        "DATE-1",
        "key_matter:effective_date",
        "本办法自二〇二六年一月一日起施行",
      ),
      finding(
        "TRANSITION-1",
        "key_matter:transition_period",
        "过渡期截至二〇二六年六月三十日",
      ),
    ];
    const atomicFinding = finding(
      "ATOMIC-1",
      "atomic_requirement",
      "示例机构必须建立控制机制",
    );
    const expected = corpus(
      [...critical, atomicFinding],
      [atomic("ATOMIC-1")],
      [
        {
          sourceId: "SYNTH-SCAN-A",
          page: 1,
          text: "示例机构必须建立控制机制",
        },
      ],
    );
    const actual = corpus(
      critical
        .map((item) => ({
          ...item,
          findingId: `SYSTEM-${item.findingId}`,
        }))
        .concat({ ...atomicFinding, findingId: "SYSTEM-ATOMIC-1" }),
      [atomic("SYSTEM-ATOMIC-1", { requirementId: "SYSTEM-AR-1" })],
      [
        {
          sourceId: "SYNTH-SCAN-A",
          page: 1,
          text: "示例机构必须建立控制机制",
        },
      ],
    );

    const metrics = evaluateFindings(expected, actual);

    expect(metrics.releaseGate).toEqual({ passed: true, failures: [] });
    expect(metrics.critical.precision).toBe(1);
    expect(metrics.critical.recall).toBe(1);
    expect(metrics.atomic.precision).toBe(1);
    expect(metrics.atomic.recall).toBe(1);
    expect(metrics.citationValidity).toEqual({ valid: 5, total: 5, rate: 1 });
    expect(metrics.unmarkedAiInferenceIds).toEqual([]);
    expect(metrics.ocr).toEqual({
      errors: 0,
      expectedCharacters: 12,
      accuracy: 1,
      manualReviewPages: [],
      evaluable: true,
    });
  });

  it("fails closed on an unmarked inference and lists every OCR page below 99 percent", () => {
    const core = finding("CORE-1", "key_matter:core_requirement");
    const inference = {
      ...finding(
        "IMPACT-1",
        "institution_impact:system",
        "可能需要调整示例系统",
      ),
      inferenceParents: ["CORE-1"],
    };
    const expected = corpus(
      [core],
      [],
      [{ sourceId: "SYNTH-SCAN-A", page: 3, text: "关键日期二〇二六年" }],
    );
    const actual = corpus(
      [core, inference],
      [],
      [{ sourceId: "SYNTH-SCAN-A", page: 3, text: "关键日期二〇二五年" }],
    );

    const metrics = evaluateFindings(expected, actual);

    expect(metrics.unmarkedAiInferenceIds).toEqual(["IMPACT-1"]);
    expect(metrics.ocr.accuracy).toBeLessThan(0.99);
    expect(metrics.ocr.manualReviewPages).toEqual([
      { sourceId: "SYNTH-SCAN-A", page: 3 },
    ]);
    expect(metrics.releaseGate.passed).toBe(false);
    expect(metrics.releaseGate.failures).toEqual(
      expect.arrayContaining([
        "unmarked_ai_inference",
        "ocr_accuracy_below_99",
      ]),
    );
  });

  it("renders a non-sensitive summary with thresholds and the synthetic-only disclaimer", () => {
    const metrics = evaluateFindings(corpus([]), corpus([]));
    const summary = renderEvaluationSummary({
      benchmarkId: "synthetic-regression-v1",
      benchmarkVersion: "1.0.0",
      disclaimer:
        "合成回归基准，仅证明该测试语料/版本，不代表未知文件95%正确率",
      metrics,
    });

    expect(summary).toContain("RELEASE GATE: FAIL");
    expect(summary).toContain("重大类别 precision/recall >= 95%");
    expect(summary).toContain("原子要求 precision >= 90%, recall >= 85%");
    expect(summary).toContain("事实引用有效率 = 100%");
    expect(summary).toContain("OCR 关键字段字符准确率 >= 99%");
    expect(summary).toContain(
      "合成回归基准，仅证明该测试语料/版本，不代表未知文件95%正确率",
    );
    expect(summary).not.toContain("示例机构必须建立控制机制");
  });
});
