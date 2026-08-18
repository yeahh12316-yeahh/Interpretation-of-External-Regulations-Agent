import { inflateRawSync } from "node:zlib";

import { expect, type FilePayload, type Page } from "@playwright/test";
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
  const parsed = JSON.parse(payload.slice(payload.indexOf("\n") + 1)) as {
    sourceChunk?: {
      sourceType?: "regulatory_text" | "official_interpretation";
      units?: Array<{ sourceId?: string }>;
      authoritativeLocators?: Array<{
        sourceId: string;
        sourceType: "regulatory_text" | "official_interpretation";
        page: number | null;
        article: string | null;
        paragraphIndex: number;
        text: string;
      }>;
    };
  };
  const sourceType = parsed.sourceChunk?.sourceType;
  const sourceId = parsed.sourceChunk?.units?.[0]?.sourceId;
  if (!sourceId || !sourceType)
    throw new Error(
      "production analysis request omitted source chunk identity",
    );
  const authoritativeLocators = parsed.sourceChunk?.authoritativeLocators ?? [];
  return { sourceId, sourceType, authoritativeLocators } as const;
};

const anchor = (
  sourceId: string,
  quote: string,
  authoritativeLocators: ReturnType<
    typeof parsedChunk
  >["authoritativeLocators"],
) => {
  const locator = authoritativeLocators.find(
    (candidate) =>
      candidate.sourceId === sourceId && candidate.text.includes(quote),
  );
  if (!locator)
    throw new Error(
      "production analysis request omitted authoritative locator",
    );
  return {
    sourceId,
    sourceType: locator.sourceType,
    page: locator.page,
    article: locator.article,
    paragraphIndex: locator.paragraphIndex,
    quote,
  };
};

