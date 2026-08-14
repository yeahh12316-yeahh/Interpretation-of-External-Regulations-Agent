import { z } from "zod";

import type { Finding } from "../../domain/finding";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import { evidenceDigest } from "./evidence-hash";
import type { ValidationResult, ValidationRule } from "./validate-finding";

const ValidationRuleSchema = z.enum([
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

export type RuleReviewAttestation = Readonly<
  z.infer<typeof RuleReviewAttestationSchema>
>;

export interface RuleReviewBinding {
  findingId: string;
  sourceEvidenceHash: string;
  findingHash: string;
  atomicRequirementHash: string | null;
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
  | "failed";

export interface ResolvedValidationResult extends ValidationResult {
  resolution: ValidationResolution;
  effectivePassed: boolean;
}

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
  attestations: readonly RuleReviewAttestation[] = [],
): ResolvedValidationResult[] => {
  const matchingRequirements = atomicRequirements.filter(
    ({ findingId }) => findingId === finding.findingId,
  );
  const requirement =
    matchingRequirements.length === 1 ? matchingRequirements[0] : undefined;
  const binding = ruleReviewBinding(finding, requirement);
  const parsedAttestations = attestations.flatMap((attestation) => {
    const parsed = RuleReviewAttestationSchema.safeParse(attestation);
    return parsed.success ? [parsed.data] : [];
  });

  return results.map((validation): ResolvedValidationResult => {
    if (validation.status === "passed") {
      return {
        ...validation,
        resolution: "automatic_passed",
        effectivePassed: true,
      };
    }
    if (validation.status === "failed") {
      return { ...validation, resolution: "failed", effectivePassed: false };
    }

    const current = parsedAttestations.filter((attestation) =>
      isBoundTo(attestation, validation.rule, binding),
    );
    if (current.length !== 1) {
      return {
        ...validation,
        resolution: "manual_review_pending",
        effectivePassed: false,
      };
    }
    return current[0].decision === "confirmed"
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
};
