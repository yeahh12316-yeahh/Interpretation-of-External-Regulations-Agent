import type { Finding } from "../../domain/finding";
import type { SourceAnchor } from "../../domain/source";
import { FindingSchema } from "../../domain/schemas";

const normalized = (value: string): string =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim();

export const findingDeduplicationKey = (finding: Finding): string =>
  JSON.stringify([
    finding.claimType,
    normalized(finding.category),
    normalized(finding.statement),
  ]);

const anchorKey = (anchor: SourceAnchor): string => JSON.stringify(anchor);

const uniqueAnchors = (anchors: readonly SourceAnchor[]): SourceAnchor[] => {
  const byKey = new Map<string, SourceAnchor>();
  for (const anchor of anchors) byKey.set(anchorKey(anchor), anchor);
  return [...byKey.values()];
};

const uniqueStrings = (values: readonly string[]): string[] => [
  ...new Set(values),
];

export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const mergedByKey = new Map<string, Finding>();

  for (const candidate of findings) {
    const valid = FindingSchema.parse(candidate);
    const key = findingDeduplicationKey(valid);
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, valid);
      continue;
    }

    mergedByKey.set(
      key,
      FindingSchema.parse({
        ...existing,
        sourceAnchors: uniqueAnchors([
          ...existing.sourceAnchors,
          ...valid.sourceAnchors,
        ]),
        inferenceParents: uniqueStrings([
          ...existing.inferenceParents,
          ...valid.inferenceParents,
        ]),
        requiredReview: existing.requiredReview || valid.requiredReview,
        revisionRecords: [
          ...existing.revisionRecords,
          ...valid.revisionRecords,
        ],
      }),
    );
  }

  return [...mergedByKey.values()];
}
