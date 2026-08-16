import { describe, expect, test } from "vitest";

import type { Finding } from "../../domain/finding";
import type { SourceUnit } from "../../domain/source";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import {
  extractDates,
  extractModalTerms,
  extractNumbers,
  normalizeText,
} from "./normalize-text";
import {
  createSourceIndex,
  findIndexedParsedUnitForAnchor,
  type OfficialPrimarySourceIds,
  validateFinding,
} from "./validate-finding";

const sources: SourceUnit[] = [
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    title: "合成监管办法.txt",
    content:
      "第八条 机构不得在2026年12月31日前收取超过10%的费用。\n\n第十七条 重复条款。\n\n第十八条 重复条款。",
  },
  {
    sourceId: "OFF-1",
    sourceType: "official_interpretation",
    title: "合成官方解读.txt",
    content: "官方解读说明政策目标。",
  },
];

const parsedUnits: ParsedSourceUnit[] = [
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 12,
    article: "第八条",
    paragraphIndex: 0,
    text: "第八条　机构不得在２０２６年１２月３１日前收取超过１０％的费用。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 17,
    article: "第十七条",
    paragraphIndex: 0,
    text: "第十七条 重复条款。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 18,
    article: "第十八条",
    paragraphIndex: 0,
    text: "第十八条 重复条款。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
];

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  findingId: "F1",
  category: "key_matter:prohibition",
  statement: "机构不得在2026年12月31日前收取超过10%的费用。",
  claimType: "regulatory_fact",
  sourceAnchors: [
    {
      sourceId: "REG-1",
      sourceType: "regulatory_text",
      page: 12,
      article: "第八条",
      paragraphIndex: 0,
      quote: "机构不得在 2026年12月31日前\n收取超过 10% 的费用。",
    },
  ],
  inferenceParents: [],
  reviewStatus: "unreviewed",
  requiredReview: true,
  revisionRecords: [],
  ...overrides,
});

const resultFor = (
  candidate: Finding,
  index = createSourceIndex({ sources, parsedUnits, findings: [candidate] }),
) =>
  Object.fromEntries(
    validateFinding(candidate, index).map((result) => [result.rule, result]),
  );

