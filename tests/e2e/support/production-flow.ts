import { inflateRawSync } from "node:zlib";

import { expect, type Page } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const SYNTHETIC_REGULATORY_TEXT = [
  "第一条 示例银行应当建立管理机制。",
  "第二条 示例银行不得虚构合规记录。",
  "第三条 本办法自2026年1月1日起施行。",
].join("\n");

export const SYNTHETIC_OFFICIAL_TEXT = "官方说明：第一条用于说明年度实施口径。";

export const FULL_REPORT_HEADINGS = [
  "管理摘要",
  "文件基本信息、发文机关、文号、发布日期及效力待复核提示",
  "监管背景与政策目标",
  "适用对象和适用范围",
  "核心要求逐项解读",
  "禁止事项和监管红线",
  "生效日期、实施安排与过渡期",
  "对金融机构的主要影响",
  "建议行动及优先级",
  "待确认事项和风险提示",
  "原文证据索引与人工修订留痕",
] as const;

export const QUICK_REPORT_HEADINGS = [
  "一句话结论",
  "新规为什么重要",
  "最值得关注的三至五项变化",
  "禁止事项和不可触碰红线",
  "关键日期、过渡期和紧迫程度",
  "主要受影响机构、业务和部门",
  "近期行动清单",
  "重要限制、待确认事项和来源说明",
] as const;

