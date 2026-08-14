import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  articleFromText,
  buildAnchors,
  type ParsedSourceUnit,
} from "./build-anchors";
import type { ParseResult } from "./parse-document";
import type { OcrPageResult } from "./ocr/ocr-pipeline";

const storageKey = (unitId: string) =>
  `external-regulation:ocr-review:${unitId}`;

const OCR_REVIEW_STORAGE_VERSION = 2;

const boundingBoxSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();

const correctionRecordSchema = z
  .object({
    correctedText: z.string().min(1),
    reviewedBy: z.string().min(1),
    reviewedAt: z.string().min(1),
  })
  .strict();

const ocrPageResultSchema = z
  .object({
    unitId: z.string().min(1),
    sourceId: z.string().min(1),
    sourceType: z.enum(["regulatory_text", "official_interpretation"]),
    page: z.number().int().positive(),
    method: z.literal("ocr"),
    confidence: z.number().finite().min(0).max(1),
    text: z.string(),
    originalOcrText: z.string(),
    correctedText: z.string().nullable(),
    reviewStatus: z.enum(["unreviewed", "corrected", "failed"]),
    reviewedAt: z.string().min(1).nullable(),
    reviewedBy: z.string().min(1).nullable(),
    correctionHistory: z.array(correctionRecordSchema),
    boundingBox: boundingBoxSchema,
    regions: z.array(
      z
        .object({
          text: z.string(),
          confidence: z.number().finite().min(0).max(1),
          boundingBox: boundingBoxSchema,
          lowConfidence: z.boolean(),
        })
        .strict(),
    ),
    lowConfidenceCharacters: z.array(
      z
        .object({
          text: z.string(),
          confidence: z.number().finite().min(0).max(1),
          boundingBox: boundingBoxSchema,
        })
        .strict(),
    ),
    error: z.literal("页面 OCR 识别失败").optional(),
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.reviewStatus === "corrected" &&
      (!review.correctedText || !review.reviewedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "corrected review metadata is incomplete",
      });
    }
    if (review.reviewStatus === "failed" && !review.error) {
      context.addIssue({
        code: "custom",
        message: "failed review metadata is incomplete",
      });
    }
  });

const storedReviewSchema = z
  .object({
    version: z.literal(OCR_REVIEW_STORAGE_VERSION),
    review: ocrPageResultSchema,
  })
  .strict();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const reviewRevision = (review: OcrPageResult): string =>
  JSON.stringify([
    review.unitId,
    review.sourceId,
    review.sourceType,
    review.page,
    review.method,
    review.confidence,
    review.text,
    review.originalOcrText,
    review.correctedText,
    review.reviewStatus,
    review.reviewedAt,
    review.reviewedBy,
    review.correctionHistory,
    review.boundingBox,
    review.regions,
    review.lowConfidenceCharacters,
    review.error ?? null,
  ]);

const writeStoredReview = (page: OcrPageResult): void => {
  try {
    localStorage.setItem(
      storageKey(page.unitId),
      JSON.stringify({
        version: OCR_REVIEW_STORAGE_VERSION,
        review: page,
      }),
    );
  } catch {
    // The corrected ParseResult remains authoritative when storage is unavailable.
  }
};

const readStoredReview = (unitId: string): OcrPageResult | null => {
  const key = storageKey(unitId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const current = storedReviewSchema.safeParse(parsed);
    if (current.success && current.data.review.unitId === unitId) {
      return current.data.review;
    }

    if (isRecord(parsed) && !("version" in parsed)) {
      const legacyCandidate = {
        ...parsed,
        ...(Object.hasOwn(parsed, "reviewedBy") ? {} : { reviewedBy: null }),
        ...(Object.hasOwn(parsed, "correctionHistory")
          ? {}
          : { correctionHistory: [] }),
      };
      const migrated = ocrPageResultSchema.safeParse(legacyCandidate);
      if (migrated.success && migrated.data.unitId === unitId) {
        writeStoredReview(migrated.data);
        return migrated.data;
      }
    }

    localStorage.removeItem(key);
    return null;
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable; do not expose persisted OCR text in errors.
    }
    return null;
  }
};