describe("validateFinding", () => {
  test("preserves numeric token boundaries while normalizing layout whitespace", () => {
    expect(normalizeText("额度为 1 0 万元")).not.toBe(
      normalizeText("额度为10万元"),
    );
    expect(normalizeText("额度为 1 亿元")).toBe(normalizeText("额度为1亿元"));
    expect(normalizeText("机构应当\n建立 制度")).toBe(
      normalizeText("机构应当建立制度"),
    );
    expect(normalizeText("A B")).not.toBe(normalizeText("AB"));
    expect(normalizeText("机\n构应当建立制度Ａ")).toBe(
      normalizeText("机构应当建立制度A"),
    );

    const numericSource: SourceUnit = {
      sourceId: "REG-NUMERIC",
      sourceType: "regulatory_text",
      title: "合成金额文件",
      content: "额度为10万元。",
    };
    const numericUnit: ParsedSourceUnit = {
      sourceId: "REG-NUMERIC",
      sourceType: "regulatory_text",
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: "额度为10万元。",
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const spacedQuote = finding({
      statement: "额度为10万元。",
      sourceAnchors: [
        {
          sourceId: "REG-NUMERIC",
          sourceType: "regulatory_text",
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: "额度为1 0万元。",
        },
      ],
    });
    const results = resultFor(
      spacedQuote,
      createSourceIndex({
        sources: [numericSource],
        parsedUnits: [numericUnit],
        findings: [spacedQuote],
      }),
    );
    expect(results.quote_match.passed).toBe(false);
  });

  test("extracts ordered protected values and excludes ambiguous single-character prose modals", () => {
    expect(
      extractNumbers(
        "上限为１亿元，不是１万元，共十项，比例１０％，另有百分之十，误差千分之一点五。",
      ),
    ).toEqual([
      "100000000元",
      "10000元",
      "10项",
      "0.1比例",
      "0.1比例",
      "0.0015比例",
    ]);
    expect(extractNumbers("人民币一点五亿元")).toEqual(["150000000元"]);
    expect(extractNumbers("一万亿元与一百万元")).toEqual([
      "1000000000000元",
      "1000000元",
    ]);
    expect(extractDates("二〇二六年一月一日生效")).toContain("2026-01-01");
    expect(
      extractModalTerms("可以、宜、应、须、应当、必须、不得、禁止、严禁"),
    ).toEqual(["可以", "宜", "应当", "必须", "不得", "禁止", "严禁"]);
    expect(
      extractModalTerms(
        "响应、供应、适应、对应、相应、应诉、应收、应变均不是模态词；机构应建立制度，可以办理。",
      ),
    ).toEqual(["可以"]);
  });

  test("protects every prose 应/须 occurrence by ordered clause context without classifying compounds", () => {
    const proseSource: SourceUnit = {
      sourceId: "REG-SINGLE-PROSE",
      sourceType: "regulatory_text",
      title: "合成单字语境文件",
      content: "机构应建立制度；操作人员阅读须知并作出相应响应。",
    };
    const proseUnit: ParsedSourceUnit = {
      sourceId: proseSource.sourceId,
      sourceType: proseSource.sourceType,
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: proseSource.content,
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const proseFinding = finding({
      statement: proseSource.content,
      sourceAnchors: [
        {
          sourceId: proseSource.sourceId,
          sourceType: proseSource.sourceType,
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: proseSource.content,
        },
      ],
    });
    const proseIndex = createSourceIndex({
      sources: [proseSource],
      parsedUnits: [proseUnit],
      findings: [proseFinding],
    });

    expect(resultFor(proseFinding, proseIndex).modal_strength.passed).toBe(
      true,
    );
    expect(
      resultFor(
        {
          ...proseFinding,
          statement: "机构建立制度；操作人员阅读须知并作出相应响应。",
        },
        proseIndex,
      ).modal_strength.passed,
    ).toBe(false);

    const responseSource: SourceUnit = {
      ...proseSource,
      sourceId: "REG-RESPONSE",
      content: "系统响应告警。",
    };
    const responseUnit: ParsedSourceUnit = {
      ...proseUnit,
      sourceId: responseSource.sourceId,
      text: responseSource.content,
    };
    const invented = finding({
      statement: "系统应响应告警。",
      sourceAnchors: [
        {
          sourceId: responseSource.sourceId,
          sourceType: responseSource.sourceType,
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: responseSource.content,
        },
      ],
    });
    expect(
      resultFor(
        invented,
        createSourceIndex({
          sources: [responseSource],
          parsedUnits: [responseUnit],
          findings: [invented],
        }),
      ).modal_strength.passed,
    ).toBe(false);
  });

  test("rejects swapping protected values between clause subjects or changing multiplicity", () => {
    const evidenceText =
      "甲机构不得在2026年1月1日超过1亿元；乙机构可以在2027年1月1日超过1万元。";
    const evidenceSource: SourceUnit = {
      sourceId: "REG-ORDERED",
      sourceType: "regulatory_text",
      title: "合成顺序文件",
      content: evidenceText,
    };
    const evidenceUnit: ParsedSourceUnit = {
      sourceId: evidenceSource.sourceId,
      sourceType: evidenceSource.sourceType,
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: evidenceText,
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const swapped = finding({
      statement:
        "甲机构不得在2026年1月1日超过1万元；乙机构可以在2027年1月1日超过1亿元。",
      sourceAnchors: [
        {
          sourceId: evidenceSource.sourceId,
          sourceType: evidenceSource.sourceType,
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: evidenceText,
        },
      ],
    });
    const results = resultFor(
      swapped,
      createSourceIndex({
        sources: [evidenceSource],
        parsedUnits: [evidenceUnit],
        findings: [swapped],
      }),
    );

    expect(results.modal_strength.passed).toBe(false);
    expect(results.numbers.passed).toBe(false);

    const datesSwapped = finding({
      ...swapped,
      statement:
        "甲机构不得在2027年1月1日超过1亿元；乙机构可以在2026年1月1日超过1万元。",
    });
    const dateResults = resultFor(
      datesSwapped,
      createSourceIndex({
        sources: [evidenceSource],
        parsedUnits: [evidenceUnit],
        findings: [datesSwapped],
      }),
    );
    expect(dateResults.dates.passed).toBe(false);

    const duplicated = finding({
      ...swapped,
      statement:
        "甲机构不得在2026年1月1日超过1亿元和1亿元；乙机构可以在2027年1月1日超过1万元。",
    });
    const duplicateResults = resultFor(
      duplicated,
      createSourceIndex({
        sources: [evidenceSource],
        parsedUnits: [evidenceUnit],
        findings: [duplicated],
      }),
    );
    expect(duplicateResults.numbers.passed).toBe(false);
  });

  test("keeps quote matching independent from contradictory modal, date, and amount evidence", () => {
    const evidenceText = "机构不得超过1亿元，二〇二六年一月一日生效。";
    const evidenceSource: SourceUnit = {
      sourceId: "REG-SEMANTIC",
      sourceType: "regulatory_text",
      title: "合成语义文件",
      content: evidenceText,
    };
    const evidenceUnit: ParsedSourceUnit = {
      sourceId: "REG-SEMANTIC",
      sourceType: "regulatory_text",
      page: 2,
      article: null,
      paragraphIndex: 0,
      text: evidenceText,
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const contradictory = finding({
      statement: "机构严禁超过1万元，2026年1月2日生效。",
      sourceAnchors: [
        {
          sourceId: "REG-SEMANTIC",
          sourceType: "regulatory_text",
          page: 2,
          article: null,
          paragraphIndex: 0,
          quote: evidenceText,
        },
      ],
    });
    const results = resultFor(
      contradictory,
      createSourceIndex({
        sources: [evidenceSource],
        parsedUnits: [evidenceUnit],
        findings: [contradictory],
      }),
    );

    expect(results.quote_match.passed).toBe(true);
    expect(results.modal_strength.passed).toBe(false);
    expect(results.dates.passed).toBe(false);
    expect(results.numbers.passed).toBe(false);
  });

  test("fails closed on a generic paraphrase whose protected amount is not directly supported", () => {
    const evidenceText = "费用最高为100000000元。";
    const evidenceSource: SourceUnit = {
      sourceId: "REG-PARAPHRASE",
      sourceType: "regulatory_text",
      title: "合成金额文件",
      content: evidenceText,
    };
    const evidenceUnit: ParsedSourceUnit = {
      sourceId: evidenceSource.sourceId,
      sourceType: evidenceSource.sourceType,
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: evidenceText,
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const paraphrase = finding({
      statement: "额度上限为一亿元。",
      sourceAnchors: [
        {
          sourceId: evidenceSource.sourceId,
          sourceType: evidenceSource.sourceType,
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: evidenceText,
        },
      ],
    });
    const results = resultFor(
      paraphrase,
      createSourceIndex({
        sources: [evidenceSource],
        parsedUnits: [evidenceUnit],
        findings: [paraphrase],
      }),
    );

    expect(results.quote_match.passed).toBe(true);
    expect(results.numbers.passed).toBe(false);
    expect(results.modal_strength.passed).toBe(false);
  });

  test("accepts equivalent Arabic and Chinese-numeral dates without changing the date", () => {
    const evidenceText = "本办法自二〇二六年一月一日起施行。";
    const source: SourceUnit = {
      sourceId: "REG-CN-DATE",
      sourceType: "regulatory_text",
      title: "合成中文日期文件",
      content: evidenceText,
    };
    const unit: ParsedSourceUnit = {
      sourceId: "REG-CN-DATE",
      sourceType: "regulatory_text",
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: evidenceText,
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const equivalent = finding({
      statement: "本办法自2026年1月1日起施行。",
      sourceAnchors: [
        {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: evidenceText,
        },
      ],
    });
    const results = resultFor(
      equivalent,
      createSourceIndex({
        sources: [source],
        parsedUnits: [unit],
        findings: [equivalent],
      }),
    );
    expect(results.dates.passed).toBe(true);
    expect(results.numbers.passed).toBe(true);
  });

  test("normalizes full-width text and line breaks without changing dates, numbers, or modal words", () => {
    const results = resultFor(finding());

    expect(results.quote_match).toMatchObject({
      passed: true,
      severity: "info",
    });
    expect(results.modal_strength).toMatchObject({ passed: true });
    expect(results.dates).toMatchObject({ passed: true });
    expect(results.numbers).toMatchObject({ passed: true });
  });

  test("fails when a prohibition is weakened", () => {
    const results = resultFor(
      finding({ statement: "机构不应在2026年12月31日前收取超过10%的费用。" }),
    );

    expect(results.modal_strength).toMatchObject({
      passed: false,
      severity: "error",
    });
  });

  test("uses the linked AtomicRequirement strength instead of trusting matching prose", () => {
    const strictFinding = finding({
      category: "atomic_requirement",
      statement: "机构严禁在2026年12月31日前收取超过10%的费用。",
      sourceAnchors: [
        {
          ...finding().sourceAnchors[0],
          quote: "机构严禁在2026年12月31日前收取超过10%的费用。",
        },
      ],
    });
    const strictSource: SourceUnit = {
      ...sources[0],
      content: strictFinding.sourceAnchors[0].quote,
    };
    const strictUnit: ParsedSourceUnit = {
      ...parsedUnits[0],
      text: strictFinding.sourceAnchors[0].quote,
    };
    const atomic: AtomicRequirement = {
      requirementId: "AR-F1",
      findingId: "F1",
      subject: "机构",
      action: "收取",
      object: "费用",
      condition: "2026年12月31日前",
      frequency: null,
      deadline: "2026年12月31日",
      strength: "不得",
      responsibility: null,
      exceptions: null,
      sharedContext: null,
      missingFacts: [],
      sourceAnchors: strictFinding.sourceAnchors,
      confidence: 1,
      manualVerificationRequired: false,
    };
    const wrongStrength = createSourceIndex({
      sources: [strictSource],
      parsedUnits: [strictUnit],
      findings: [strictFinding],
      atomicRequirements: [atomic],
    });
    expect(resultFor(strictFinding, wrongStrength).modal_strength.passed).toBe(
      false,
    );
    const missingAtomic = createSourceIndex({
      sources: [strictSource],
      parsedUnits: [strictUnit],
      findings: [strictFinding],
    });
    expect(resultFor(strictFinding, missingAtomic).modal_strength.passed).toBe(
      false,
    );
    const correctStrength = createSourceIndex({
      sources: [strictSource],
      parsedUnits: [strictUnit],
      findings: [strictFinding],
      atomicRequirements: [{ ...atomic, strength: "严禁" }],
    });
    expect(
      resultFor(strictFinding, correctStrength).modal_strength.status,
    ).toBe("manual_review_required");

    const singleStrengthFinding = finding({
      category: "atomic_requirement",
      statement: "机构应建立管理制度。",
      sourceAnchors: [
        {
          sourceId: "REG-SINGLE-STRENGTH",
          sourceType: "regulatory_text",
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: "机构应建立管理制度。",
        },
      ],
    });
    const singleStrengthSource: SourceUnit = {
      sourceId: "REG-SINGLE-STRENGTH",
      sourceType: "regulatory_text",
      title: "合成单字强度文件",
      content: singleStrengthFinding.statement,
    };
    const singleStrengthUnit: ParsedSourceUnit = {
      sourceId: singleStrengthSource.sourceId,
      sourceType: singleStrengthSource.sourceType,
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: singleStrengthFinding.statement,
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const singleStrengthAtomic: AtomicRequirement = {
      ...atomic,
      findingId: singleStrengthFinding.findingId,
      subject: "机构",
      action: "建立",
      object: "管理制度",
      condition: null,
      deadline: null,
      strength: "应",
      sourceAnchors: singleStrengthFinding.sourceAnchors,
    };
    const singleStrengthIndex = createSourceIndex({
      sources: [singleStrengthSource],
      parsedUnits: [singleStrengthUnit],
      findings: [singleStrengthFinding],
      atomicRequirements: [singleStrengthAtomic],
    });
    expect(
      resultFor(singleStrengthFinding, singleStrengthIndex).modal_strength
        .status,
    ).toBe("manual_review_required");

    const singleCharacterCases = [
      {
        strength: "应",
        action: "建立",
        object: "管理制度",
        condition: null,
        frequency: null,
        text: "机构应建立管理制度。",
        expected: true,
      },
      {
        strength: "须",
        action: "报告",
        object: "重大事项",
        condition: null,
        frequency: null,
        text: "机构须报告重大事项。",
        expected: true,
      },
      {
        strength: "应",
        action: "建立",
        object: "管理制度",
        condition: null,
        frequency: null,
        text: "机构应，建立管理制度。",
        expected: true,
      },
      {
        strength: "应",
        action: "建立",
        object: "制度",
        condition: "在必要时",
        frequency: null,
        text: "机构在必要时应建立制度。",
        expected: true,
      },
      {
        strength: "应",
        action: "建立",
        object: "制度",
        condition: null,
        frequency: "及时",
        text: "机构应及时建立制度。",
        expected: true,
      },
      {
        strength: "应",
        action: "建立",
        object: "制度",
        condition: null,
        frequency: null,
        text: "机构应及时建立制度。",
        expected: false,
      },
      {
        strength: "应",
        action: "建立",
        object: "管理制度",
        condition: null,
        frequency: null,
        text: "机构作出相应安排并建立管理制度。",
        expected: false,
      },
      {
        strength: "须",
        action: "报告",
        object: "重大事项",
        condition: null,
        frequency: null,
        text: "机构阅读须知后报告重大事项。",
        expected: false,
      },
      {
        strength: "应",
        action: "建立",
        object: "制度",
        condition: null,
        frequency: null,
        text: "机构制度，应。",
        expected: false,
      },
      {
        strength: "应",
        action: "建立",
        object: "制度",
        condition: null,
        frequency: null,
        text: "机构建立制度后应。",
        expected: false,
      },
    ] as const;
    for (const [caseIndex, item] of singleCharacterCases.entries()) {
      const caseSource: SourceUnit = {
        sourceId: `REG-SINGLE-ATOMIC-${caseIndex}`,
        sourceType: "regulatory_text",
        title: "合成原子要求文件",
        content: item.text,
      };
      const caseAnchor = {
        sourceId: caseSource.sourceId,
        sourceType: caseSource.sourceType,
        page: 1,
        article: null,
        paragraphIndex: 0,
        quote: item.text,
      } as const;
      const caseFinding = finding({
        category: "atomic_requirement",
        statement: item.text,
        sourceAnchors: [caseAnchor],
      });
      const caseRequirement: AtomicRequirement = {
        ...singleStrengthAtomic,
        strength: item.strength,
        action: item.action,
        object: item.object,
        condition: item.condition,
        frequency: item.frequency,
        sourceAnchors: [caseAnchor],
      };
      const caseIndexValue = createSourceIndex({
        sources: [caseSource],
        parsedUnits: [
          {
            ...singleStrengthUnit,
            sourceId: caseSource.sourceId,
            text: item.text,
          },
        ],
        findings: [caseFinding],
        atomicRequirements: [caseRequirement],
      });
      expect(resultFor(caseFinding, caseIndexValue).modal_strength.status).toBe(
        "manual_review_required",
      );
    }
  });

  test("requires manual review for single-character atomic strength and lexical compositions", () => {
    const validateAtomic = (
      text: string,
      fields: Partial<AtomicRequirement>,
    ) => {
      const sourceId = `REG-ATOMIC-${text}`;
      const source: SourceUnit = {
        sourceId,
        sourceType: "regulatory_text",
        title: "合成原子结构文件",
        content: text,
      };
      const anchor = {
        sourceId,
        sourceType: "regulatory_text" as const,
        page: 1,
        article: null,
        paragraphIndex: 0,
        quote: text,
      };
      const candidate = finding({
        category: "atomic_requirement",
        statement: text,
        sourceAnchors: [anchor],
      });
      const requirement: AtomicRequirement = {
        requirementId: `AR-${sourceId}`,
        findingId: candidate.findingId,
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
        manualVerificationRequired: false,
        ...fields,
      };
      return resultFor(
        candidate,
        createSourceIndex({
          sources: [source],
          parsedUnits: [
            {
              sourceId,
              sourceType: "regulatory_text",
              page: 1,
              article: null,
              paragraphIndex: 0,
              text,
              extractionMethod: "text_layer",
              confidence: 1,
            },
          ],
          findings: [candidate],
          atomicRequirements: [requirement],
        }),
      );
    };

    for (const [text, fields] of [
      ["机构应建立制度。", {}],
      [
        "机构相应办理业务。",
        { condition: "相", action: "办理", object: "业务" },
      ],
      [
        "机构办事须知。",
        { condition: "办事", strength: "须", action: "知", object: null },
      ],
    ] as const) {
      const results = validateAtomic(text, fields);
      expect(results.modal_strength).toMatchObject({
        status: "manual_review_required",
        passed: false,
      });
      expect(results.atomic_structure).toMatchObject({
        status: "manual_review_required",
        passed: false,
      });
    }
  });

  test("only auto-passes a longer atomic strength with unique lossless source coverage", () => {
    const cases = [
      {
        text: "机构不得开展业务。",
        fields: { strength: "不得", action: "开展", object: "业务" },
        expected: "passed",
      },
      {
        text: "机构必须及时报告事项。",
        fields: {
          strength: "必须",
          frequency: "及时",
          sharedContext: "及时",
          action: "报告",
          object: "事项",
        },
        expected: "manual_review_required",
      },
      {
        text: "机构不得开展未经授权的业务。",
        fields: { strength: "不得", action: "开展", object: "业务" },
        expected: "manual_review_required",
      },
      {
        text: "A B不得开展业务。",
        fields: {
          subject: "AB",
          strength: "不得",
          action: "开展",
          object: "业务",
        },
        expected: "failed",
      },
    ] as const;

    for (const [caseIndex, item] of cases.entries()) {
      const sourceId = `REG-LOSSLESS-${caseIndex}`;
      const source: SourceUnit = {
        sourceId,
        sourceType: "regulatory_text",
        title: "合成无损覆盖文件",
        content: item.text,
      };
      const anchor = {
        sourceId,
        sourceType: "regulatory_text" as const,
        page: 1,
        article: null,
        paragraphIndex: 0,
        quote: item.text,
      };
      const candidate = finding({
        category: "atomic_requirement",
        statement: item.text,
        sourceAnchors: [anchor],
      });
      const requirement: AtomicRequirement = {
        requirementId: `AR-${caseIndex}`,
        findingId: candidate.findingId,
        subject: "subject" in item.fields ? item.fields.subject : "机构",
        action: item.fields.action,
        object: item.fields.object,
        condition: null,
        frequency: "frequency" in item.fields ? item.fields.frequency : null,
        deadline: null,
        strength: item.fields.strength,
        responsibility: null,
        exceptions: null,
        sharedContext:
          "sharedContext" in item.fields ? item.fields.sharedContext : null,
        missingFacts: [],
        sourceAnchors: [anchor],
        confidence: 1,
        manualVerificationRequired: false,
      };
      const results = resultFor(
        candidate,
        createSourceIndex({
          sources: [source],
          parsedUnits: [
            {
              sourceId,
              sourceType: "regulatory_text",
              page: 1,
              article: null,
              paragraphIndex: 0,
              text: item.text,
              extractionMethod: "text_layer",
              confidence: 1,
            },
          ],
          findings: [candidate],
          atomicRequirements: [requirement],
        }),
      );

      expect(results.atomic_structure.status).toBe(item.expected);
      expect(results.modal_strength.status).toBe(item.expected);
    }
  });

  test("uses parsed locators to distinguish the same quote on different pages", () => {
    const page18 = finding({
      sourceAnchors: [
        {
          sourceId: "REG-1",
          sourceType: "regulatory_text",
          page: 18,
          article: "第十八条",
          paragraphIndex: 0,
          quote: "重复条款。",
        },
      ],
      statement: "重复条款。",
    });
    const page18Results = resultFor(page18);
    expect(page18Results.locator_page.passed).toBe(true);
    expect(page18Results.locator_article.passed).toBe(true);
    expect(page18Results.quote_match.passed).toBe(true);

    const conflicting = finding({
      sourceAnchors: [
        {
          ...page18.sourceAnchors[0],
          article: "第十七条",
        },
      ],
      statement: "重复条款。",
    });
    const conflictResults = resultFor(conflicting);
    expect(conflictResults.locator_article.passed).toBe(false);
    expect(conflictResults.quote_match.passed).toBe(false);
  });

  test("fails closed when parsed locator data is absent", () => {
    const results = resultFor(
      finding(),
      createSourceIndex({ sources, parsedUnits: [], findings: [finding()] }),
    );

    expect(results.locator_page.passed).toBe(false);
    expect(results.locator_paragraph.passed).toBe(false);
    expect(results.locator_article.passed).toBe(false);
    expect(results.quote_match).toMatchObject({
      passed: false,
      severity: "error",
    });
    expect(results.quote_match.message).toContain("待校验");
  });

  test("rejects a parsed unit whose text is not authorized by the file-level source", () => {
    const forgedUnit: ParsedSourceUnit = {
      ...parsedUnits[0],
      text: "第八条 机构不得在2026年12月31日前收取超过10%的费用。伪造附加内容。",
    };
    const forgedFinding = finding({
      statement: forgedUnit.text,
      sourceAnchors: [
        {
          ...finding().sourceAnchors[0],
          quote: forgedUnit.text,
        },
      ],
    });
    const index = createSourceIndex({
      sources,
      parsedUnits: [forgedUnit],
      findings: [forgedFinding],
    });

    expect(resultFor(forgedFinding, index).quote_match.passed).toBe(false);
  });

  test("validates the exact authorized source ID and source type", () => {
    const missingSource = finding({
      sourceAnchors: [
        { ...finding().sourceAnchors[0], sourceId: "REG-DELETED" },
      ],
    });
    expect(resultFor(missingSource).source_id.passed).toBe(false);

    const wrongType = finding({
      sourceAnchors: [
        {
          ...finding().sourceAnchors[0],
          sourceType: "official_interpretation",
        },
      ],
    });
    expect(resultFor(wrongType).source_type.passed).toBe(false);
  });

  test("rejects changed dates and numbers even when the quote is otherwise authorized", () => {
    const changed = finding({
      statement: "机构不得在2027年12月31日前收取超过11%的费用。",
    });
    const results = resultFor(changed);

    expect(results.dates.passed).toBe(false);
    expect(results.numbers.passed).toBe(false);
  });

  test("validates AI inference parents and requires its anchors to come from those parents", () => {
    const parent = finding({ findingId: "PARENT" });
    const inference = finding({
      findingId: "INFERENCE",
      category: "institution_impact:process",
      statement: "可能需要评估流程维度的相关影响（AI推导）。",
      claimType: "ai_inference",
      inferenceParents: ["PARENT"],
      sourceAnchors: parent.sourceAnchors,
    });
    const index = createSourceIndex({
      sources,
      parsedUnits,
      findings: [parent, inference],
    });
    expect(resultFor(inference, index).inference_parent.passed).toBe(true);

    const orphan = { ...inference, inferenceParents: ["MISSING"] };
    expect(resultFor(orphan, index).inference_parent.passed).toBe(false);
  });

  test("validates non-AI provenance links when an official explanation names primary parents", () => {
    const official = finding({
      findingId: "OFFICIAL",
      category: "official_context:policy_background",
      statement: "官方解读说明政策目标。",
      claimType: "official_explanation",
      inferenceParents: ["MISSING-PRIMARY"],
      sourceAnchors: [
        {
          sourceId: "OFF-1",
          sourceType: "official_interpretation",
          page: null,
          article: null,
          paragraphIndex: 0,
          quote: "官方解读说明政策目标。",
        },
      ],
    });
    const officialUnit: ParsedSourceUnit = {
      sourceId: "OFF-1",
      sourceType: "official_interpretation",
      page: null,
      article: null,
      paragraphIndex: 0,
      text: "官方解读说明政策目标。",
      extractionMethod: "docx_xml",
      confidence: 1,
    };
    const index = createSourceIndex({
      sources,
      parsedUnits: [...parsedUnits, officialUnit],
      findings: [official],
    });

    expect(resultFor(official, index).inference_parent.passed).toBe(false);
  });

  test("requires official explanations to reference authorized regulatory-primary parents", () => {
    const parent = finding({ findingId: "PRIMARY" });
    const official = finding({
      findingId: "OFFICIAL",
      category: "official_context:policy_background",
      statement: "官方解读说明政策目标。",
      claimType: "official_explanation",
      inferenceParents: ["PRIMARY"],
      sourceAnchors: [
        {
          sourceId: "OFF-1",
          sourceType: "official_interpretation",
          page: null,
          article: null,
          paragraphIndex: 0,
          quote: "官方解读说明政策目标。",
        },
      ],
    });
    const officialUnit: ParsedSourceUnit = {
      sourceId: "OFF-1",
      sourceType: "official_interpretation",
      page: null,
      article: null,
      paragraphIndex: 0,
      text: official.statement,
      extractionMethod: "docx_xml",
      confidence: 1,
    };
    const evidenceIndex = (
      parents: Finding[],
      pairing?: Readonly<Record<string, readonly string[]>>,
    ) =>
      createSourceIndex({
        sources,
        parsedUnits: [...parsedUnits, officialUnit],
        findings: [...parents, official],
        officialPrimarySourceIds: pairing,
      });

    expect(
      resultFor({ ...official, inferenceParents: [] }, evidenceIndex([parent]))
        .inference_parent.passed,
    ).toBe(false);
    expect(
      resultFor(
        official,
        evidenceIndex([{ ...parent, claimType: "official_explanation" }]),
      ).inference_parent.passed,
    ).toBe(false);
    expect(
      resultFor(
        official,
        evidenceIndex([{ ...parent, claimType: "ai_inference" }]),
      ).inference_parent.passed,
    ).toBe(false);
    expect(
      resultFor(official, evidenceIndex([parent])).inference_parent.passed,
    ).toBe(false);
    expect(
      resultFor(official, evidenceIndex([parent], { "OFF-1": ["OTHER-REG"] }))
        .inference_parent.passed,
    ).toBe(false);
    expect(
      resultFor(official, evidenceIndex([parent], { "OFF-1": ["REG-1"] }))
        .inference_parent.passed,
    ).toBe(true);
  });

  test("does not apply a primary parent's modal words to an official explanation", () => {
    const parent = finding({ findingId: "PRIMARY" });
    const excerpt = "官方解读说明政策目标。";
    const official = finding({
      findingId: "OFFICIAL",
      category: "official_context:policy_background",
      statement: `官方解读材料摘录（政策背景）：“${excerpt}”。该摘录仅作为官方说明材料，不建立或覆盖监管文件效力、适用性或其他法律结论，须经人工合规复核。`,
      claimType: "official_explanation",
      inferenceParents: ["PRIMARY"],
      sourceAnchors: [
        {
          sourceId: "OFF-1",
          sourceType: "official_interpretation",
          page: null,
          article: null,
          paragraphIndex: 0,
          quote: excerpt,
        },
      ],
    });
    const officialUnit: ParsedSourceUnit = {
      sourceId: "OFF-1",
      sourceType: "official_interpretation",
      page: null,
      article: null,
      paragraphIndex: 0,
      text: excerpt,
      extractionMethod: "docx_xml",
      confidence: 1,
    };
    const index = createSourceIndex({
      sources,
      parsedUnits: [...parsedUnits, officialUnit],
      findings: [parent, official],
      officialPrimarySourceIds: { "OFF-1": ["REG-1"] },
    });

    const results = resultFor(official, index);
    expect(results.inference_parent.passed).toBe(true);
    expect(results.modal_strength.passed).toBe(true);
  });

  test("validates the actual Task 7 official wrapper with a paired pending regulatory parent", () => {
    const regulatorySource: SourceUnit = {
      sourceId: "REG-TASK7",
      sourceType: "regulatory_text",
      title: "合成监管文件",
      content: "《监管办法》",
    };
    const officialSource: SourceUnit = {
      sourceId: "OFF-TASK7",
      sourceType: "official_interpretation",
      title: "合成官方解读",
      content: "供应安排比例为百分之十。",
    };
    const regulatoryUnit: ParsedSourceUnit = {
      sourceId: "REG-TASK7",
      sourceType: "regulatory_text",
      page: 1,
      article: null,
      paragraphIndex: 0,
      text: "《监管办法》",
      extractionMethod: "text_layer",
      confidence: 1,
    };
    const officialUnit: ParsedSourceUnit = {
      sourceId: "OFF-TASK7",
      sourceType: "official_interpretation",
      page: null,
      article: null,
      paragraphIndex: 0,
      text: officialSource.content,
      extractionMethod: "docx_xml",
      confidence: 1,
    };
    const parent: Finding = {
      ...finding(),
      findingId: "EXTRACTED-TITLE",
      category: "pending_confirmation:document_identity:document_title",
      statement:
        "待确认的文件身份提取（文件名称）：原文摘录“《监管办法》”。该提取仅保留证据，不构成已确认的文件身份、效力、适用性或其他法律结论，须经人工合规复核后方可确认。",
      claimType: "pending_confirmation",
      sourceAnchors: [
        {
          sourceId: "REG-TASK7",
          sourceType: "regulatory_text",
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: "《监管办法》",
        },
      ],
    };
    const official: Finding = {
      ...finding(),
      findingId: "OFFICIAL-EXCERPT",
      category: "official_context:implementation_guidance",
      statement: `官方解读材料摘录（实施说明）：“${officialSource.content}”。该摘录仅作为官方说明材料，不建立或覆盖监管文件效力、适用性或其他法律结论，须经人工合规复核。`,
      claimType: "official_explanation",
      sourceAnchors: [
        {
          sourceId: "OFF-TASK7",
          sourceType: "official_interpretation",
          page: null,
          article: null,
          paragraphIndex: 0,
          quote: officialSource.content,
        },
      ],
      inferenceParents: [parent.findingId],
    };
    const indexFor = (pairing?: OfficialPrimarySourceIds) =>
      createSourceIndex({
        sources: [regulatorySource, officialSource],
        parsedUnits: [regulatoryUnit, officialUnit],
        findings: [parent, official],
        officialPrimarySourceIds: pairing,
      });

    const valid = resultFor(
      official,
      indexFor({
        "OFF-TASK7": ["REG-TASK7"],
      }),
    );
    expect(valid.quote_match.passed).toBe(true);
    expect(valid.modal_strength.passed).toBe(true);
    expect(valid.numbers.passed).toBe(true);
    expect(valid.inference_parent.passed).toBe(true);
    expect(resultFor(official, indexFor()).inference_parent.passed).toBe(false);
    expect(
      resultFor(official, indexFor({ "OFF-TASK7": ["OTHER-REGULATORY"] }))
        .inference_parent.passed,
    ).toBe(false);
  });

  test("always returns the complete stable rule set with messages and severities", () => {
    expect(
      validateFinding(finding(), createSourceIndex({ sources, parsedUnits })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "source_id",
          status: expect.stringMatching(
            /^(passed|failed|manual_review_required)$/,
          ),
          passed: expect.any(Boolean),
          message: expect.any(String),
          severity: expect.stringMatching(/^(info|warning|error)$/),
        }),
      ]),
    );
    expect(
      validateFinding(
        finding(),
        createSourceIndex({ sources, parsedUnits }),
      ).map(({ rule }) => rule),
    ).toEqual([
      "source_id",
      "source_type",
      "locator_page",
      "locator_paragraph",
      "locator_article",
      "quote_match",
      "atomic_structure",
      "modal_strength",
      "dates",
      "numbers",
      "inference_parent",
    ]);
  });

  test("uses Task 4 canonical inherited articles and rejects a raw null anchor", () => {
    const source: SourceUnit = {
      sourceId: "REG-INHERITED",
      sourceType: "regulatory_text",
      title: "合成继承条款.txt",
      content: "第一条 合成总则。\n后续段落应当保存记录。",
    };
    const units: ParsedSourceUnit[] = [
      {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        page: 1,
        article: null,
        paragraphIndex: 0,
        text: "第一条 合成总则。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
      {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        page: 1,
        article: null,
        paragraphIndex: 1,
        text: "后续段落应当保存记录。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
    ];
    const index = createSourceIndex({ sources: [source], parsedUnits: units });
    const anchor = {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      page: 1,
      article: "第一条",
      paragraphIndex: 1,
      quote: units[1].text,
    };

    expect(findIndexedParsedUnitForAnchor(anchor, index)?.unit).toBe(units[1]);
    expect(
      findIndexedParsedUnitForAnchor({ ...anchor, article: null }, index),
    ).toBeUndefined();
  });

  test("does not authorize a parsed unit article absent from its text", () => {
    const source: SourceUnit = {
      sourceId: "REG-UNTRUSTED-ARTICLE",
      sourceType: "regulatory_text",
      title: "合成伪条款定位.txt",
      content: "前言。\n\n银行应当保存记录。",
    };
    const units: ParsedSourceUnit[] = [
      {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        page: 1,
        article: "第九十九条",
        paragraphIndex: 0,
        text: "前言。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
      {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        page: 1,
        article: null,
        paragraphIndex: 1,
        text: "银行应当保存记录。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
    ];
    const index = createSourceIndex({ sources: [source], parsedUnits: units });
    const fabricatedAnchor = {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      page: 1,
      article: "第九十九条",
      paragraphIndex: 1,
      quote: units[1].text,
    };

    expect(
      findIndexedParsedUnitForAnchor(fabricatedAnchor, index),
    ).toBeUndefined();
  });

  test("does not let an in-sentence article reference replace canonical context", () => {
    const source: SourceUnit = {
      sourceId: "REG-ARTICLE-REFERENCE",
      sourceType: "regulatory_text",
      title: "合成条款引用.txt",
      content:
        "第五条 总则。\n\n具体流程按照第一条规定执行。\n\n第一条 新编总则。",
    };
    const units: ParsedSourceUnit[] = [
      {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        page: 1,
        article: "第五条",
        paragraphIndex: 0,
        text: "第五条 总则。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
      {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        page: 1,
        article: "第一条",
        paragraphIndex: 1,
        text: "具体流程按照第一条规定执行。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
      {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        page: 1,
        article: null,
        paragraphIndex: 2,
        text: "第一条 新编总则。",
        extractionMethod: "text_layer",
        confidence: 1,
      },
    ];
    const index = createSourceIndex({ sources: [source], parsedUnits: units });
    const continuationAnchor = {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      page: 1,
      article: "第五条",
      paragraphIndex: 1,
      quote: units[1].text,
    };
    const switchedAnchor = {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      page: 1,
      article: "第一条",
      paragraphIndex: 2,
      quote: units[2].text,
    };

    expect(
      findIndexedParsedUnitForAnchor(continuationAnchor, index)?.unit,
    ).toBe(units[1]);
    expect(findIndexedParsedUnitForAnchor(switchedAnchor, index)?.unit).toBe(
      units[2],
    );
    expect(
      findIndexedParsedUnitForAnchor(
        { ...continuationAnchor, article: "第一条" },
        index,
      ),
    ).toBeUndefined();
  });
});
