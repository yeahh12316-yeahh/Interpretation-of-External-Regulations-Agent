import { z } from "zod";

import type { Finding } from "../domain/finding";
import { FindingSchema } from "../domain/schemas";
import type { SourceAnchor } from "../domain/source";
import {
  AtomicRequirementSchema,
  type AtomicRequirement,
} from "../features/analysis/skill-orchestrator";
import { evidenceDigest } from "../features/evidence/evidence-hash";
import { normalizeText } from "../features/evidence/normalize-text";

export interface EvaluationOcrPage {
  readonly sourceId: string;
  readonly page: number;
  readonly text: string;
}

export interface EvaluationOcrPageReview {
  readonly sourceId: string;
  readonly page: number;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly decision: "confirmed" | "corrected";
  readonly expectedTextDigest: string;
  readonly actualTextDigest: string;
  readonly correctedText?: string;
}

export const ocrPageTextDigest = (page: EvaluationOcrPage): string =>
  evidenceDigest({ sourceId: page.sourceId, page: page.page, text: page.text });

export interface EvaluationCorpus {
  readonly findings: readonly Finding[];
  readonly atomicRequirements: readonly AtomicRequirement[];
  readonly ocrPages: readonly EvaluationOcrPage[];
  readonly ocrPageReviews: readonly EvaluationOcrPageReview[];
  readonly officialPrimarySourceIds: Readonly<Record<string, string>>;
}

const EvaluationOcrPageSchema = z
  .object({
    sourceId: z.string().min(1),
    page: z.number().int().positive(),
    text: z.string(),
  })
  .strict();

