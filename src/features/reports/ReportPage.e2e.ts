import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Download, type Page } from "@playwright/test";

test.use({ viewport: { width: 1024, height: 900 } });

const downloadAndCheck = async (
  page: Page,
  buttonName: string,
  expectedExtension: "docx" | "pdf",
): Promise<Download> => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: buttonName }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`\\.${expectedExtension}$`, "u"),
  );
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  expect(
    bytes.subarray(0, expectedExtension === "docx" ? 2 : 5).toString(),
  ).toBe(expectedExtension === "docx" ? "PK" : "%PDF-");
  const outputDirectory = process.env.TASK10_QA_OUTPUT_DIR;
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    await download.saveAs(
      path.join(outputDirectory, download.suggestedFilename()),
    );
  }
  return download;
};

test("previews two real structures and downloads four browser-generated files at 1024px", async ({
  page,
}) => {
  await page.goto("/src/features/reports/__test__/report-harness.html");
  await expect(
    page.getByRole("heading", { name: "外规解读报告" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /原文证据索引与人工修订留痕/u }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await downloadAndCheck(page, "下载 DOCX", "docx");
  await downloadAndCheck(page, "下载 PDF", "pdf");

  const quickTab = page.getByRole("tab", { name: "新规快评" });
  await page.getByRole("tab", { name: "外规解读报告" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(quickTab).toHaveAttribute("aria-selected", "true");
  await expect(quickTab).toBeFocused();
  await expect(quickTab).toHaveAttribute("tabindex", "0");
  await expect(page.getByRole("tab", { name: "外规解读报告" })).toHaveAttribute(
    "tabindex",
    "-1",
  );
  await expect(
    page.getByRole("heading", { name: /一句话结论/u }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /最值得关注的三至五项变化/u }),
  ).toBeVisible();
  await expect(page.getByText("AI草稿，未经人工复核").first()).toBeVisible();

  await downloadAndCheck(page, "下载 DOCX", "docx");
  await downloadAndCheck(page, "下载 PDF", "pdf");
});
