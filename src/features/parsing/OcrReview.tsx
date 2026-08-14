import { useEffect, useState } from "react";

import type { OcrPageResult } from "./ocr/ocr-pipeline";

const storageKey = (unitId: string) =>
  `external-regulation:ocr-review:${unitId}`;

const readStoredReview = (unitId: string): OcrPageResult | null => {
  try {
    const raw = localStorage.getItem(storageKey(unitId));
    return raw ? (JSON.parse(raw) as OcrPageResult) : null;
  } catch {
    return null;
  }
};

const writeStoredReview = (page: OcrPageResult): void => {
  try {
    localStorage.setItem(storageKey(page.unitId), JSON.stringify(page));
  } catch {
    // Review remains available in component state when storage is unavailable.
  }
};

export function applyOcrCorrection(
  unitId: string,
  correctedText: string,
): OcrPageResult {
  const current = readStoredReview(unitId);
  if (!current) throw new Error("OCR 纠错记录不存在");
  if (current.reviewStatus === "failed")
    throw new Error("OCR 失败页不能直接纠错");
  const corrected: OcrPageResult = {
    ...current,
    text: correctedText,
    correctedText,
    reviewStatus: "corrected",
    reviewedAt: new Date().toISOString(),
  };
  writeStoredReview(corrected);
  return corrected;
}

export interface OcrReviewProps {
  page: OcrPageResult;
  onChange?: (page: OcrPageResult) => void;
}

export function OcrReview({ page, onChange }: OcrReviewProps) {
  const [review, setReview] = useState<OcrPageResult>(
    () => readStoredReview(page.unitId) ?? page,
  );
  const [draft, setDraft] = useState(review.correctedText ?? review.text);

  useEffect(() => {
    const stored = readStoredReview(page.unitId);
    if (!stored) writeStoredReview(page);
  }, [page]);

  if (review.reviewStatus === "failed") {
    return (
      <section aria-label={`第 ${review.page} 页 OCR 审阅`}>
        <p role="alert">该页 OCR 失败，必须重试或补录后才能定稿</p>
      </section>
    );
  }

  const save = () => {
    const corrected = applyOcrCorrection(review.unitId, draft);
    setReview(corrected);
    onChange?.(corrected);
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
