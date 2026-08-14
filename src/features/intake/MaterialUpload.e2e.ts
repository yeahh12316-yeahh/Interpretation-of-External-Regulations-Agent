import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1024, height: 768 } });

test('keeps both upload regions inside the content container at 1024px', async (
  { page },
  testInfo,
) => {
  await page.goto('/');

  const container = page.locator('.app-content');
  const grid = page.getByTestId('material-upload-grid');
  const regions = page.getByRole('region', { name: /上传$/ });

  await expect(grid).toBeVisible();
  await expect(regions).toHaveCount(2);

  const containerBox = await container.boundingBox();
  const gridBox = await grid.boundingBox();
  expect(containerBox).not.toBeNull();
  expect(gridBox).not.toBeNull();

  const containerRight = containerBox!.x + containerBox!.width;
  expect(gridBox!.x).toBeGreaterThanOrEqual(containerBox!.x);
  expect(gridBox!.x + gridBox!.width).toBeLessThanOrEqual(containerRight);

  for (const region of await regions.all()) {
    const box = await region.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(containerBox!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(containerRight);
  }

  const pageWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);

  await page.screenshot({
    path: testInfo.outputPath('material-upload-1024.png'),
  });
});
