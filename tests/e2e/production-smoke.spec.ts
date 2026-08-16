import { expect, test } from "../../playwright-fixtures";

import {
  assertReportStructure,
  downloadReport,
  installSuccessfulModelRoute,
  reviewAllFindings,
  uploadAndAnalyze,
} from "./support/production-flow";

const SYNTHETIC_MODEL_BASE_URL = "https://production-smoke-model.invalid/v1";

test("deployed production App completes BYOK analysis, evidence review, and all exports", async ({
  page,
}) => {
  await installSuccessfulModelRoute(page, SYNTHETIC_MODEL_BASE_URL);
  await uploadAndAnalyze(
    page,
    "synthetic-production-smoke-key",
    SYNTHETIC_MODEL_BASE_URL,
  );

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
});
