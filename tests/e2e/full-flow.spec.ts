import { expect, test } from "../../playwright-fixtures";

import {
  assertReportStructure,
  downloadReport,
  installSuccessfulModelRoute,
  reviewAllFindings,
  uploadAndAnalyze,
} from "./support/production-flow";

test("production App completes the real two-source flow and exports structurally distinct reports", async ({
  page,
}) => {
  await installSuccessfulModelRoute(page);
  await uploadAndAnalyze(page);

  const f1 = page.getByTestId("review-item").filter({ hasText: "F1" });
  await f1.getByRole("button", { name: "查看依据" }).click();
  await expect(page.getByTestId("evidence-original")).toContainText(
    "第一条 示例银行应当建立管理机制。",
  );
  await expect(page.getByText("第一条", { exact: true })).toBeVisible();

  const k2 = page.getByTestId("review-item").filter({ hasText: "K2" });
  await k2.getByRole("button", { name: "查看依据" }).click();
  await expect(page.getByTestId("evidence-original")).toContainText(
    "第二条 示例银行不得虚构合规记录。",
  );
  await expect(page.getByText("第二条", { exact: true })).toBeVisible();

  await f1.getByRole("button", { name: "修改 F1" }).click();
  const edit = page.getByRole("dialog", { name: "修改结论 F1" });
  await edit.getByLabel("修改后陈述").fill("示例银行应当建立管理机制。");
  await edit.getByLabel("修改理由").fill("核对原文后补充句末标点");
  await edit.getByRole("button", { name: "保存修改" }).click();
  await f1.getByRole("button", { name: "查看详情" }).click();
  await expect(f1.getByText("1", { exact: true })).toBeVisible();

  await reviewAllFindings(page);
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "报告导出" })).toBeVisible();

  const fullDocx = await downloadReport(page, "下载 DOCX", "docx");
  const fullPdf = await downloadReport(page, "下载 PDF", "pdf");
  await page.getByRole("tab", { name: "新规快评" }).click();
  const quickDocx = await downloadReport(page, "下载 DOCX", "docx");
  const quickPdf = await downloadReport(page, "下载 PDF", "pdf");

  expect(fullDocx.text).toContain("外规解读报告");
  expect(quickDocx.text).toContain("新规快评");
  expect(fullPdf.text).toContain("外规解读报告");
  expect(quickPdf.text).toContain("新规快评");
  expect(fullDocx.text).not.toBe(quickDocx.text);
  expect(fullPdf.text).not.toBe(quickPdf.text);
  expect(fullDocx.bytes.subarray(0, 2).toString()).toBe("PK");
  expect(quickDocx.bytes.subarray(0, 2).toString()).toBe("PK");
  expect(fullPdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(quickPdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  assertReportStructure(fullDocx, "full");
  assertReportStructure(fullPdf, "full");
  assertReportStructure(quickDocx, "quick");
  assertReportStructure(quickPdf, "quick");
});
