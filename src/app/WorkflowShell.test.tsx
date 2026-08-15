import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { modelDataFlowConsent } from "../features/model/model-consent";
import { sessionCredentials } from "../features/model/session-credentials";
import {
  createAnalysisVersion,
  returnForReanalysis,
} from "../features/review/review-actions";
import {
  createEmptyWorkflowSession,
  sealWorkflowSession,
  type WorkflowSession,
} from "./workflow-store";
import { WorkflowErrorBoundary, WorkflowShell } from "./WorkflowShell";

const emptySession = (): WorkflowSession =>
  createEmptyWorkflowSession("P1", "外规解读项目");

afterEach(() => {
  sessionCredentials.clear();
  modelDataFlowConsent.clear();
});

const analysisSession = (): WorkflowSession => {
  const session = emptySession();
  const source = {
    sourceId: "REG-A",
    sourceType: "regulatory_text" as const,
    title: "办法",
    content: "第一条 原文",
  };
  const unit = {
    unitId: "U1",
    sourceId: "REG-A",
    sourceType: "regulatory_text" as const,
    page: null,
    article: "第一条",
    paragraphIndex: 0,
    text: "第一条 原文",
    extractionMethod: "plain_text" as const,
    confidence: 1,
  };
  return {
    ...session,
    project: {
      ...session.project,
      workflowStep: "analysis",
      sourceUnits: [source],
      parsingCompleted: true,
    },
    parsedUnits: [unit],
    parseResults: [
      {
        fileHash: "a".repeat(64),
        source,
        pageCount: null,
        successfulPages: [],
        failedPages: [],
        units: [unit],
        ocrReviews: [],
        anchors: [
          {
            sourceId: "REG-A",
            sourceType: "regulatory_text",
            page: null,
            article: "第一条",
            paragraphIndex: 0,
            quote: "第一条 原文",
          },
        ],
        quality: {
          totalCharacters: source.content.length,
          parsedUnitCount: 1,
          failedPageCount: 0,
          lowTextPages: [],
          extractionCoverage: 1,
          ocrFailedPages: [],
          finalizationBlocked: false,
        },
      },
    ],
  };
};

it("renders the production five-step shell and fails closed navigation", async () => {
  const user = userEvent.setup();
  render(<WorkflowShell initialSession={emptySession()} />);
  await user.click(screen.getByRole("button", { name: /监管分析/ }));
  expect(screen.getByRole("alert")).toHaveTextContent("请先完成文件解析");
  expect(screen.getByRole("heading", { name: "材料上传" })).toBeVisible();
  expect(screen.getByRole("button", { name: "上一步" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
});

it("blocks failed parse outcomes and never calls analysis without model config/consent", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  const session = emptySession();
  session.project = {
    ...session.project,
    workflowStep: "parsing",
    sourceUnits: [
      {
        sourceId: "REG-A",
        sourceType: "regulatory_text",
        title: "办法",
        content: "原文",
      },
    ],
    parsingCompleted: false,
  };
  session.parseResults = [
    {
      fileHash: "a".repeat(64),
      source: session.project.sourceUnits[0],
      pageCount: 1,
      successfulPages: [],
      failedPages: [{ page: 1, error: "解析失败" }],
      units: [],
      ocrReviews: [],
      anchors: [],
      quality: {
        totalCharacters: 0,
        parsedUnitCount: 0,
        failedPageCount: 1,
        lowTextPages: [],
        extractionCoverage: 0,
        ocrFailedPages: [],
        finalizationBlocked: true,
      },
    },
  ];
  render(<WorkflowShell initialSession={session} runAnalysisImpl={run} />);
  await user.click(screen.getByRole("button", { name: "下一步" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/解析|OCR/);
  expect(run).not.toHaveBeenCalled();
});

it("uses the authoritative Task 8 parse gate and blocks stale source content", async () => {
  const session = analysisSession();
  session.project = {
    ...session.project,
    workflowStep: "parsing",
    sourceUnits: [
      { ...session.project.sourceUnits[0], content: "第一条 原文（已变化）" },
    ],
  };
  render(<WorkflowShell initialSession={session} />);
  expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(/解析|OCR/);
});

it("automatically restores the latest valid session on production mount", async () => {
  const restored = createEmptyWorkflowSession("LOCAL-PROJECT", "自动恢复项目");
  const repository = {
    load: vi.fn().mockResolvedValue(restored),
    save: vi.fn(),
  };
  render(<WorkflowShell repository={repository} />);
  expect(
    screen.getByRole("heading", { name: "正在恢复最近保存" }),
  ).toBeVisible();
  expect(await screen.findByRole("status")).toHaveTextContent("已自动恢复");
  expect(repository.load).toHaveBeenCalledWith("LOCAL-PROJECT");
});

it("shows error recovery controls and restores the last saved session", async () => {
  const user = userEvent.setup();
  const good = emptySession();
  const load = vi.fn().mockResolvedValue(good);
  render(
    <WorkflowShell
      initialSession={emptySession()}
      repository={{ save: vi.fn(), load }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "恢复最近保存" }));
  expect(load).toHaveBeenCalledWith("P1");
  expect(screen.getByRole("status")).toHaveTextContent("已恢复最近保存");
});

it("does not call the model before configuration and explicit data-flow consent", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  const { rerender } = render(
    <WorkflowShell initialSession={analysisSession()} runAnalysisImpl={run} />,
  );
  await user.click(screen.getByRole("button", { name: "开始监管分析" }));
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "模型接口设置" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "取消" }));

  sessionCredentials.set({
    baseUrl: "https://model.example/v1",
    apiKey: "session-only-secret",
    model: "safe-model",
  });
  rerender(
    <WorkflowShell initialSession={analysisSession()} runAnalysisImpl={run} />,
  );
  await user.click(screen.getByRole("button", { name: "开始监管分析" }));
  expect(run).not.toHaveBeenCalled();
  expect(
    screen.getByRole("dialog", { name: /第三方模型数据流/ }),
  ).toBeVisible();
});

