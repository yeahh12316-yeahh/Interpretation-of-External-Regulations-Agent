import { expect, test, type Page } from "../../playwright-fixtures";

import {
  installSuccessfulModelRoute,
  uploadAndAnalyze,
} from "./support/production-flow";

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
] as const;

const expectNoHorizontalOverflow = async (page: Page) => {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
};

for (const viewport of viewports) {
  test(`intake and evidence review remain operable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installSuccessfulModelRoute(page);
    await page.goto("/");
    const grid = page.getByTestId("material-upload-grid");
    await expect(grid).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const container = await page.locator("main.app-content").boundingBox();
    const gridBox = await grid.boundingBox();
    expect(container).not.toBeNull();
    expect(gridBox).not.toBeNull();
    expect(gridBox!.x).toBeGreaterThanOrEqual(container!.x);
    expect(gridBox!.x + gridBox!.width).toBeLessThanOrEqual(
      container!.x + container!.width + 1,
    );
    await expect(page.getByLabel("选择监管文件")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "外规解读工作流" }),
    ).toBeVisible();
    const productSize = await page
      .getByRole("heading", { name: "外规解读agent" })
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    const stepSize = await page
      .getByRole("navigation", { name: "外规解读工作流" })
      .locator("button")
      .first()
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    expect(stepSize).toBeLessThanOrEqual(productSize);
    const settingsButton = page.getByRole("button", { name: "模型接口设置" });
    await settingsButton.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "模型接口设置" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await uploadAndAnalyze(page);
    const k2 = page.getByTestId("review-item").filter({ hasText: "K2" });
    const evidenceAction = k2.getByRole("button", { name: "查看依据" });
    await evidenceAction.scrollIntoViewIfNeeded();
    await evidenceAction.focus();
    await page.keyboard.press("Enter");
    const reviewList = page.getByLabel("复核事项");
    const evidence = page.getByLabel("原文证据");
    await expect(evidence).toBeVisible();
    const listBox = await reviewList.boundingBox();
    const evidenceBox = await evidence.boundingBox();
    expect(listBox).not.toBeNull();
    expect(evidenceBox).not.toBeNull();
    if (viewport.width > 1024) {
      expect(evidenceBox!.x).toBeGreaterThanOrEqual(
        listBox!.x + listBox!.width - 1,
      );
    } else {
      expect(evidenceBox!.y).toBeGreaterThanOrEqual(
        listBox!.y + listBox!.height - 1,
      );
    }
    for (const action of [
      page.getByRole("button", { name: "查看校验详情" }),
      k2.getByRole("button", { name: "修改 K2" }),
      k2.getByRole("button", { name: "确认 K2" }),
    ]) {
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeVisible();
    }
    const details = page.getByRole("button", { name: "查看校验详情" });
    await details.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "校验详情" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "校验详情" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
}
