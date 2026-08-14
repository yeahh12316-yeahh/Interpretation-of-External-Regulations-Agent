import { describe, expect, test } from "vitest";

import type { Finding } from "../../domain/finding";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import type { ValidationResult } from "./validate-finding";
import {
  resolveValidationResults,
  ruleReviewBinding,
  RuleReviewAttestationSchema,
} from "./review-attestation";

const finding: Finding = {
  findingId: "F-ATTESTATION",
  category: "atomic_requirement",
  statement: "机构应建立制度。",
  claimType: "regulatory_fact",
  sourceAnchors: [
    {
      sourceId: "REG-ATTESTATION",
      sourceType: "regulatory_text",
      page: 1,
      article: null,
      paragraphIndex: 0,
      quote: "机构应建立制度。",
    },
  ],
  inferenceParents: [],
  reviewStatus: "confirmed",
  requiredReview: true,
  revisionRecords: [],
};

const requirement: AtomicRequirement = {
  requirementId: "AR-ATTESTATION",
  findingId: finding.findingId,
  subject: "机构",
  strength: "应",
  action: "建立",
  object: "制度",
  condition: null,
  frequency: null,
  deadline: null,
  responsibility: null,
  exceptions: null,
  sharedContext: null,
  missingFacts: [],
  sourceAnchors: finding.sourceAnchors,
  confidence: 1,
  manualVerificationRequired: false,
};

const validation = (status: ValidationResult["status"]): ValidationResult => ({
  rule: "atomic_structure",
  status,
  passed: status === "passed",
  message: "合成校验结果",
  severity: status === "passed" ? "info" : "warning",
});

const attestation = {
  ...ruleReviewBinding(finding, requirement),
  rule: "atomic_structure" as const,
  decision: "confirmed" as const,
  reviewer: "复核员",
  reviewedAt: "2026-08-15T02:00:00.000Z",
  reason: "逐字复核证据与结构化记录。",
};

describe("rule review attestation", () => {
  test("resolves only one exact current attestation and exposes confirmed or rejected", () => {
    expect(
      resolveValidationResults(
        finding,
        [validation("manual_review_required")],
        [requirement],
        [],
      )[0],
    ).toMatchObject({
      resolution: "manual_review_pending",
      effectivePassed: false,
      passed: false,
    });
    expect(
      resolveValidationResults(
        finding,
        [validation("manual_review_required")],
        [requirement],
        [
          attestation,
          {
            ...attestation,
            findingId: "F-UNRELATED",
            rule: "modal_strength",
          },
        ],
      )[0],
    ).toMatchObject({ resolution: "manual_confirmed", effectivePassed: true });
    expect(
      resolveValidationResults(
        finding,
        [validation("passed")],
        [requirement],
        [{ ...attestation, decision: "rejected" }],
      )[0],
    ).toMatchObject({ resolution: "manual_rejected", effectivePassed: false });
  });

  test("reports integrity failure for stale, duplicate, conflicting, or malformed associated records", () => {
    const variants = [
      [{ ...attestation, sourceEvidenceHash: `fnv1a64:${"0".repeat(16)}` }],
      [{ ...attestation, findingHash: `fnv1a64:${"1".repeat(16)}` }],
      [{ ...attestation, atomicRequirementHash: `fnv1a64:${"2".repeat(16)}` }],
      [attestation, { ...attestation }],
      [attestation, { ...attestation, decision: "rejected" as const }],
      [
        attestation,
        {
          ...attestation,
          sourceEvidenceHash: `fnv1a64:${"3".repeat(16)}`,
        },
      ],
      [attestation, { ...attestation, reason: "" }],
      [{ ...attestation, reason: "" }],
      [{ ...attestation, unexpected: true }],
    ];

    for (const candidate of variants) {
      expect(
        resolveValidationResults(
          finding,
          [validation("manual_review_required")],
          [requirement],
          candidate,
        )[0],
      ).toMatchObject({
        resolution: "attestation_integrity_failed",
        effectivePassed: false,
      });
    }

    expect(
      resolveValidationResults(
        finding,
        [validation("manual_review_required")],
        [requirement],
        [{ ...attestation, rule: "modal_strength" }],
      )[0],
    ).toMatchObject({
      resolution: "manual_review_pending",
      effectivePassed: false,
    });
    expect(
      RuleReviewAttestationSchema.safeParse({
        ...attestation,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  test("deep-validates malformed outer collections without throwing or silently dropping them", () => {
    const malformedCollections: unknown[] = [
      null,
      {},
      [null],
      [{}],
      [
        {
          ...attestation,
          sourceEvidenceHash: { nested: "invalid" },
        },
      ],
    ];

    for (const candidate of malformedCollections) {
      const resolve = () =>
        resolveValidationResults(
          finding,
          [validation("manual_review_required")],
          [requirement],
          candidate,
        );
      expect(resolve).not.toThrow();
      expect(
        resolve().some(
          ({ resolution }) => resolution === "attestation_integrity_failed",
        ),
      ).toBe(true);
    }
  });

  test("never permits an attestation to override a deterministic failure", () => {
    expect(
      resolveValidationResults(
        finding,
        [validation("failed")],
        [requirement],
        [{ ...attestation, decision: "rejected" }],
      )[0],
    ).toMatchObject({
      status: "failed",
      passed: false,
      resolution: "failed",
      effectivePassed: false,
    });
  });
});