const contentFromUnits = (units: readonly ParsedSourceUnit[]): string =>
  units
    .map((unit) => unit.text.trim())
    .filter(Boolean)
    .join("\n\n");

const resultWithReviewState = (
  result: ParseResult,
  review: OcrPageResult,
): ParseResult => {
  const units = result.units.map((unit) =>
    unit.unitId === review.unitId
      ? {
          ...unit,
          article: articleFromText(review.text) ?? unit.article,
          text: review.text,
          originalOcrText: review.originalOcrText,
          correctedText: review.correctedText,
          reviewStatus:
            review.reviewStatus === "corrected"
              ? ("corrected" as const)
              : ("unreviewed" as const),
          reviewedAt: review.reviewedAt,
          reviewedBy: review.reviewedBy,
          correctionHistory: review.correctionHistory,
          ocrRegions: review.regions,
          lowConfidenceCharacters: review.lowConfidenceCharacters,
        }
      : unit,
  );
  const content = contentFromUnits(units);
  return {
    ...result,
    source: { ...result.source, content },
    units,
    ocrReviews: result.ocrReviews.map((candidate) =>
      candidate.unitId === review.unitId ? review : candidate,
    ),
    anchors: buildAnchors(units),
    quality: {
      ...result.quality,
      totalCharacters: content.length,
      parsedUnitCount: units.length,
    },
  };
};

export function applyOcrCorrection(
  result: ParseResult,
  unitId: string,
  correctedText: string,
  reviewer: string,
  reviewedAt = new Date().toISOString(),
): ParseResult {
  const current = result.ocrReviews.find((review) => review.unitId === unitId);
  if (!current) throw new Error("OCR 纠错记录不存在");
  if (current.reviewStatus === "failed")
    throw new Error("OCR 失败页不能直接纠错");
  const normalizedText = correctedText.trim();
  if (!normalizedText) throw new Error("OCR 纠错文本不得为空");
  const normalizedReviewer = reviewer.trim();
  if (!normalizedReviewer) throw new Error("OCR 纠错必须记录复核人");
  const correction = {
    correctedText: normalizedText,
    reviewedBy: normalizedReviewer,
    reviewedAt,
  };
  const correctedReview: OcrPageResult = {
    ...current,
    text: normalizedText,
    correctedText: normalizedText,
    reviewStatus: "corrected",
    reviewedAt,
    reviewedBy: normalizedReviewer,
    correctionHistory: [...(current.correctionHistory ?? []), correction],
  };
  let unitFound = false;
  const units = result.units.map((unit) => {
    if (unit.unitId !== unitId) return unit;
    unitFound = true;
    return {
      ...unit,
      article: articleFromText(normalizedText) ?? unit.article,
      text: normalizedText,
      originalOcrText: current.originalOcrText,
      correctedText: normalizedText,
      reviewStatus: "corrected" as const,
      reviewedAt,
      reviewedBy: normalizedReviewer,
      correctionHistory: correctedReview.correctionHistory,
      ocrRegions: current.regions,
      lowConfidenceCharacters: current.lowConfidenceCharacters,
    };
  });
  if (!unitFound) throw new Error("OCR 纠错单元不存在");
  const content = contentFromUnits(units);
  return {
    ...result,
    source: { ...result.source, content },
    units,
    ocrReviews: result.ocrReviews.map((review) =>
      review.unitId === unitId ? correctedReview : review,
    ),
    anchors: buildAnchors(units),
    quality: {
      ...result.quality,
      totalCharacters: content.length,
      parsedUnitCount: units.length,
    },
  };
}

export interface OcrReviewProps {
  result: ParseResult;
  reviewId: string;
  reviewer: string;
  onHydrate: (result: ParseResult) => void;
  onChange?: (result: ParseResult) => void;
}

