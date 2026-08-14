import { describe, expect, test } from "vitest";

import type { Finding } from "../../domain/finding";
import type { SourceUnit } from "../../domain/source";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import { createSourceIndex, validateFinding } from "./validate-finding";

const sources: SourceUnit[] = [
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    title: "合成监管办法.txt",
    content:
      "第八条 机构不得在2026年12月31日前收取超过10%的费用。\n\n重复条款。",
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
    text: "重复条款。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 18,
    article: "第十八条",
    paragraphIndex: 0,
    text: "重复条款。",
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

  test("does not apply a primary parent's modal words to an official explanation", () => {
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
      text: "官方解读说明政策目标。",
      extractionMethod: "docx_xml",
      confidence: 1,
    };
    const index = createSourceIndex({
      sources,
      parsedUnits: [...parsedUnits, officialUnit],
      findings: [parent, official],
    });

    const results = resultFor(official, index);
    expect(results.inference_parent.passed).toBe(true);
    expect(results.modal_strength.passed).toBe(true);
  });

  test("always returns the complete stable rule set with messages and severities", () => {
    expect(
      validateFinding(finding(), createSourceIndex({ sources, parsedUnits })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "source_id",
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
      "modal_strength",
      "dates",
      "numbers",
      "inference_parent",
    ]);
  });
});
