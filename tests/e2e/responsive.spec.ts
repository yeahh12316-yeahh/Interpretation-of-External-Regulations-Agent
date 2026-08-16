import { expect, test } from "@playwright/test";

import {
  installSuccessfulModelRoute,
  uploadAndAnalyze,
} from "./support/production-flow";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
] as const) {
  test(`intake remains usable without horizontal overflow at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const grid = page.getByTestId("material-upload-grid");
    await expect(grid).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const container = await page.locator("main.app-content").boundingBox();
    const gridBox = await grid.boundingBox();
    expect(container).not.toBeNull();
    expect(gridBox).not.toBeNull();
    expect(gridBox!.x).toBeGreaterThanOrEqual(container!.x);
    expect(gridBox!.x + gridBox!.width).toBeLessThanOrEqual(
      container!.x + container!.width + 1,
    );
    await expect(page.getByLabel("选择监管文件")).toBeVisible();
    const productSize = await page
      .getByRole("heading", { name: "外规解读agent" })
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    const stepSize = await page
      .getByRole("navigation", { name: "外规解读工作流" })
      .locator("button")
      .first()
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(stepSize).toBeLessThanOrEqual(productSize);
    await page.getByRole("button", { name: "模型接口设置" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "模型接口设置" }),
    ).toBeVisible();
  });
}

test("evidence remains reachable below the review list at 768x1024", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await installSuccessfulModelRoute(page);
  await uploadAndAnalyze(page);
  await page
    .getByTestId("review-item")
    .filter({ hasText: "K2" })
    .getByRole("button", { name: "查看依据" })
    .click();
  const reviewList = page.getByLabel("复核事项");
  const evidence = page.getByLabel("原文证据");
  await expect(evidence).toBeVisible();
  const listBox = await reviewList.boundingBox();
  const evidenceBox = await evidence.boundingBox();
  expect(listBox).not.toBeNull();
  expect(evidenceBox).not.toBeNull();
  expect(evidenceBox!.y).toBeGreaterThanOrEqual(
    listBox!.y + listBox!.height - 1,
  );
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const details = page.getByRole("button", { name: "查看校验详情" });
  await details.scrollIntoViewIfNeeded();
  await expect(details).toBeVisible();
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "校验详情" })).toBeVisible();
});
