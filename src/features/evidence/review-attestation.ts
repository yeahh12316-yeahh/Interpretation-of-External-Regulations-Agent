import { z } from "zod";

import type { Finding } from "../../domain/finding";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import { evidenceDigest } from "./evidence-hash";
import type { ValidationResult, ValidationRule } from "./validate-finding";

export const ValidationRuleSchema = z.enum([
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

const digestSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);
const utcDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
  .refine((value) => !Number.isNaN(Date.parse(value)));

export const RuleReviewAttestationSchema = z
  .object({
    findingId: z.string().min(1),
    rule: ValidationRuleSchema,
    decision: z.enum(["confirmed", "rejected"]),
    sourceEvidenceHash: digestSchema,
    findingHash: digestSchema,
    atomicRequirementHash: digestSchema.nullable(),
    reviewer: z.string().trim().min(1),
    reviewedAt: utcDateTimeSchema,
    reason: z.string().trim().min(1),
  })
  .strict();

export const RuleReviewAttestationsSchema = z.array(
  RuleReviewAttestationSchema,
);

export type RuleReviewAttestation = Readonly<
  z.infer<typeof RuleReviewAttestationSchema>
>;

export interface RuleReviewBinding {
  readonly findingId: string;
  readonly sourceEvidenceHash: string;
  readonly findingHash: string;
  readonly atomicRequirementHash: string | null;
}

export const ruleReviewBinding = (
  finding: Finding,
  atomicRequirement?: AtomicRequirement,
): RuleReviewBinding => ({
  findingId: finding.findingId,
  sourceEvidenceHash: evidenceDigest(finding.sourceAnchors),
  findingHash: evidenceDigest(finding),
  atomicRequirementHash: atomicRequirement
    ? evidenceDigest(atomicRequirement)
    : null,
});

export type ValidationResolution =
  | "automatic_passed"
  | "manual_confirmed"
  | "manual_review_pending"
  | "manual_rejected"
  | "attestation_integrity_failed"
  | "failed";

export type EvidenceValidationRule = ValidationRule | "attestation_integrity";

export interface ResolvedValidationResult extends Omit<
  ValidationResult,
  "rule"
> {
  rule: EvidenceValidationRule;
  resolution: ValidationResolution;
  effectivePassed: boolean;
}

interface AttestationAssociation {
  readonly findingId: string;
  readonly rule: ValidationRule;
}

export interface AttestationIntegrityIssue {
  readonly association: AttestationAssociation | null;
  readonly message: string;
}

export interface ParsedRuleReviewAttestations {
  readonly records: readonly RuleReviewAttestation[];
  readonly issues: readonly AttestationIntegrityIssue[];
}

const associationFromUnknown = (
  value: unknown,
): AttestationAssociation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rule = ValidationRuleSchema.safeParse(record.rule);
  return typeof record.findingId === "string" &&
    record.findingId.trim().length > 0 &&
    rule.success
    ? { findingId: record.findingId, rule: rule.data }
    : null;
};

export const parseRuleReviewAttestations = (
  input: unknown,
): ParsedRuleReviewAttestations => {
  const boundaryValue = input === undefined ? [] : input;
  const entireCollection =
    RuleReviewAttestationsSchema.safeParse(boundaryValue);
  if (entireCollection.success) {
    return { records: entireCollection.data, issues: [] };
  }
  if (!Array.isArray(boundaryValue)) {
    return {
      records: [],
      issues: [
        {
          association: null,
          message: "人工确认记录集合格式无效，不能用于证据门禁。",
        },
      ],
    };
  }

  const records: RuleReviewAttestation[] = [];
  const issues: AttestationIntegrityIssue[] = [];
  for (const item of boundaryValue) {
    const parsed = RuleReviewAttestationSchema.safeParse(item);
    if (parsed.success) {
      records.push(parsed.data);
    } else {
      issues.push({
        association: associationFromUnknown(item),
        message: "人工确认记录格式无效或包含未授权字段。",
      });
    }
  }
  return { records, issues };
};

const isBoundTo = (
  attestation: RuleReviewAttestation,
  rule: ValidationRule,
  binding: RuleReviewBinding,
): boolean =>
  attestation.findingId === binding.findingId &&
  attestation.rule === rule &&
  attestation.sourceEvidenceHash === binding.sourceEvidenceHash &&
  attestation.findingHash === binding.findingHash &&
  attestation.atomicRequirementHash === binding.atomicRequirementHash;

export const resolveValidationResults = (
  finding: Finding,
  results: readonly ValidationResult[],
  atomicRequirements: readonly AtomicRequirement[] = [],
  attestations: unknown = [],
): ResolvedValidationResult[] => {
  const matchingRequirements = atomicRequirements.filter(
    ({ findingId }) => findingId === finding.findingId,
  );
  const requirement =
    matchingRequirements.length === 1 ? matchingRequirements[0] : undefined;
  const binding = ruleReviewBinding(finding, requirement);
  const imported = parseRuleReviewAttestations(attestations);
  let needsSyntheticIntegrityResult = imported.issues.some(
    ({ association }) => association === null,
  );

  const resolved = results.map((validation): ResolvedValidationResult => {
    const associatedIssues = imported.issues.filter(
      ({ association }) =>
        association?.findingId === finding.findingId &&
        association.rule === validation.rule,
    );
    const associatedRecords = imported.records.filter(
      (attestation) =>
        attestation.findingId === finding.findingId &&
        attestation.rule === validation.rule,
    );
    const exactCurrent = associatedRecords.filter((attestation) =>
      isBoundTo(attestation, validation.rule, binding),
    );
    const integrityFailed =
      associatedIssues.length > 0 ||
      associatedRecords.length > 1 ||
      (associatedRecords.length === 1 && exactCurrent.length !== 1);

    if (validation.status === "failed") {
      if (integrityFailed) needsSyntheticIntegrityResult = true;
      return { ...validation, resolution: "failed", effectivePassed: false };
    }
    if (integrityFailed) {
      return {
        ...validation,
        resolution: "attestation_integrity_failed",
        effectivePassed: false,
        message: "人工确认记录重复、陈旧、冲突或格式无效，不能用于当前规则。",
      };
    }
    if (exactCurrent[0]?.decision === "rejected") {
      return {
        ...validation,
        resolution: "manual_rejected",
        effectivePassed: false,
        message: "当前证据已被人工否决，不能用于定稿。",
      };
    }
    if (validation.status === "passed") {
      return {
        ...validation,
        resolution: "automatic_passed",
        effectivePassed: true,
      };
    }
    if (!exactCurrent[0]) {
      return {
        ...validation,
        resolution: "manual_review_pending",
        effectivePassed: false,
      };
    }
    return exactCurrent[0].decision === "confirmed"
      ? {
          ...validation,
          resolution: "manual_confirmed",
          effectivePassed: true,
        }
      : {
          ...validation,
          resolution: "manual_rejected",
          effectivePassed: false,
        };
  });

  return needsSyntheticIntegrityResult
    ? [
        ...resolved,
        {
          rule: "attestation_integrity",
          status: "failed",
          passed: false,
          message:
            "人工确认记录集合存在无法关联或与失败规则并存的完整性错误，不能用于证据门禁。",
          severity: "error",
          resolution: "attestation_integrity_failed",
          effectivePassed: false,
        },
      ]
    : resolved;
};
