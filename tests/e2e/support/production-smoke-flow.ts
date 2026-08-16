import { expect, type Page } from "@playwright/test";

import type { ExpectedConsoleError } from "../../../playwright-fixtures";
import {
  buildJpegScanPdf,
  buildTextLayerPdf,
} from "../../../scripts/pdf-fixtures.mjs";
import {
  assertReportStructure,
  downloadReport,
  installSuccessfulModelRoute,
  reviewAllFindings,
  SYNTHETIC_REGULATORY_TEXT,
  uploadAndAnalyze,
} from "./production-flow";

const SYNTHETIC_MODEL_BASE_URL = "https://production-smoke-model.invalid/v1";
const OCR_WARNING_PARAMETERS = [
  "language_model_ngram_on",
  "segsearch_max_char_wh_ratio",
  "language_model_ngram_space_delimited_language",
  "language_model_use_sigmoidal_certainty",
  "language_model_ngram_nonmatch_score",
  "classify_integer_matcher_multiplier",
  "assume_fixed_pitch_char_segment",
  "allow_blob_division",
] as const;

export const ocrConsoleExpectations = (
  origin: string,
): ExpectedConsoleError[] => {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return OCR_WARNING_PARAMETERS.map((parameter) => ({
    text: new RegExp(`^Warning: Parameter not found: ${parameter}$`, "u"),
    url: new RegExp(
      `^${escaped}/ocr/tesseract-7\\.0\\.0-data-1\\.0\\.0/tesseract-core/tesseract-core-(?:relaxedsimd-|simd-)?lstm\\.wasm\\.js$`,
      "u",
    ),
    count: 1,
  }));
};

export const runProductionSmokeFlow = async (
  page: Page,
  baseUrl: URL,
): Promise<void> => {
  const basePath = baseUrl.pathname.endsWith("/")
    ? baseUrl.pathname
    : `${baseUrl.pathname}/`;
  const ocrAssetResponses: Array<{ url: string; status: number }> = [];
  page.context().on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes("/ocr/tesseract-7.0.0-data-1.0.0/"))
      ocrAssetResponses.push({ url: url.href, status: response.status() });
  });

  const deepLinkResponse = await page.goto("production-smoke/deep-link");
  expect(deepLinkResponse?.status()).toBeLessThan(400);
  expect(new URL(page.url()).pathname).toBe(
    `${basePath}production-smoke/deep-link`,
  );
  await expect(page.getByRole("heading", { name: "材料上传" })).toBeVisible();

  const scanJpeg = await page.evaluate(async () => {
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 700;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("production smoke canvas unavailable");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "black";
    context.font = "bold 64px sans-serif";
    context.fillText("OFFICIAL INTERPRETATION", 70, 170);
    context.font = "56px sans-serif";
    context.fillText("合成官方解读", 70, 300);
    context.fillText("IMPLEMENTATION GUIDANCE ONLY", 70, 430);
    return canvas.toDataURL("image/jpeg", 0.96).split(",")[1];
  });
  const regulatoryPdf = buildTextLayerPdf(
    SYNTHETIC_REGULATORY_TEXT.split("\n"),
  );
  const officialScanPdf = buildJpegScanPdf(
    Buffer.from(scanJpeg, "base64"),
    1200,
    700,
  );

  await installSuccessfulModelRoute(page, SYNTHETIC_MODEL_BASE_URL);
  await uploadAndAnalyze(
    page,
    "synthetic-production-smoke-key",
    SYNTHETIC_MODEL_BASE_URL,
    false,
    {
      navigate: false,
      regulatoryFile: {
        name: "合成监管原文-文字层.pdf",
        mimeType: "application/pdf",
        buffer: regulatoryPdf,
      },
      officialFile: {
        name: "合成官方解读-扫描.pdf",
        mimeType: "application/pdf",
        buffer: officialScanPdf,
      },
    },
  );
  expect(ocrAssetResponses.length).toBeGreaterThan(2);
  expect(
    ocrAssetResponses.every(
      (response) =>
        new URL(response.url).origin === baseUrl.origin &&
        response.status >= 200 &&
        response.status < 300,
    ),
  ).toBe(true);
  expect(
    ocrAssetResponses.some(({ url }) => url.endsWith("/worker.min.js")),
  ).toBe(true);
  expect(
    ocrAssetResponses.some(({ url }) => url.includes("tesseract-core")),
  ).toBe(true);
  expect(
    ocrAssetResponses.some(({ url }) => url.includes("chi_sim.traineddata.gz")),
  ).toBe(true);

  const f1 = page.getByTestId("review-item").filter({ hasText: "F1" });
  await f1.getByRole("button", { name: "查看依据" }).click();
  await expect(page.getByTestId("evidence-original")).toContainText(
    "第一条 示例银行应当建立管理机制。",
  );

  const k2 = page.getByTestId("review-item").filter({ hasText: "K2" });
  await k2.getByRole("button", { name: "查看依据" }).click();
  await expect(page.getByTestId("evidence-original")).toContainText(
    "第二条 示例银行不得虚构合规记录。",
  );

  await f1.getByRole("button", { name: "修改 F1" }).click();
  const edit = page.getByRole("dialog", { name: "修改结论 F1" });
  await edit.getByLabel("修改后陈述").fill("示例银行应当建立管理机制。");
  await edit.getByLabel("修改理由").fill("生产冒烟：核对原文并补充标点");
  await edit.getByRole("button", { name: "保存修改" }).click();
  await reviewAllFindings(page);
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "报告导出" })).toBeVisible();

  const fullDocx = await downloadReport(page, "下载 DOCX", "docx");
  const fullPdf = await downloadReport(page, "下载 PDF", "pdf");
  await page.getByRole("tab", { name: "新规快评" }).click();
  const quickDocx = await downloadReport(page, "下载 DOCX", "docx");
  const quickPdf = await downloadReport(page, "下载 PDF", "pdf");

  assertReportStructure(fullDocx, "full");
  assertReportStructure(fullPdf, "full");
  assertReportStructure(quickDocx, "quick");
  assertReportStructure(quickPdf, "quick");
};