it("cancels a running analysis and preserves the saved version", async () => {
  const user = userEvent.setup();
  sessionCredentials.set({
    baseUrl: "https://model.example/v1",
    apiKey: "session-only-secret",
    model: "safe-model",
  });
  modelDataFlowConsent.acknowledge();
  const run = vi.fn(
    (_input, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      ),
  );
  render(
    <WorkflowShell
      initialSession={analysisSession()}
      runAnalysisImpl={run as never}
    />,
  );
  await user.click(screen.getByRole("button", { name: "开始监管分析" }));
  await user.click(await screen.findByRole("button", { name: "取消分析" }));
  expect(await screen.findByRole("status")).toHaveTextContent("分析已取消");
});

it("passes a trusted targeted directive and cancellation clears the request and restores review", async () => {
  const user = userEvent.setup();
  sessionCredentials.set({
    baseUrl: "https://model.example/v1",
    apiKey: "session-only-secret",
    model: "safe-model",
  });
  modelDataFlowConsent.acknowledge();
  const base = analysisSession();
  const anchor = base.parseResults[0].anchors[0];
  const finding = {
    findingId: "F1",
    category: "key_matter:requirement",
    statement: "第一条 原文",
    claimType: "regulatory_fact" as const,
    sourceAnchors: [anchor],
    inferenceParents: [],
    reviewStatus: "unreviewed" as const,
    requiredReview: true,
    revisionRecords: [],
  };
  const reviewSession: WorkflowSession = sealWorkflowSession({
    ...base,
    project: {
      ...base.project,
      workflowStep: "review",
      findings: [finding],
    },
    analysisVersions: [
      createAnalysisVersion({
        versionId: "V1",
        projectId: "P1",
        parentVersionHash: null,
        createdAt: "2026-08-15T00:00:00.000Z",
        reason: "首次分析",
        findings: [finding],
        atomicRequirements: [],
        inferenceRelationships: [],
        conflicts: [],
        replacedFindingIds: ["F1"],
        sourceIds: ["REG-A"],
        scope: ["key_matters"],
        reanalysisProvenance: null,
      }),
    ],
  });
  const requested = returnForReanalysis(reviewSession, {
    reason: "重新核验",
    targetFindingIds: ["F1"],
    sourceIds: ["REG-A"],
    scope: ["key_matters"],
    requestedBy: "复核人",
    requestedAt: "2026-08-15T01:00:00.000Z",
  });
  const pending = sealWorkflowSession({ ...reviewSession, ...requested });
  const run = vi.fn(
    (_input, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      ),
  );
  const repository = {
    load: vi.fn(),
    save: vi.fn(async (value: WorkflowSession, revision: number) =>
      sealWorkflowSession({ ...value, revision: revision + 1 }),
    ),
  };
  render(
    <WorkflowShell
      initialSession={pending}
      repository={repository}
      runAnalysisImpl={run as never}
    />,
  );
  await user.click(screen.getByRole("button", { name: "执行定向重分析" }));
  expect(run.mock.calls[0][0].reanalysisDirective).toMatchObject({
    targetFindingIds: ["F1"],
    allowedSourceIds: ["REG-A"],
  });
  expect(screen.getByRole("button", { name: /人工复核与修正/ })).toBeDisabled();
  await user.click(await screen.findByRole("button", { name: "取消分析" }));
  expect(
    await screen.findByRole("heading", { name: "人工复核与修正" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "取消重分析请求" }),
  ).not.toBeInTheDocument();
});

it("redacts arbitrary analysis failures from the DOM", async () => {
  const user = userEvent.setup();
  sessionCredentials.set({
    baseUrl: "https://model.example/v1",
    apiKey: "session-only-secret",
    model: "safe-model",
  });
  modelDataFlowConsent.acknowledge();
  const run = vi
    .fn()
    .mockRejectedValue(new Error("session-only-secret 第一条 原文"));
  render(
    <WorkflowShell initialSession={analysisSession()} runAnalysisImpl={run} />,
  );
  await user.click(screen.getByRole("button", { name: "开始监管分析" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("监管分析失败");
  expect(document.body.textContent).not.toContain("session-only-secret");
  expect(screen.getByRole("alert")).not.toHaveTextContent("第一条 原文");
});

it("contains render errors and offers retry/back controls", () => {
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const Bomb = () => {
    throw new Error("sensitive render detail");
  };
  render(
    <WorkflowErrorBoundary onBack={vi.fn()}>
      <Bomb />
    </WorkflowErrorBoundary>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("页面发生错误");
  expect(screen.queryByText("sensitive render detail")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重试" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "返回上一步" })).toBeEnabled();
  consoleError.mockRestore();
});
