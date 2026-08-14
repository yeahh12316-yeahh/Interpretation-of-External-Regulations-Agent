import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1024, height: 768 } });

test("keeps evidence usable at 1024px and updates real locator details", async ({
  page,
}) => {
  await page.goto("/src/features/evidence/__test__/evidence-harness.html");
  await expect(page.locator("html")).toHaveAttribute(
    "data-harness-mappings",
    "valid",
  );

  const panel = page.getByRole("complementary", { name: "原文证据" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("第7页")).toBeVisible();

  await page.getByRole("button", { name: "选择结论 F2" }).click();
  await expect(panel.getByText("第18页")).toBeVisible();
  await expect(panel.getByText("第十八条", { exact: true })).toBeVisible();
  await expect(panel.getByText("合成官方解读.pdf")).toBeVisible();
  await expect(panel.getByText("官方解读", { exact: true })).toHaveCount(2);

  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.x).toBeGreaterThanOrEqual(0);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1024);

  const pageWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);

  const detailsTrigger = panel.getByRole("button", { name: "查看校验详情" });
  await detailsTrigger.click();
  const dialog = page.getByRole("dialog", { name: "证据校验详情" });
  await expect(dialog).toBeVisible();
  const closeButton = dialog.getByRole("button", { name: "关闭校验详情" });
  await expect(closeButton).toBeFocused();
  await expect(dialog.getByText("引用反向匹配")).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(1024);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(detailsTrigger).toBeFocused();
});
