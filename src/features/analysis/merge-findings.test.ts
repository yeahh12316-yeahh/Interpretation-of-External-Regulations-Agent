import { describe, expect, it } from "vitest";

import type { Finding } from "../../domain/finding";
import { FindingSchema } from "../../domain/schemas";
import { mergeFindings } from "./merge-findings";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  findingId: "REQ-1",
  category: "core_requirement",
  statement: "商业银行应当建立风险管理制度",
  claimType: "regulatory_fact",
  sourceAnchors: [
    {
      sourceId: "REG-1",
      sourceType: "regulatory_text",
      page: 1,
      article: "第一条",
      paragraphIndex: 0,
      quote: "商业银行应当建立风险管理制度。",
    },
  ],
  inferenceParents: [],
  reviewStatus: "unreviewed",
  requiredReview: false,
  revisionRecords: [],
  ...overrides,
});

describe("mergeFindings", () => {
  it("deduplicates equivalent findings while retaining every anchor and provenance parent", () => {
    const duplicateA = finding({ inferenceParents: ["UP-1"] });
    const duplicateB = finding({
      findingId: "REQ-2",
      inferenceParents: ["UP-2"],
      sourceAnchors: [
        {
          sourceId: "REG-2",
          sourceType: "regulatory_text",
          page: 8,
          article: "第六条",
          paragraphIndex: 2,
          quote: "商业银行应当建立风险管理制度。",
        },
      ],
    });

    const merged = mergeFindings([duplicateA, duplicateB]);

    expect(merged).toHaveLength(1);
    expect(merged[0].findingId).toBe("REQ-1");
    expect(merged[0].sourceAnchors).toHaveLength(2);
    expect(merged[0].inferenceParents).toEqual(["UP-1", "UP-2"]);
    expect(() => FindingSchema.parse(merged[0])).not.toThrow();
  });

  it("does not collapse findings with different claim types or categories", () => {
    const official = finding({
      findingId: "OFF-1",
      category: "background",
      statement: "文件旨在强化风险管理",
      claimType: "official_explanation",
      sourceAnchors: [
        {
          sourceId: "OFFICIAL-1",
          sourceType: "official_interpretation",
          page: 1,
          article: null,
          paragraphIndex: 0,
          quote: "文件旨在强化风险管理。",
        },
      ],
    });
    const regulatory = finding({
      findingId: "REG-2",
      category: "core_requirement",
      statement: "文件旨在强化风险管理",
    });

    expect(mergeFindings([official, regulatory])).toHaveLength(2);
  });

  it("rejects schema-invalid input instead of silently repairing it", () => {
    const invalid = finding({ sourceAnchors: [] });

    expect(() => mergeFindings([invalid])).toThrow();
  });
});
