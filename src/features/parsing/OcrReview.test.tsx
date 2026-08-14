import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ParseResult } from "./parse-document";
import { applyOcrCorrection, OcrReview } from "./OcrReview";
import type { OcrPageResult } from "./ocr/ocr-pipeline";

const ocrPage = (
  page: number,
  text = "第一条 不得泄露客户信息。",
): OcrPageResult => ({
  unitId: `SRC-regulatory_text-synthetic:p${page}:ocr`,
  sourceId: "SRC-regulatory_text-synthetic",
  sourceType: "regulatory_text",
  page,
  method: "ocr",
  confidence: 0.41,
  text,
  originalOcrText: text,
  correctedText: null,
  reviewStatus: "unreviewed",
  reviewedAt: null,
  reviewedBy: null,
  correctionHistory: [],
  boundingBox: { x: 0, y: 0, width: 1000, height: 1400 },
  regions: [
    {
      text,
      confidence: 0.41,
      boundingBox: { x: 120, y: 80, width: 600, height: 30 },
      lowConfidence: true,
    },
  ],
  lowConfidenceCharacters: [
    {
      text: "不",
      confidence: 0.41,
      boundingBox: { x: 120, y: 80, width: 30, height: 30 },
    },
  ],
});

const parseResultWith = (...reviews: OcrPageResult[]): ParseResult => {
  const units = reviews.map((review) => ({
    unitId: review.unitId,
    sourceId: review.sourceId,
    sourceType: review.sourceType,
    page: review.page,
    article: "第一条",
    paragraphIndex: 0,
    text: review.text,
    extractionMethod: "ocr" as const,
    confidence: review.confidence,
    boundingBox: review.boundingBox,
    originalOcrText: review.originalOcrText,
    correctedText: review.correctedText,
    reviewStatus: "unreviewed" as const,
    reviewedAt: null,
    reviewedBy: null,
    correctionHistory: [],
    ocrRegions: review.regions,
    lowConfidenceCharacters: review.lowConfidenceCharacters,
  }));
  const content = units.map((unit) => unit.text).join("\n\n");
  return {
    fileHash: "abc",
    source: {
      sourceId: "SRC-regulatory_text-synthetic",
      sourceType: "regulatory_text",
      title: "synthetic.pdf",
      content,
    },
    pageCount: reviews.length,
    successfulPages: reviews.map((review) => review.page),
    failedPages: [],
    units,
    ocrReviews: reviews,
    anchors: units.map((unit) => ({
      sourceId: unit.sourceId,
      sourceType: unit.sourceType,
      page: unit.page,
      article: unit.article,
      paragraphIndex: unit.paragraphIndex,
      quote: unit.text,
    })),
    quality: {
      totalCharacters: content.length,
      parsedUnitCount: units.length,
      failedPageCount: 0,
      lowTextPages: reviews.map((review) => review.page),
      extractionCoverage: 1,
      ocrFailedPages: [],
      finalizationBlocked: false,
    },
  };
};

afterEach(() => localStorage.clear());

describe("applyOcrCorrection", () => {
  test("updates the actual ParseResult chain and retains correction history", () => {
    const page = ocrPage(1);
    const initial = parseResultWith(page);

    const corrected = applyOcrCorrection(
      initial,
      page.unitId,
      "第一条 不得泄露客户个人信息。",
      "复核员甲",
      "2026-08-14T10:00:00.000Z",
    );

    expect(corrected.ocrReviews[0]).toMatchObject({
      unitId: page.unitId,
      originalOcrText: "第一条 不得泄露客户信息。",
      correctedText: "第一条 不得泄露客户个人信息。",
      text: "第一条 不得泄露客户个人信息。",
      reviewStatus: "corrected",
      reviewedBy: "复核员甲",
      reviewedAt: "2026-08-14T10:00:00.000Z",
    });
    expect(corrected.ocrReviews[0]?.correctionHistory).toEqual([
      {
        correctedText: "第一条 不得泄露客户个人信息。",
        reviewedBy: "复核员甲",
        reviewedAt: "2026-08-14T10:00:00.000Z",
      },
    ]);
    expect(corrected.units[0]).toMatchObject({
      unitId: page.unitId,
      originalOcrText: "第一条 不得泄露客户信息。",
      correctedText: "第一条 不得泄露客户个人信息。",
      text: "第一条 不得泄露客户个人信息。",
      reviewStatus: "corrected",
      reviewedBy: "复核员甲",
    });
    expect(corrected.source.content).toContain("客户个人信息");
    expect(corrected.anchors[0]?.quote).toContain("客户个人信息");
    expect(corrected.quality.totalCharacters).toBe(
      corrected.source.content.length,
    );
    expect(initial.source.content).not.toContain("客户个人信息");
  });
});

