import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { modelDataFlowConsent } from "../features/model/model-consent";
import { sessionCredentials } from "../features/model/session-credentials";
import type { WorkflowSession } from "./workflow-store";
import { WorkflowErrorBoundary, WorkflowShell } from "./WorkflowShell";

const emptySession = (): WorkflowSession => ({
  project: {
    projectId: "P1",
    projectName: "外规解读项目",
    workflowStep: "intake",
    sourceUnits: [],
    parsingCompleted: false,
    findings: [],
    qualityMetrics: {
      factCitationCoverage: 0,
      citationReverseCheckRate: 0,
      unsupportedFindingCount: 0,
      inferenceMarkingRate: 1,
      requiredReviewCompletionRate: 0,
    },
  },
  parseResults: [],
  parsedUnits: [],
  atomicRequirements: [],
  reviewAudits: [],
  ruleReviewAttestations: [],
  analysisVersions: [],
  pendingReanalysis: null,
  selectedFindingId: null,
  lastSavedAt: null,
});

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
          totalCharacters: 5,
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
