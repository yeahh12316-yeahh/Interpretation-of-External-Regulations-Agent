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

test("production flow analyzes, reviews, restores and reaches the report gate with a routed HTTPS model", async ({
  page,
}) => {
  const apiKey = "playwright-session-key";
  const browserLogs: string[] = [];
  page.on("console", (message) => browserLogs.push(message.text()));
  await page.route(
    "https://model.example/v1/chat/completions",
    async (route) => {
      const body = route.request().postDataJSON() as {
        messages: Array<{ content: string }>;
        response_format: { json_schema: { name: string } };
      };
      const schemaName = body.response_format.json_schema.name;
      let output: unknown;
      if (schemaName === "connection_test") {
        output = { connection: "ok" };
      } else if (schemaName === "analysis_document_identity_v1") {
        output = { findings: [], conflicts: [] };
      } else if (schemaName === "analysis_atomic_clauses_v1") {
        const payload = body.messages.at(-1)?.content ?? "";
        const sourceId = payload.match(
          /"sourceId":"(SRC-regulatory_text-[^"]+)"/,
        )?.[1];
        if (!sourceId)
          throw new Error("regulatory source ID missing from request");
        const anchor = {
          sourceId,
          sourceType: "regulatory_text",
          page: null,
          article: "第一条",
          paragraphIndex: 0,
          quote: "第一条 商业银行应当建立管理机制。",
        };
        output = {
          findings: [
            {
              findingId: "F1",
              category: "atomic_requirement",
              statement: "商业银行应当建立管理机制",
              claimType: "regulatory_fact",
              sourceAnchors: [anchor],
              inferenceParents: [],
              reviewStatus: "unreviewed",
              requiredReview: true,
              revisionRecords: [],
            },
          ],
          atomicRequirements: [
            {
              requirementId: "AR-F1",
              findingId: "F1",
              subject: "商业银行",
              action: "建立",
              object: "管理机制",
              condition: null,
              frequency: null,
              deadline: null,
              strength: "应当",
              responsibility: null,
              exceptions: null,
              sharedContext: "第一条",
              missingFacts: [],
              sourceAnchors: [anchor],
              confidence: 1,
              manualVerificationRequired: false,
            },
          ],
        };
      } else if (schemaName === "analysis_key_matters_v1") {
        output = { findings: [] };
      } else if (schemaName === "analysis_institution_impact_v1") {
        output = { impacts: [] };
      } else {
        throw new Error(`unexpected schema ${schemaName}`);
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
        }),
      });
    },
  );

  await page.goto("/");
  await expect(page.getByLabel("选择监管文件")).toBeVisible();
  await page.getByLabel("选择监管文件").setInputFiles({
    name: "监管办法.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("第一条 商业银行应当建立管理机制。", "utf8"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "解析完成" }).last(),
  ).toBeVisible();
  await page.getByLabel("选择官方解读").setInputFiles({
    name: "官方解读.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("官方说明：本条用于说明实施口径。", "utf8"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "解析完成" }).last(),
  ).toBeVisible();

  await page.getByRole("button", { name: "模型接口设置" }).click();
  const settings = page.getByRole("dialog", { name: "模型接口设置" });
  await settings.getByLabel("Base URL").fill("https://model.example/v1");
  await settings.getByLabel("API Key").fill(apiKey);
  await settings
    .getByLabel("模型", { exact: true })
    .fill("local-deterministic-model");
  await settings.getByRole("button", { name: "保存设置" }).click();
  await expect(settings).toBeHidden();

  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "开始监管分析" }).click();
  const consent = page.getByRole("dialog", { name: /第三方模型数据流/ });
  await consent.getByRole("checkbox").check();
  await consent.getByRole("button", { name: "确认并发送" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "监管分析完成" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(
    page.getByRole("heading", { name: "人工复核与修正" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "退回重新分析" }).click();
  const returnDialog = page.getByRole("dialog", { name: "退回重新分析" });
  await returnDialog.getByLabel("退回原因").fill("E2E 核验定向范围");
  await returnDialog.getByText(/F1 商业银行应当建立管理机制/).click();
  await returnDialog
    .locator("fieldset")
    .nth(1)
    .getByRole("checkbox")
    .first()
    .check();
  await returnDialog.getByText("原子条款", { exact: true }).click();
  await returnDialog.getByRole("button", { name: "提交重分析" }).click();
  await expect(page.getByRole("heading", { name: "监管分析" })).toBeVisible();
  await page.getByRole("button", { name: "取消重分析请求" }).click();
  await expect(
    page.getByRole("heading", { name: "人工复核与修正" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "确认 F1" }).click();
  await page
    .getByRole("button", { name: /删除 SYS-PENDING-FILE-PROFILE/ })
    .click();
  for (let index = 0; index < 10; index += 1) {
    const manualRule = page.getByTestId("manual-rule").first();
    if ((await manualRule.count()) === 0) break;
    await manualRule.getByLabel("规则复核理由").fill("E2E 逐项核对原文与结构");
    await manualRule.getByRole("button", { name: "确认该规则" }).click();
  }
  await expect(page.getByTestId("manual-rule")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一步" })).toBeEnabled();
  await page.waitForTimeout(150);
  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "已自动恢复" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "人工复核与修正" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "下一步" })).toBeEnabled();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "报告导出" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "外规解读报告" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 DOCX" })).toBeEnabled();
  await page.getByRole("tab", { name: "新规快评" }).click();
  await expect(
    page.getByRole("heading", { name: /一句话结论/u }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 PDF" })).toBeEnabled();
  const persistedSurface = await page.evaluate(async () => {
    const records: unknown[] = [];
    for (const database of await indexedDB.databases()) {
      if (!database.name) continue;
      const opened = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database.name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const storeName of [...opened.objectStoreNames]) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const transaction = opened.transaction(storeName, "readonly");
          const request = transaction.objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        records.push(...values);
      }
      opened.close();
    }
    return JSON.stringify({
      indexedDb: records,
      localStorage: { ...localStorage },
      url: location.href,
      reportDom: document.body.textContent,
    });
  });
  expect(persistedSurface).not.toContain(apiKey);
  expect(browserLogs.join("\n")).not.toContain(apiKey);
});
