import { expect, test } from "@playwright/test";

test("production App preserves upload and enforces the five-step browser gate", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "外规解读agent" }),
  ).toBeVisible();
  await page.getByLabel("选择监管文件").setInputFiles({
    name: "监管办法.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("第一条 商业银行应当建立管理机制。", "utf8"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "解析完成" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "下一步" })).toBeEnabled();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "解析与OCR" })).toBeVisible();
  await expect(page.getByText("解析质量通过")).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "监管分析" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一步" })).toBeDisabled();
});