export function OcrReview({
  result,
  reviewId,
  reviewer,
  onHydrate,
  onChange,
}: OcrReviewProps) {
  const page = result.ocrReviews.find((review) => review.unitId === reviewId);
  if (!page) throw new Error("OCR 审阅页不存在");
  const restored = () => readStoredReview(page.unitId) ?? page;
  const [review, setReview] = useState<OcrPageResult>(restored);
  const [draft, setDraft] = useState(review.correctedText ?? review.text);
  const hydratedRevision = useRef<string | null>(null);
  const latestPage = useRef(page);
  const latestResult = useRef(result);
  const latestOnHydrate = useRef(onHydrate);
  latestPage.current = page;
  latestResult.current = result;
  latestOnHydrate.current = onHydrate;
  const reviewIdentity = page.unitId;
  const authoritativeReviewRevision = reviewRevision(page);

  useEffect(() => {
    const currentPage = latestPage.current;
    const storedReview = readStoredReview(currentPage.unitId);
    const nextReview = storedReview ?? currentPage;
    setReview(nextReview);
    setDraft(nextReview.correctedText ?? nextReview.text);
    if (!storedReview) {
      writeStoredReview(currentPage);
      hydratedRevision.current = null;
      return;
    }

    const storedCorrectionIsMissingFromResult =
      storedReview.reviewStatus === "corrected" &&
      (currentPage.reviewStatus !== "corrected" ||
        currentPage.text !== storedReview.text ||
        currentPage.reviewedAt !== storedReview.reviewedAt ||
        currentPage.correctionHistory.length !==
          storedReview.correctionHistory.length);
    if (!storedCorrectionIsMissingFromResult) {
      hydratedRevision.current = null;
      return;
    }

    const revision = reviewRevision(storedReview);
    if (hydratedRevision.current === revision) return;
    hydratedRevision.current = revision;
    latestOnHydrate.current(
      resultWithReviewState(latestResult.current, storedReview),
    );
  }, [authoritativeReviewRevision, reviewIdentity]);

  if (review.reviewStatus === "failed") {
    return (
      <section aria-label={`第 ${review.page} 页 OCR 审阅`}>
        <p role="alert">该页 OCR 失败，必须重试或补录后才能定稿</p>
      </section>
    );
  }

  const save = () => {
    const resultReview = result.ocrReviews.find(
      (candidate) => candidate.unitId === review.unitId,
    );
    const correctionBase =
      resultReview?.reviewedAt === review.reviewedAt
        ? result
        : resultWithReviewState(result, review);
    const correctedResult = applyOcrCorrection(
      correctionBase,
      review.unitId,
      draft,
      reviewer,
    );
    const correctedReview = correctedResult.ocrReviews.find(
      (candidate) => candidate.unitId === review.unitId,
    );
    if (!correctedReview) throw new Error("OCR 纠错结果缺失");
    writeStoredReview(correctedReview);
    setReview(correctedReview);
    setDraft(correctedReview.correctedText ?? correctedReview.text);
    onChange?.(correctedResult);
  };

  return (
    <section aria-label={`第 ${review.page} 页 OCR 审阅`}>
      {review.confidence < 0.7 && <p>低置信度：请核对高亮字符</p>}
      {review.lowConfidenceCharacters.length > 0 && (
        <p aria-label="低置信度字符">
          {review.lowConfidenceCharacters.map((character, index) => (
            <mark
              key={`${character.boundingBox.x}:${character.boundingBox.y}:${index}`}
            >
              {character.text}
            </mark>
          ))}
        </p>
      )}
      <p>{review.reviewStatus === "corrected" ? "已纠错" : "待审阅"}</p>
      <label>
        OCR 纠错文本
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button type="button" onClick={save}>
        保存纠错
      </button>
      <details>
        <summary>原始 OCR 文本</summary>
        <pre data-testid="ocr-original-text">{review.originalOcrText}</pre>
      </details>
      <time
        data-testid="ocr-reviewed-at"
        dateTime={review.reviewedAt ?? undefined}
      >
        {review.reviewedAt ?? ""}
      </time>
    </section>
  );
}