const EvaluationOcrPageReviewSchema = z
  .object({
    sourceId: z.string().trim().min(1),
    page: z.number().int().positive(),
    reviewer: z.string().trim().min(1),
    reviewedAt: z.string().datetime(),
    decision: z.enum(["confirmed", "corrected"]),
    expectedTextDigest: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    actualTextDigest: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
    correctedText: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((review, context) => {
    if ((review.decision === "corrected") !== Boolean(review.correctedText))
      context.addIssue({
        code: "custom",
        path: ["correctedText"],
        message: "corrected 决策必须且仅能提供非空 correctedText",
      });
  });

export const EvaluationCorpusSchema = z
  .object({
    findings: z.array(FindingSchema),
    atomicRequirements: z.array(AtomicRequirementSchema),
    ocrPages: z.array(EvaluationOcrPageSchema),
    ocrPageReviews: z.array(EvaluationOcrPageReviewSchema).default([]),
    officialPrimarySourceIds: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict()
  .superRefine((corpus, context) => {
    const findingIds = new Set<string>();
    corpus.findings.forEach((item, index) => {
      if (findingIds.has(item.findingId))
        context.addIssue({
          code: "custom",
          path: ["findings", index, "findingId"],
          message: "评测 Finding ID 必须唯一",
        });
      findingIds.add(item.findingId);
    });
    const atomicFindingIds = new Set<string>();
    corpus.atomicRequirements.forEach((item, index) => {
      const finding = corpus.findings.find(
        ({ findingId }) => findingId === item.findingId,
      );
      if (
        atomicFindingIds.has(item.findingId) ||
        finding?.category !== "atomic_requirement"
      )
        context.addIssue({
          code: "custom",
          path: ["atomicRequirements", index, "findingId"],
          message: "评测 AtomicRequirement 必须唯一绑定原子 Finding",
        });
      atomicFindingIds.add(item.findingId);
    });
    corpus.findings.forEach((item, index) => {
      if (
        item.category === "atomic_requirement" &&
        !atomicFindingIds.has(item.findingId)
      )
        context.addIssue({
          code: "custom",
          path: ["findings", index],
          message: "原子 Finding 缺少评测 AtomicRequirement",
        });
    });
    const ocrKeys = new Set<string>();
    corpus.ocrPages.forEach((page, index) => {
      const key = `${page.sourceId}\u0000${page.page}`;
      if (ocrKeys.has(key))
        context.addIssue({
          code: "custom",
          path: ["ocrPages", index],
          message: "OCR 评测页不得重复",
        });
      ocrKeys.add(key);
    });
    const reviewKeys = new Set<string>();
    corpus.ocrPageReviews.forEach((review, index) => {
      const key = `${review.sourceId}\u0000${review.page}`;
      if (reviewKeys.has(key))
        context.addIssue({
          code: "custom",
          path: ["ocrPageReviews", index],
          message: "同一 OCR 页只能有一条当前人工检查记录",
        });
      reviewKeys.add(key);
      const page = corpus.ocrPages.find(
        (candidate) =>
          candidate.sourceId === review.sourceId &&
          candidate.page === review.page,
      );
      if (!page)
        context.addIssue({
          code: "custom",
          path: ["ocrPageReviews", index],
          message: "人工检查记录必须绑定当前 OCR 页",
        });
      if (
        review.decision === "corrected" &&
        review.correctedText !== page?.text
      )
        context.addIssue({
          code: "custom",
          path: ["ocrPageReviews", index, "correctedText"],
          message: "correctedText 必须等于当前 OCR 页文本",
        });
    });
    const officialSourceIds = new Set(
      corpus.findings.flatMap(({ sourceAnchors }) =>
        sourceAnchors
          .filter(
            ({ sourceType }) => sourceType === "official_interpretation",
          )
          .map(({ sourceId }) => sourceId),
      ),
    );
    const pairingSourceIds = Object.keys(corpus.officialPrimarySourceIds);
    if (
      [...officialSourceIds].sort().join("\u0000") !==
      pairingSourceIds.sort().join("\u0000")
    )
      context.addIssue({
        code: "custom",
        path: ["officialPrimarySourceIds"],
        message: "官方解读来源必须逐一声明唯一监管原文配对",
      });
  });

export interface CountMetrics {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly evaluable: boolean;
}

export interface EvaluationMetrics {
  readonly critical: CountMetrics;
  readonly criticalByCategory: Readonly<Record<CriticalCategory, CountMetrics>>;
  readonly atomic: CountMetrics;
  readonly matches: readonly {
    readonly expectedFindingId: string;
    readonly actualFindingId: string;
  }[];
  readonly criticalOmissions: readonly string[];
  readonly citationValidity: {
    readonly valid: number;
    readonly total: number;
    readonly rate: number | null;
  };
  readonly unmarkedAiInferenceIds: readonly string[];
  readonly ocr: {
    readonly errors: number;
    readonly expectedCharacters: number;
    readonly accuracy: number | null;
    readonly manualReviewPages: readonly {
      readonly sourceId: string;
      readonly page: number;
    }[];
    readonly pendingManualReviewPages: readonly {
      readonly sourceId: string;
      readonly page: number;
    }[];
    readonly evaluable: boolean;
  };
  readonly releaseGate: {
    readonly passed: boolean;
    readonly failures: readonly string[];
  };
}

export const CRITICAL_CATEGORIES = [
  "core_requirement",
  "prohibition",
  "key_date",
  "transition_period",
] as const;

export type CriticalCategory = (typeof CRITICAL_CATEGORIES)[number];

const criticalCategory = (finding: Finding): CriticalCategory | null => {
  if (finding.category === "key_matter:core_requirement")
    return "core_requirement";
  if (finding.category === "key_matter:prohibition") return "prohibition";
  if (
    finding.category === "key_matter:effective_date" ||
    /^document_identity:(?:publication_date|effective_date|expiry_date|deadline)$/u.test(
      finding.category,
    )
  )
    return "key_date";
  if (finding.category === "key_matter:transition_period")
    return "transition_period";
  return null;
};

const normalizedNullable = (value: string | null): string | null =>
  value === null ? null : normalizeText(value);

const canonicalAnchor = (anchor: SourceAnchor): string =>
  JSON.stringify([
    anchor.sourceId,
    anchor.sourceType,
    anchor.page,
    normalizedNullable(anchor.article),
    anchor.paragraphIndex,
    normalizeText(anchor.quote),
  ]);

const canonicalAnchors = (anchors: readonly SourceAnchor[]): string =>
  anchors.map(canonicalAnchor).sort().join("\u0000");

const ATOMIC_FIELDS = [
  "subject",
  "action",
  "object",
  "condition",
  "frequency",
  "deadline",
  "strength",
  "responsibility",
  "exceptions",
] as const satisfies readonly (keyof AtomicRequirement)[];

const canonicalAtomic = (requirement: AtomicRequirement): string =>
  JSON.stringify([
    ...ATOMIC_FIELDS.map((field) => normalizedNullable(requirement[field])),
    canonicalAnchors(requirement.sourceAnchors),
  ]);

const exactFindingMatch = (
  expected: Finding,
  actual: Finding,
  expectedAtomicByFindingId: ReadonlyMap<string, AtomicRequirement>,
  actualAtomicByFindingId: ReadonlyMap<string, AtomicRequirement>,
): boolean => {
  if (
    expected.category !== actual.category ||
    normalizeText(expected.statement) !== normalizeText(actual.statement) ||
    canonicalAnchors(expected.sourceAnchors) !==
      canonicalAnchors(actual.sourceAnchors)
  )
    return false;
  if (expected.category !== "atomic_requirement") return true;
  const expectedAtomic = expectedAtomicByFindingId.get(expected.findingId);
  const actualAtomic = actualAtomicByFindingId.get(actual.findingId);
  return Boolean(
    expectedAtomic &&
    actualAtomic &&
    canonicalAtomic(expectedAtomic) === canonicalAtomic(actualAtomic),
  );
};

interface MatchPair {
  readonly expectedFindingId: string;
  readonly actualFindingId: string;
}

const deterministicMatches = (
  expected: EvaluationCorpus,
  actual: EvaluationCorpus,
): MatchPair[] => {
  const expectedAtomicByFindingId = new Map(
    expected.atomicRequirements.map((item) => [item.findingId, item]),
  );
  const actualAtomicByFindingId = new Map(
    actual.atomicRequirements.map((item) => [item.findingId, item]),
  );
  const availableActual = [...actual.findings].sort((left, right) =>
    left.findingId.localeCompare(right.findingId),
  );
  const usedActualIds = new Set<string>();
  const matches: MatchPair[] = [];
  for (const expectedFinding of [...expected.findings].sort((left, right) =>
    left.findingId.localeCompare(right.findingId),
  )) {
    const actualFinding = availableActual.find(
      (candidate) =>
        !usedActualIds.has(candidate.findingId) &&
        exactFindingMatch(
          expectedFinding,
          candidate,
          expectedAtomicByFindingId,
          actualAtomicByFindingId,
        ),
    );
    if (!actualFinding) continue;
    usedActualIds.add(actualFinding.findingId);
    matches.push({
      expectedFindingId: expectedFinding.findingId,
      actualFindingId: actualFinding.findingId,
    });
  }
  return matches;
};

const countMetrics = (
  expectedIds: ReadonlySet<string>,
  actualIds: ReadonlySet<string>,
  matches: readonly MatchPair[],
): CountMetrics => {
  const tp = matches.filter(
    ({ expectedFindingId, actualFindingId }) =>
      expectedIds.has(expectedFindingId) && actualIds.has(actualFindingId),
  ).length;
  const fp = actualIds.size - tp;
  const fn = expectedIds.size - tp;
  return {
    tp,
    fp,
    fn,
    precision: actualIds.size === 0 ? null : tp / actualIds.size,
    recall: expectedIds.size === 0 ? null : tp / expectedIds.size,
    evaluable: expectedIds.size > 0,
  };
};

const idsWhere = (
  findings: readonly Finding[],
  predicate: (finding: Finding) => boolean,
): Set<string> =>
  new Set(findings.filter(predicate).map(({ findingId }) => findingId));

const codePoints = (value: string): string[] => [...value.normalize("NFKC")];

const editDistance = (expected: string, actual: string): number => {
  const left = codePoints(expected);
  const right = codePoints(actual);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
};

const ocrMetrics = (
  expectedPages: readonly EvaluationOcrPage[],
  actualPages: readonly EvaluationOcrPage[],
  reviews: readonly EvaluationOcrPageReview[],
): EvaluationMetrics["ocr"] & { readonly coverageMatches: boolean } => {
  const pageKey = ({ sourceId, page }: EvaluationOcrPage) =>
    `${sourceId}\u0000${page}`;
  const actualByPage = new Map(
    actualPages.map((page) => [pageKey(page), page]),
  );
  let errors = 0;
  let expectedCharacters = 0;
  const manualReviewPages: Array<{ sourceId: string; page: number }> = [];
  const pendingManualReviewPages: Array<{ sourceId: string; page: number }> =
    [];
  for (const expectedPage of expectedPages) {
    const expectedLength = codePoints(expectedPage.text).length;
    const actualPage = actualByPage.get(pageKey(expectedPage));
    const pageErrors = actualPage
      ? editDistance(expectedPage.text, actualPage.text)
      : expectedLength;
    errors += pageErrors;
    expectedCharacters += expectedLength;
    const pageAccuracy =
      expectedLength === 0 ? null : 1 - pageErrors / expectedLength;
    if (pageAccuracy === null || pageAccuracy < 0.99) {
      manualReviewPages.push({
        sourceId: expectedPage.sourceId,
        page: expectedPage.page,
      });
      const review = reviews.find(
        (candidate) =>
          candidate.sourceId === expectedPage.sourceId &&
          candidate.page === expectedPage.page,
      );
      const isCurrent = Boolean(
        review &&
        actualPage &&
        review.expectedTextDigest === ocrPageTextDigest(expectedPage) &&
        review.actualTextDigest === ocrPageTextDigest(actualPage) &&
        (review.decision === "confirmed" ||
          (review.decision === "corrected" &&
            review.correctedText === actualPage.text)),
      );
      if (!isCurrent)
        pendingManualReviewPages.push({
          sourceId: expectedPage.sourceId,
          page: expectedPage.page,
        });
    }
  }
  const expectedKeys = expectedPages.map(pageKey).sort();
  const actualKeys = actualPages.map(pageKey).sort();
  return {
    errors,
    expectedCharacters,
    accuracy: expectedCharacters === 0 ? null : 1 - errors / expectedCharacters,
    manualReviewPages,
    pendingManualReviewPages,
    evaluable: expectedCharacters > 0,
    coverageMatches: expectedKeys.join("\u0000") === actualKeys.join("\u0000"),
  };
};

const below = (value: number | null, threshold: number): boolean =>
  value === null || value < threshold;

const evaluate = (
  expected: EvaluationCorpus,
  actual: EvaluationCorpus,
  fixtureEvidenceValidated: boolean,
): EvaluationMetrics => {
  const matches = deterministicMatches(expected, actual);
  const criticalExpectedIds = idsWhere(
    expected.findings,
    (item) => criticalCategory(item) !== null,
  );
  const criticalActualIds = idsWhere(
    actual.findings,
    (item) => criticalCategory(item) !== null,
  );
  const atomicExpectedIds = idsWhere(
    expected.findings,
    ({ category }) => category === "atomic_requirement",
  );
  const atomicActualIds = idsWhere(
    actual.findings,
    ({ category }) => category === "atomic_requirement",
  );
  const critical = countMetrics(
    criticalExpectedIds,
    criticalActualIds,
    matches,
  );
  const atomic = countMetrics(atomicExpectedIds, atomicActualIds, matches);
  const criticalByCategory = Object.fromEntries(
    CRITICAL_CATEGORIES.map((category) => [
      category,
      countMetrics(
        idsWhere(
          expected.findings,
          (item) => criticalCategory(item) === category,
        ),
        idsWhere(
          actual.findings,
          (item) => criticalCategory(item) === category,
        ),
        matches,
      ),
    ]),
  ) as Record<CriticalCategory, CountMetrics>;
  const matchedExpectedIds = new Set(
    matches.map(({ expectedFindingId }) => expectedFindingId),
  );
  const matchedActualIds = new Set(
    matches.map(({ actualFindingId }) => actualFindingId),
  );
  const actualFactIds = actual.findings
    .filter(({ claimType }) => claimType === "regulatory_fact")
    .map(({ findingId }) => findingId);
  const citationValid = actualFactIds.filter((findingId) =>
    matchedActualIds.has(findingId),
  ).length;
  const citationValidity = {
    valid: citationValid,
    total: actualFactIds.length,
    rate:
      actualFactIds.length === 0 ? null : citationValid / actualFactIds.length,
  };
  const unmarkedAiInferenceIds = actual.findings
    .filter(
      (item) =>
        item.category.startsWith("institution_impact:") &&
        item.claimType !== "ai_inference",
    )
    .map(({ findingId }) => findingId)
    .sort();
  const { coverageMatches, ...ocr } = ocrMetrics(
    expected.ocrPages,
    actual.ocrPages,
    actual.ocrPageReviews,
  );

  const failures: string[] = [];
  for (const category of CRITICAL_CATEGORIES) {
    const metric = criticalByCategory[category];
    if (!metric.evaluable) {
      failures.push(`critical_category_not_evaluable:${category}`);
      continue;
    }
    if (below(metric.precision, 0.95))
      failures.push(`critical_precision_below_95:${category}`);
    if (below(metric.recall, 0.95))
      failures.push(`critical_recall_below_95:${category}`);
  }
  if (!atomic.evaluable) failures.push("atomic_not_evaluable");
  else {
    if (below(atomic.precision, 0.9))
      failures.push("atomic_precision_below_90");
    if (below(atomic.recall, 0.85)) failures.push("atomic_recall_below_85");
  }
  if (citationValidity.rate === null) failures.push("citation_not_evaluable");
  else if (citationValidity.rate !== 1)
    failures.push("citation_validity_below_100");
  if (unmarkedAiInferenceIds.length > 0) failures.push("unmarked_ai_inference");
  const criticalOmissions = expected.findings
    .filter(
      (item) =>
        criticalCategory(item) !== null &&
        !matchedExpectedIds.has(item.findingId),
    )
    .map(({ findingId }) => findingId)
    .sort();
  if (criticalOmissions.length > 0) failures.push("critical_omissions");
  if (!ocr.evaluable) failures.push("ocr_not_evaluable");
  else if (below(ocr.accuracy, 0.99)) failures.push("ocr_accuracy_below_99");
  if (!coverageMatches) failures.push("ocr_page_coverage_mismatch");
  if (ocr.pendingManualReviewPages.length > 0)
    failures.push("ocr_manual_review_pending");
  if (!fixtureEvidenceValidated)
    failures.push("fixture_evidence_not_validated");

  return {
    critical,
    criticalByCategory,
    atomic,
    matches,
    criticalOmissions,
    citationValidity,
    unmarkedAiInferenceIds,
    ocr,
    releaseGate: { passed: failures.length === 0, failures },
  };
};

export const evaluateFindings = (
  expected: EvaluationCorpus,
  actual: EvaluationCorpus,
): EvaluationMetrics => evaluate(expected, actual, false);

/** @internal Only benchmark-input may call this after fixture validation. */
export const evaluateFixtureValidatedFindings = (
  expected: EvaluationCorpus,
  actual: EvaluationCorpus,
): EvaluationMetrics => evaluate(expected, actual, true);
