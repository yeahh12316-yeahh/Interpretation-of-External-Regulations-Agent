import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { OcrReview } from "./OcrReview";
import type { OcrPageResult } from "./ocr/ocr-pipeline";

const lowConfidencePage: OcrPageResult = {
  unitId: "SRC-regulatory_text-synthetic:p1:ocr",
  sourceId: "SRC-regulatory_text-synthetic",
  sourceType: "regulatory_text",
  page: 1,
  method: "ocr",
  confidence: 0.41,
  text: "第一条 不得泄露客户信息。",
  originalOcrText: "第一条 不得泄露客户信息。",
  correctedText: null,
  reviewStatus: "unreviewed",
  reviewedAt: null,
  boundingBox: { x: 0, y: 0, width: 1000, height: 1400 },
  regions: [
    {
      text: "不得",
      confidence: 0.41,
      boundingBox: { x: 120, y: 80, width: 60, height: 30 },
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
};

afterEach(() => localStorage.clear());

describe("OcrReview", () => {
  test("persists a correction while retaining the original OCR text", () => {
    const firstRender = render(<OcrReview page={lowConfidencePage} />);

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

    firstRender.unmount();
    render(<OcrReview page={lowConfidencePage} />);
    expect(screen.getByRole("textbox", { name: "OCR 纠错文本" })).toHaveValue(
      "第一条 不得泄露客户个人信息。",
    );
    expect(screen.getByText("已纠错")).toBeInTheDocument();
  });

  test("does not allow a failed OCR page to masquerade as reviewable text", () => {
    render(
      <OcrReview
        page={{
          ...lowConfidencePage,
          text: "",
          originalOcrText: "",
          confidence: 0,
          reviewStatus: "failed",
          error: "页面 OCR 识别失败",
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "该页 OCR 失败，必须重试或补录后才能定稿",
    );
    expect(
      screen.queryByRole("button", { name: "保存纠错" }),
    ).not.toBeInTheDocument();
  });
});