const parsedChunk = (payload: string) => {
  const sourceType = payload.match(
    /"sourceChunk":\{"chunkId":"[^"]+","sourceType":"(regulatory_text|official_interpretation)"/u,
  )?.[1];
  const sourceId = payload.match(
    /"sourceChunk":\{.*?"units":\[\{"sourceId":"([^"]+)"/u,
  )?.[1];
  if (!sourceId || !sourceType)
    throw new Error(
      "production analysis request omitted source chunk identity",
    );
  return { sourceId, sourceType } as const;
};

const anchor = (
  sourceId: string,
  paragraphIndex: number,
  article: string,
  quote: string,
) => ({
  sourceId,
  sourceType: "regulatory_text" as const,
  page: null,
  article,
  paragraphIndex,
  quote,
});

export const installSuccessfulModelRoute = async (
  page: Page,
  baseUrl = "https://model.example/v1",
): Promise<void> => {
  await page.route(`${baseUrl}/chat/completions`, async (route) => {
    const body = route.request().postDataJSON() as {
      messages: Array<{ content: string }>;
      response_format: { json_schema: { name: string } };
    };
    const schemaName = body.response_format.json_schema.name;
    const payload = body.messages.at(-1)?.content ?? "";
    let output: unknown;
    if (schemaName === "connection_test") {
      output = { connection: "ok" };
    } else if (schemaName === "analysis_document_identity_v1") {
      parsedChunk(payload);
      output = { findings: [], conflicts: [] };
    } else if (schemaName === "analysis_atomic_clauses_v1") {
      const { sourceId } = parsedChunk(payload);
      const sourceAnchor = anchor(
        sourceId,
        0,
        "第一条",
        "第一条 示例银行应当建立管理机制。",
      );
      output = {
        findings: [
          {
            findingId: "F1",
            category: "atomic_requirement",
            statement: "示例银行应当建立管理机制",
            claimType: "regulatory_fact",
            sourceAnchors: [sourceAnchor],
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
            subject: "示例银行",
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
            sourceAnchors: [sourceAnchor],
            confidence: 1,
            manualVerificationRequired: false,
          },
        ],
      };
    } else if (schemaName === "analysis_key_matters_v1") {
      const { sourceId } = parsedChunk(payload);
      const definitions = [
        [
          "K1",
          "key_matter:core_requirement",
          0,
          "第一条",
          "第一条 示例银行应当建立管理机制。",
        ],
        [
          "K2",
          "key_matter:prohibition",
          1,
          "第二条",
          "第二条 示例银行不得虚构合规记录。",
        ],
        [
          "K3",
          "key_matter:effective_date",
          2,
          "第三条",
          "第三条 本办法自2026年1月1日起施行。",
        ],
      ] as const;
      output = {
        findings: definitions.map(
          ([findingId, category, paragraphIndex, article, quote]) => ({
            findingId,
            category,
            statement: quote,
            claimType: "regulatory_fact",
            sourceAnchors: [anchor(sourceId, paragraphIndex, article, quote)],
            inferenceParents: [],
            reviewStatus: "unreviewed",
            requiredReview: false,
            revisionRecords: [],
          }),
        ),
      };
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
  });
};

export const uploadAndAnalyze = async (
  page: Page,
  apiKey = "synthetic-session-key",
  baseUrl = "https://model.example/v1",
): Promise<void> => {
  await page.goto("/");
  await page.getByLabel("选择监管文件").setInputFiles({
    name: "合成监管办法.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(SYNTHETIC_REGULATORY_TEXT, "utf8"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "解析完成" }).last(),
  ).toBeVisible();
  await page.getByLabel("选择官方解读").setInputFiles({
    name: "合成官方解读.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(SYNTHETIC_OFFICIAL_TEXT, "utf8"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "解析完成" }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "模型接口设置" }).click();
  const settings = page.getByRole("dialog", { name: "模型接口设置" });
  await settings.getByLabel("Base URL").fill(baseUrl);
  await settings.getByLabel("API Key").fill(apiKey);
  await settings.getByLabel("模型", { exact: true }).fill("synthetic-model");
  await settings.getByRole("button", { name: "保存设置" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "开始监管分析" }).click();
  const consent = page.getByRole("dialog", { name: /第三方模型数据流/u });
  await consent.getByRole("checkbox").check();
  await consent.getByRole("button", { name: "确认并发送" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "监管分析完成" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(
    page.getByRole("heading", { name: "人工复核与修正" }),
  ).toBeVisible();
};

export const reviewAllFindings = async (page: Page): Promise<void> => {
  const pending = page.getByRole("button", {
    name: /删除 SYS-PENDING-FILE-PROFILE/u,
  });
  if (await pending.isVisible()) {
    await pending.click();
    await expect(
      page
        .getByTestId("review-item")
        .filter({ hasText: "SYS-PENDING-FILE-PROFILE" }),
    ).toContainText("deleted");
  }

  const cards = page.getByTestId("review-item");
  const ids = await cards.locator("strong").allTextContents();
  for (const rawId of ids) {
    const id = rawId.trim();
    if (!id || id === "SYS-PENDING-FILE-PROFILE") continue;
    const card = cards.filter({
      has: page.locator("strong").filter({
        hasText: new RegExp(
          `^${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
          "u",
        ),
      }),
    });
    await card.getByRole("button", { name: "查看依据" }).click();
    for (let ruleIndex = 0; ruleIndex < 12; ruleIndex += 1) {
      const manualRule = page.getByTestId("manual-rule").first();
      if ((await manualRule.count()) === 0) break;
      await manualRule
        .getByLabel("规则复核理由")
        .fill("E2E 已逐项核对当前原文与结构");
      await manualRule.getByRole("button", { name: "确认该规则" }).click();
    }
    const confirm = card.getByRole("button", { name: `确认 ${id}` });
    if (id !== "F1" && (await confirm.isEnabled())) {
      await confirm.click();
      await expect(card).toContainText("confirmed");
    }
  }
  await expect(page.getByTestId("manual-rule")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一步" })).toBeEnabled();
};

const unzipText = (bytes: Buffer, fileName: string): string => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length - 30; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString();
    if (name !== fileName) continue;
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    return (method === 0 ? compressed : inflateRawSync(compressed)).toString();
  }
  throw new Error(`ZIP entry missing: ${fileName}`);
};

export const unzipEntries = (bytes: Buffer): ReadonlyMap<string, Buffer> => {
  const entries = new Map<string, Buffer>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 30; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;
    const flags = view.getUint16(offset + 6, true);
    if ((flags & 0x08) !== 0)
      throw new Error("ZIP data descriptor is unsupported in E2E verifier");
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString();
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8)
      throw new Error(`unsupported ZIP compression method: ${method}`);
    entries.set(name, method === 0 ? compressed : inflateRawSync(compressed));
  }
  return entries;
};

const xmlText = (xml: string): string =>
  xml
    .replace(/<w:tab\s*\/>/gu, "\t")
    .replace(/<\/w:p>/gu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");

const pdfText = async (bytes: Buffer): Promise<string> => {
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const pdfPage = await document.getPage(pageNumber);
      const content = await pdfPage.getTextContent();
      pages.push(
        content.items.map((item) => ("str" in item ? item.str : "")).join(""),
      );
    }
    return pages.join("\n");
  } finally {
    await loadingTask.destroy();
  }
};

export interface DownloadedReport {
  readonly bytes: Buffer;
  readonly text: string;
  readonly archiveEntries: ReadonlyMap<string, Buffer> | null;
}

export const downloadReport = async (
  page: Page,
  buttonName: "下载 DOCX" | "下载 PDF",
  extension: "docx" | "pdf",
): Promise<DownloadedReport> => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: buttonName }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`\\.${extension}$`, "u"),
  );
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const archiveEntries = extension === "docx" ? unzipEntries(bytes) : null;
  return {
    bytes,
    archiveEntries,
    text:
      extension === "docx"
        ? xmlText(unzipText(bytes, "word/document.xml"))
        : await pdfText(bytes),
  };
};

const headingOneText = (documentXml: string): string[] =>
  [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu)]
    .filter(([paragraph]) =>
      /<w:pStyle\s+w:val="Heading1"\s*\/>/u.test(paragraph),
    )
    .map(([paragraph]) => xmlText(paragraph).trim());

const assertHeadingsInOrder = (
  text: string,
  headings: readonly string[],
): void => {
  let prior = -1;
  for (const heading of headings) {
    const index = text.indexOf(heading);
    expect(index, `missing heading: ${heading}`).toBeGreaterThan(prior);
    expect(text.indexOf(heading, index + heading.length)).toBe(-1);
    prior = index;
  }
};

export const assertReportStructure = (
  report: DownloadedReport,
  kind: "full" | "quick",
): void => {
  const headings =
    kind === "full" ? FULL_REPORT_HEADINGS : QUICK_REPORT_HEADINGS;
  assertHeadingsInOrder(report.text, headings);
  if (report.archiveEntries) {
    const documentXml = report.archiveEntries.get("word/document.xml");
    expect(documentXml, "DOCX word/document.xml missing").toBeDefined();
    expect(headingOneText(documentXml!.toString("utf8"))).toEqual(headings);
  }
  if (kind === "full") {
    expect(report.text).toContain("原文证据索引与人工修订留痕");
    expect(report.text).not.toContain("一句话结论");
    return;
  }
  expect(report.text).not.toContain("原文证据索引与人工修订留痕");
  const start = report.text.indexOf("最值得关注的三至五项变化");
  const end = report.text.indexOf("禁止事项和不可触碰红线", start);
  const section = report.text.slice(start, end);
  const topChanges = [
    "第一条 示例银行应当建立管理机制。",
    "第二条 示例银行不得虚构合规记录。",
    "第三条 本办法自2026年1月1日起施行。",
    "示例银行应当建立管理机制。",
  ].filter((statement) => section.includes(statement));
  expect(topChanges.length).toBeGreaterThanOrEqual(3);
  expect(topChanges.length).toBeLessThanOrEqual(5);
};
