import { useEffect, useState } from "react";

import {
  articleFromText,
  buildAnchors,
  type ParsedSourceUnit,
} from "./build-anchors";
import type { ParseResult } from "./parse-document";
import type { OcrPageResult } from "./ocr/ocr-pipeline";

const storageKey = (unitId: string) =>
  `external-regulation:ocr-review:${unitId}`;

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

const contentFromUnits = (units: readonly ParsedSourceUnit[]): string =>
  units
    .map((unit) => unit.text.trim())
    .filter(Boolean)
    .join("\n\n");

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
  onChange?: (result: ParseResult) => void;
}

export function OcrReview({
  result,
  reviewId,
  reviewer,
  onChange,
}: OcrReviewProps) {
  const page = result.ocrReviews.find((review) => review.unitId === reviewId);
  if (!page) throw new Error("OCR 审阅页不存在");
  const [review, setReview] = useState<OcrPageResult>(page);
  const [draft, setDraft] = useState(review.correctedText ?? review.text);
  const reviewIdentity = page.unitId;
  const authoritativeReviewRevision = reviewRevision(page);

  useEffect(() => {
    setReview(page);
    setDraft(page.correctedText ?? page.text);
    try {
      // Version 1/2 caches were never authoritative. Remove them without reading
      // their content so they cannot unlock parsing after a refresh.
      localStorage.removeItem(storageKey(page.unitId));
    } catch {
      // Storage can be unavailable; WorkflowSession remains authoritative.
    }
    // page is represented by the stable authoritative revision below. Depending
    // on its object identity would discard unsaved drafts on unrelated rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authoritativeReviewRevision, reviewIdentity]);

  if (review.reviewStatus === "failed") {
    return (
      <section aria-label={`第 ${review.page} 页 OCR 审阅`}>
        <p role="alert">该页 OCR 失败，必须重试或补录后才能定稿</p>
      </section>
    );
  }

  const save = () => {
    const correctedResult = applyOcrCorrection(
      result,
      review.unitId,
      draft,
      reviewer,
    );
    const correctedReview = correctedResult.ocrReviews.find(
      (candidate) => candidate.unitId === review.unitId,
    );
    if (!correctedReview) throw new Error("OCR 纠错结果缺失");
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