export const installSuccessfulModelRoute = async (
  page: Page,
  baseUrl = "https://model.example/v1",
  options: { readonly includeOfficialIdentity?: boolean } = {},
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
      const { sourceId, sourceType, authoritativeLocators } =
        parsedChunk(payload);
      if (!options.includeOfficialIdentity) {
        output = { findings: [], conflicts: [] };
      } else {
        const locator = authoritativeLocators.find(
          (candidate) =>
            candidate.sourceId === sourceId && candidate.text.trim(),
        );
        if (!locator)
          throw new Error(
            "production document identity request omitted authoritative locator",
          );
        const sourceAnchor = anchor(
          sourceId,
          locator.text,
          authoritativeLocators,
        );
        output =
          sourceType === "regulatory_text"
            ? {
                findings: [
                  {
                    findingId: "DOC-PRIMARY",
                    kind: "document_title",
                    extractedValue: locator.text,
                    sourceAnchors: [sourceAnchor],
                    confidence: 1,
                  },
                ],
                conflicts: [],
              }
            : {
                findings: [
                  {
                    findingId: "OFF-SCAN",
                    kind: "implementation_guidance",
                    sourceExcerpt: locator.text,
                    sourceAnchors: [sourceAnchor],
                    pairedPrimaryFindingIds: ["DOC-PRIMARY"],
                    confidence: 1,
                  },
                ],
                conflicts: [],
              };
      }
    } else if (schemaName === "analysis_atomic_clauses_v1") {
      const { sourceId, authoritativeLocators } = parsedChunk(payload);
      const sourceAnchor = anchor(
        sourceId,
        "第一条 示例银行应当建立管理机制。",
        authoritativeLocators,
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
      const { sourceId, authoritativeLocators } = parsedChunk(payload);
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
          ([findingId, category, _paragraphIndex, _article, quote]) => ({
            findingId,
            category,
            statement: quote,
            claimType: "regulatory_fact",
            sourceAnchors: [anchor(sourceId, quote, authoritativeLocators)],
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
  rememberEndpointAndModel = false,
  options: {
    readonly navigate?: boolean;
    readonly regulatoryFile?: FilePayload;
    readonly officialFile?: FilePayload;
  } = {},
): Promise<void> => {
  if (options.navigate !== false) await page.goto("./");
  await page.getByLabel("选择监管文件").setInputFiles(
    options.regulatoryFile ?? {
      name: "合成监管办法.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(SYNTHETIC_REGULATORY_TEXT, "utf8"),
    },
  );
  const regulatoryUpload = page.getByRole("region", {
    name: "监管文件上传",
  });
  await expect(
    regulatoryUpload.getByRole("status").filter({ hasText: "解析完成" }),
  ).toBeVisible();
  await page.getByLabel("选择官方解读").setInputFiles(
    options.officialFile ?? {
      name: "合成官方解读.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(SYNTHETIC_OFFICIAL_TEXT, "utf8"),
    },
  );
  const officialUpload = page.getByRole("region", {
    name: "官方解读上传",
  });
  await expect(officialUpload).toContainText(
    options.officialFile?.name ?? "合成官方解读.txt",
  );
  await expect(
    officialUpload.getByRole("status").filter({ hasText: "解析完成" }),
  ).toBeVisible();
  await expect(officialUpload).toHaveAttribute(
    "data-finalization-ready",
    "true",
  );
  await page.getByRole("button", { name: "模型接口设置" }).click();
  const settings = page.getByRole("dialog", { name: "模型接口设置" });
  await settings.getByLabel("Base URL").fill(baseUrl);
  await settings.getByLabel("API Key").fill(apiKey);
  await settings.getByLabel("模型", { exact: true }).fill("synthetic-model");
  if (rememberEndpointAndModel)
    await settings
      .getByRole("checkbox", { name: "记住接口地址和模型" })
      .check();
  await settings.getByRole("button", { name: "保存设置" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  const ocrReviews = page.getByRole("region", { name: /页 OCR 审阅/u });
  if ((await ocrReviews.count()) > 0)
    await expect(ocrReviews.first()).toContainText("OCR 已自动通过");
  await expect(page.getByRole("button", { name: "下一步" })).toBeEnabled();
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
    if (await card.getByText("deleted", { exact: true }).isVisible()) continue;
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
        content.items
          .map((item) =>
            "str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "",
          )
          .join(""),
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

const docxTopChangesCount = (documentXml: string): number => {
  const paragraphs = [
    ...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu),
  ].map(([paragraph]) => paragraph);
  const start = paragraphs.findIndex(
    (paragraph) =>
      /<w:pStyle\s+w:val="Heading1"\s*\/>/u.test(paragraph) &&
      xmlText(paragraph).trim() === "最值得关注的三至五项变化",
  );
  if (start < 0) return 0;
  const endOffset = paragraphs
    .slice(start + 1)
    .findIndex((paragraph) =>
      /<w:pStyle\s+w:val="Heading1"\s*\/>/u.test(paragraph),
    );
  const end = endOffset < 0 ? paragraphs.length : start + 1 + endOffset;
  return paragraphs
    .slice(start + 1, end)
    .filter((paragraph) => /<w:numPr(?:\s[^>]*)?>/u.test(paragraph)).length;
};

const pdfTopChangesCount = (text: string): number => {
  const start = text.indexOf("最值得关注的三至五项变化");
  const end = text.indexOf("禁止事项和不可触碰红线", start);
  if (start < 0 || end <= start) return 0;
  return text
    .slice(start, end)
    .split(/\r?\n/u)
    .filter((line) => /^\s*•\s*\S.+｜/u.test(line)).length;
};

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
  const topChanges = report.archiveEntries
    ? docxTopChangesCount(
        report.archiveEntries.get("word/document.xml")!.toString("utf8"),
      )
    : pdfTopChangesCount(report.text);
  expect(
    topChanges,
    "top_changes must contain 3–5 structural list items",
  ).toBeGreaterThanOrEqual(3);
  expect(
    topChanges,
    "top_changes must contain 3–5 structural list items",
  ).toBeLessThanOrEqual(5);
};