describe("OcrReview", () => {
  test("preserves an unsaved draft across unrelated parent rerenders", () => {
    const page = ocrPage(1);
    const nextPage = ocrPage(2, "第二页 OCR 文本");
    const result = parseResultWith(page, nextPage);
    const rerenderedResult = {
      ...result,
      source: { ...result.source },
      ocrReviews: result.ocrReviews.map((review) => ({ ...review })),
    };
    const view = render(
      <OcrReview
        result={result}
        reviewId={page.unitId}
        reviewer="复核员甲"
        onHydrate={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "OCR 纠错文本" }), {
      target: { value: "尚未保存的人工草稿" },
    });

    view.rerender(
      <OcrReview
        result={rerenderedResult}
        reviewId={page.unitId}
        reviewer="复核员甲"
        onHydrate={() => undefined}
      />,
    );

    expect(screen.getByRole("textbox", { name: "OCR 纠错文本" })).toHaveValue(
      "尚未保存的人工草稿",
    );

    view.rerender(
      <OcrReview
        result={rerenderedResult}
        reviewId={nextPage.unitId}
        reviewer="复核员甲"
        onHydrate={() => undefined}
      />,
    );
    expect(screen.getByRole("textbox", { name: "OCR 纠错文本" })).toHaveValue(
      "第二页 OCR 文本",
    );
  });

  test("hydrates a persisted correction into the authoritative ParseResult without duplicating history", async () => {
    const page = ocrPage(1);
    const result = parseResultWith(page);
    const onChange = vi.fn();
    const firstRender = render(
      <OcrReview
        result={result}
        reviewId={page.unitId}
        reviewer="复核员甲"
        onHydrate={vi.fn()}
        onChange={onChange}
      />,
    );

    expect(screen.getByText(/低置信度/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "OCR 纠错文本" }), {
      target: { value: "第一条 不得泄露客户个人信息。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存纠错" }));

    expect(screen.getByText("已纠错")).toBeInTheDocument();
    expect(screen.getByTestId("ocr-original-text")).toHaveTextContent(
      "第一条 不得泄露客户信息。",
    );
    expect(screen.getByTestId("ocr-reviewed-at").textContent).not.toBe("");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          content: expect.stringContaining("客户个人信息"),
        }),
      }),
    );

    firstRender.unmount();
    const restoredOnHydrate = vi.fn();
    const restoredOnChange = vi.fn();
    const restoredView = render(
      <OcrReview
        result={result}
        reviewId={page.unitId}
        reviewer="复核员甲"
        onHydrate={restoredOnHydrate}
        onChange={restoredOnChange}
      />,
    );
    await waitFor(() => expect(restoredOnHydrate).toHaveBeenCalledTimes(1));
    const hydratedResult = restoredOnHydrate.mock.calls[0]?.[0] as ParseResult;
    expect(hydratedResult).toMatchObject({
      source: { content: "第一条 不得泄露客户个人信息。" },
      units: [
        {
          text: "第一条 不得泄露客户个人信息。",
          reviewStatus: "corrected",
        },
      ],
      anchors: [{ quote: "第一条 不得泄露客户个人信息。" }],
    });
    expect(hydratedResult.ocrReviews[0]?.correctionHistory).toHaveLength(1);
    restoredView.rerender(
      <OcrReview
        result={hydratedResult}
        reviewId={page.unitId}
        reviewer="复核员甲"
        onHydrate={restoredOnHydrate}
        onChange={restoredOnChange}
      />,
    );
    await waitFor(() => expect(restoredOnHydrate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox", { name: "OCR 纠错文本" })).toHaveValue(
      "第一条 不得泄露客户个人信息。",
    );
    expect(screen.getByText("已纠错")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "OCR 纠错文本" }), {
      target: { value: "第一条 不得泄露客户个人信息及数据。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存纠错" }));
    expect(
      restoredOnChange.mock.calls[0]?.[0].ocrReviews[0].correctionHistory,
    ).toHaveLength(2);
  });

  test("synchronizes review and draft when the reviewId prop changes", () => {
    const first = ocrPage(1, "第一页 OCR 文本");
    const second = ocrPage(2, "第二页 OCR 文本");
    const result = parseResultWith(first, second);
    const view = render(
      <OcrReview
        result={result}
        reviewId={first.unitId}
        reviewer="复核员甲"
        onHydrate={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "OCR 纠错文本" }), {
      target: { value: "未保存的第一页草稿" },
    });

    view.rerender(
      <OcrReview
        result={result}
        reviewId={second.unitId}
        reviewer="复核员甲"
        onHydrate={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "OCR 纠错文本" })).toHaveValue(
      "第二页 OCR 文本",
    );
    expect(screen.getByRole("region")).toHaveAccessibleName("第 2 页 OCR 审阅");
  });

  test("does not allow a failed OCR page to masquerade as reviewable text", () => {
    const failed = {
      ...ocrPage(1, ""),
      confidence: 0,
      reviewStatus: "failed" as const,
      error: "页面 OCR 识别失败" as const,
    };
    render(
      <OcrReview
        result={parseResultWith(failed)}
        reviewId={failed.unitId}
        reviewer="复核员甲"
        onHydrate={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "该页 OCR 失败，必须重试或补录后才能定稿",
    );
    expect(
      screen.queryByRole("button", { name: "保存纠错" }),
    ).not.toBeInTheDocument();
  });

  test("migrates a legacy stored correction and supports repeated saves", async () => {
    const page = ocrPage(1);
    const result = parseResultWith(page);
    const legacyReview: Record<string, unknown> = {
      ...page,
      text: "第一条 旧版纠错文本。",
      correctedText: "第一条 旧版纠错文本。",
      reviewStatus: "corrected",
      reviewedAt: "2026-08-14T09:00:00.000Z",
    };
    delete legacyReview.reviewedBy;
    delete legacyReview.correctionHistory;
    const key = `external-regulation:ocr-review:${page.unitId}`;
    localStorage.setItem(key, JSON.stringify(legacyReview));
    const onHydrate = vi.fn();
    const onChange = vi.fn();

    render(
      <OcrReview
        result={result}
        reviewId={page.unitId}
        reviewer="复核员乙"
        onHydrate={onHydrate}
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(onHydrate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox", { name: "OCR 纠错文本" })).toHaveValue(
      "第一条 旧版纠错文本。",
    );
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toMatchObject({
      version: 2,
      review: {
        reviewedBy: null,
        correctionHistory: [],
      },
    });

    const textbox = screen.getByRole("textbox", { name: "OCR 纠错文本" });
    fireEvent.change(textbox, {
      target: { value: "第一条 第一次新版纠错。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存纠错" }));
    fireEvent.change(textbox, {
      target: { value: "第一条 第二次新版纠错。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存纠错" }));

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(
      onChange.mock.calls[1]?.[0].ocrReviews[0].correctionHistory,
    ).toHaveLength(2);
  });

  test("clears corrupt stored records without exposing their text", () => {
    const page = ocrPage(1);
    const result = parseResultWith(page);
    const key = `external-regulation:ocr-review:${page.unitId}`;
    const secret = "不应显示的损坏存储文本";
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        review: { unitId: page.unitId, text: secret },
      }),
    );

    render(
      <OcrReview
        result={result}
        reviewId={page.unitId}
        reviewer="复核员甲"
        onHydrate={vi.fn()}
      />,
    );

    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "OCR 纠错文本" })).toHaveValue(
      page.text,
    );
    const replacement = JSON.parse(localStorage.getItem(key) ?? "null");
    expect(replacement).toMatchObject({
      version: 2,
      review: { unitId: page.unitId, text: page.text },
    });
    expect(localStorage.getItem(key)).not.toContain(secret);
  });
});
