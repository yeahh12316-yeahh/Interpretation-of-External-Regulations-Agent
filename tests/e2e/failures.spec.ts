import path from "node:path";

import { expect, test, type Page } from "../../playwright-fixtures";

import {
  installSuccessfulModelRoute,
  reviewAllFindings,
  uploadAndAnalyze,
} from "./support/production-flow";

type FailureMode = "cors" | "network" | 401 | 404 | 429 | "invalid" | "success";

const openSettings = async (page: Page) => {
  await page.getByRole("button", { name: "模型接口设置" }).click();
  const dialog = page.getByRole("dialog", { name: "模型接口设置" });
  await dialog.getByLabel("Base URL").fill("https://failure.example/v1");
  await dialog.getByLabel("API Key").fill("synthetic-failure-key");
  await dialog.getByLabel("模型", { exact: true }).fill("synthetic-model");
  return dialog;
};

test.describe("model failure diagnostics", () => {
  test.use({
    expectedConsoleErrors: { specs: [
      {
        text: /^Failed to load resource: net::ERR_BLOCKED_BY_CLIENT\.Inspector$/u,
        url: /^https:\/\/failure\.example\/v1\/chat\/completions$/u,
        count: 1,
      },
      {
        text: /^Failed to load resource: net::ERR_CONNECTION_REFUSED$/u,
        url: /^https:\/\/failure\.example\/v1\/chat\/completions$/u,
        count: 1,
      },
      ...["401 \\(Unauthorized\\)", "404 \\(Not Found\\)", "429 \\(Too Many Requests\\)"].map(
        (status) => ({
          text: new RegExp(
            `^Failed to load resource: the server responded with a status of ${status}$`,
            "u",
          ),
          url: /^https:\/\/failure\.example\/v1\/chat\/completions$/u,
          count: 1,
        }),
      ),
    ] },
  });

  test("model failures are visible, retryable, and never fake success", async ({
    page,
  }) => {
  let mode: FailureMode = "network";
  let invalidCalls = 0;
  await page.route(
    "https://failure.example/v1/chat/completions",
    async (route) => {
      if (mode === "cors") return route.abort("blockedbyclient");
      if (mode === "network") return route.abort("connectionrefused");
      if (typeof mode === "number")
        return route.fulfill({ status: mode, body: "{}" });
      if (mode === "invalid") {
        invalidCalls += 1;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            choices: [{ message: { content: "not-json" } }],
          }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          choices: [{ message: { content: '{"connection":"ok"}' } }],
        }),
      });
    },
  );
  await page.goto("/");
  const dialog = await openSettings(page);
  const cases: Array<[FailureMode, RegExp]> = [
    ["cors", /CORS 限制或网络故障/u],
    ["network", /CORS 限制或网络故障/u],
    [401, /鉴权失败/u],
    [404, /接口或模型不存在/u],
    [429, /请求过于频繁或额度不足/u],
    ["invalid", /模型响应不符合所需结构/u],
  ];
  for (const [nextMode, message] of cases) {
    mode = nextMode;
    await dialog.getByRole("button", { name: "测试连接" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(message);
    await expect(
      dialog.getByRole("button", { name: "测试连接" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("heading", { name: "外规解读agent" }),
    ).toBeVisible();
  }
  expect(invalidCalls).toBe(3);
  mode = "success";
  await dialog.getByRole("button", { name: "测试连接" }).click();
  await expect(dialog.getByRole("status")).toContainText("连接成功");
  });
});

test("a real model timeout returns to an operable settings form", async ({
  page,
}) => {
  await page.clock.install();
  await page.route(
    "https://failure.example/v1/chat/completions",
    async () => new Promise(() => undefined),
  );
  await page.goto("/");
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "测试连接" }).click();
  await expect(dialog.getByRole("status")).toContainText("正在测试连接");
  await page.clock.fastForward(61_000);
  await expect(dialog.getByRole("alert")).toContainText("模型请求超时");
  await expect(dialog.getByRole("button", { name: "测试连接" })).toBeEnabled();
});

test.describe("OCR injected failure diagnostics", () => {
  test("OCR asset failure blocks the real scanned-PDF upload without a white screen", async ({
    page,
  }) => {
  await page.route("**/ocr/**/tesseract/worker.min.js", (route) =>
    route.abort("failed"),
  );
  await page.goto("/");
  await page
    .getByLabel("选择监管文件")
    .setInputFiles(path.resolve("tests/fixtures/scanned-regulation.pdf"));
  const upload = page.getByTestId("regulatory_text-upload-state");
  await expect(upload.getByRole("alert")).toContainText("解析质量未通过", {
    timeout: 30_000,
  });
  await expect(upload.getByText(/OCR 失败页：\s*1/u)).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("button", { name: "下一步" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("解析或 OCR 质量未通过");
  await expect(page.getByRole("button", { name: "上一步" })).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "外规解读agent" }),
  ).toBeVisible();
  });
});

test.describe("export injected failure diagnostics", () => {
  test.use({
    expectedConsoleErrors: { specs: [
      {
        text: /^Failed to load resource: net::ERR_FAILED$/u,
        url: /\/src\/features\/reports\/export-docx\.ts/u,
        count: 1,
      },
    ] },
  });

  test("export module failure preserves preview and offers a real retry", async ({
    page,
  }) => {
  await installSuccessfulModelRoute(page);
  await uploadAndAnalyze(page);
  await page.getByRole("button", { name: "确认 F1" }).click();
  await reviewAllFindings(page);
  await page.getByRole("button", { name: "下一步" }).click();
  await page.route("**/src/features/reports/export-docx.ts*", (route) =>
    route.abort("failed"),
  );
  await page.getByRole("button", { name: "下载 DOCX" }).click();
  await expect(page.getByRole("alert")).toContainText("导出失败");
  await expect(
    page.getByRole("button", { name: "重试导出 DOCX" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "外规解读报告" }),
  ).toBeVisible();
  });
});
