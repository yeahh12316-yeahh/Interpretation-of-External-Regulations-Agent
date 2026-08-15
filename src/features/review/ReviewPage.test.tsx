import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import type { Project } from "../../domain/project";
import {
  createAnalysisVersion,
  type ReviewWorkflowState,
} from "./review-actions";
import { ReviewPage } from "./ReviewPage";

const anchor = {
  sourceId: "REG-A",
  sourceType: "regulatory_text" as const,
  page: 1,
  article: "第一条",
  paragraphIndex: 0,
  quote: "商业银行应建立管理机制",
};

const project: Project = {
  projectId: "P1",
  projectName: "复核项目",
  workflowStep: "review",
  sourceUnits: [
    {
      sourceId: "REG-A",
      sourceType: "regulatory_text",
      title: "监管办法",
      content: "第一条 商业银行应建立管理机制。",
    },
  ],
  parsingCompleted: true,
  findings: [
    {
      findingId: "F2",
      category: "一般影响",
      statement: "可能调整流程",
      claimType: "pending_confirmation",
      sourceAnchors: [anchor],
      inferenceParents: [],
      reviewStatus: "unreviewed",
      requiredReview: false,
      revisionRecords: [],
    },
    {
      findingId: "F1",
      category: "atomic_requirement",
      statement: "商业银行应建立管理机制",
      claimType: "regulatory_fact",
      sourceAnchors: [anchor],
      inferenceParents: [],
      reviewStatus: "unreviewed",
      requiredReview: true,
      revisionRecords: [],
    },
  ],
  qualityMetrics: {
    factCitationCoverage: 0,
    citationReverseCheckRate: 0,
    unsupportedFindingCount: 1,
    inferenceMarkingRate: 1,
    requiredReviewCompletionRate: 0,
  },
};

const session = (): ReviewWorkflowState => ({
  project: structuredClone(project),
  parsedUnits: [
    {
      unitId: "U1",
      sourceId: "REG-A",
      sourceType: "regulatory_text",
      page: 1,
      article: "第一条",
      paragraphIndex: 0,
      text: "第一条 商业银行应建立管理机制。",
      extractionMethod: "text_layer",
      confidence: 1,
    },
  ],
  atomicRequirements: [
    {
      requirementId: "AR1",
      findingId: "F1",
      subject: "商业银行",
      action: "建立",
      object: "管理机制",
      condition: null,
      frequency: null,
      deadline: null,
      strength: "应",
      responsibility: null,
      exceptions: null,
      sharedContext: null,
      missingFacts: [],
      sourceAnchors: [anchor],
      confidence: 1,
      manualVerificationRequired: true,
    },
  ],
  reviewAudits: [],
  reviewActions: [],
  ruleReviewAttestations: [],
  analysisVersions: [
    createAnalysisVersion({
      versionId: "V1",
      projectId: "P1",
      parentVersionHash: null,
      createdAt: "2026-08-15T00:00:00.000Z",
      reason: "首次分析",
      findings: structuredClone(project.findings),
      atomicRequirements: [
        {
          requirementId: "AR1",
          findingId: "F1",
          subject: "商业银行",
          action: "建立",
          object: "管理机制",
          condition: null,
          frequency: null,
          deadline: null,
          strength: "应",
          responsibility: null,
          exceptions: null,
          sharedContext: null,
          missingFacts: [],
          sourceAnchors: [anchor],
          confidence: 1,
          manualVerificationRequired: true,
        },
      ],
      inferenceRelationships: [],
      conflicts: [],
      replacedFindingIds: project.findings.map(({ findingId }) => findingId),
      sourceIds: ["REG-A"],
      scope: ["atomic_clauses"],
      reanalysisProvenance: null,
    }),
  ],
  pendingReanalysis: null,
});

it("orders required review first and keeps F1/F2 selection synced with evidence", async () => {
  const user = userEvent.setup();
  render(<ReviewPage state={session()} onChange={vi.fn()} />);

  const items = screen.getAllByTestId("review-item");
  expect(items[0]).toHaveTextContent("F1");
  await user.click(within(items[1]).getByRole("button", { name: "查看原文" }));
  expect(
    within(screen.getByRole("complementary", { name: "原文证据" })).getByRole(
      "heading",
      { name: "一般影响" },
    ),
  ).toBeVisible();
  expect(screen.getByText("可能调整流程")).toBeVisible();
  await user.click(within(items[0]).getByRole("button", { name: "查看依据" }));
  expect(screen.getByTestId("evidence-highlight")).toHaveTextContent(
    "商业银行应建立管理机制",
  );
  await user.click(within(items[0]).getByRole("button", { name: "查看详情" }));
  expect(within(items[0]).getByText("监管事实")).toBeVisible();
});

it("wires confirm, modify, soft-delete, human judgment, rule review and return actions", async () => {
  const user = userEvent.setup();
  let current = session();
  const onChange = vi.fn((next: ReviewWorkflowState) => {
    current = next;
    rerender(<ReviewPage state={current} onChange={onChange} />);
  });
  const { rerender } = render(
    <ReviewPage state={current} onChange={onChange} />,
  );

  await user.click(screen.getByRole("button", { name: "确认 F1" }));
  expect(
    current.project.findings.find(({ findingId }) => findingId === "F1")
      ?.reviewStatus,
  ).toBe("confirmed");

  await user.click(screen.getByRole("button", { name: "修改 F1" }));
  await user.clear(screen.getByLabelText("修改后陈述"));
  await user.type(
    screen.getByLabelText("修改后陈述"),
    "商业银行必须建立管理机制",
  );
  await user.type(screen.getByLabelText("修改理由"), "保持监管原文强度");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  expect(
    current.project.findings.find(({ findingId }) => findingId === "F1")
      ?.statement,
  ).toContain("必须");
  expect(current.reviewAudits).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "删除 F2" }));
  expect(
    current.project.findings.find(({ findingId }) => findingId === "F2")
      ?.reviewStatus,
  ).toBe("deleted");

  await user.click(screen.getByRole("button", { name: "新增人工判断" }));
  await user.type(
    screen.getByLabelText("人工判断陈述"),
    "适用范围由合规人员进一步确认",
  );
  await user.selectOptions(
    screen.getByLabelText("报告用途"),
    "recommended_action",
  );
  expect(screen.getByLabelText("报告用途")).toHaveValue("recommended_action");
  await user.type(screen.getByLabelText("判断理由"), "涉及机构实际情况");
  await user.click(screen.getByRole("button", { name: "保存人工判断" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(current.project.findings.at(-1)).toMatchObject({
    claimType: "human_judgment",
    category: "recommended_action:priority",
  });

  const manualRule = screen.getAllByTestId("manual-rule")[0];
  await user.type(
    within(manualRule).getByLabelText("规则复核理由"),
    "已逐字核对原文",
  );
  await user.click(
    within(manualRule).getByRole("button", { name: "确认该规则" }),
  );
  expect(current.ruleReviewAttestations.length).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "退回重新分析" }));
  await user.type(screen.getByLabelText("退回原因"), "重新核对原子要求");
  await user.click(screen.getByRole("checkbox", { name: /F1/ }));
  await user.click(screen.getByRole("checkbox", { name: "REG-A" }));
  await user.click(screen.getByRole("checkbox", { name: "原子条款" }));
  await user.click(screen.getByRole("button", { name: "提交重分析" }));
  expect(current.pendingReanalysis?.targetFindingIds).toEqual(["F1"]);
});

it("keeps review dialogs keyboard-contained with inline validation and restores focus", async () => {
  const user = userEvent.setup();
  render(<ReviewPage state={session()} onChange={vi.fn()} />);
  const opener = screen.getByRole("button", { name: "修改 F1" });
  await user.click(opener);
  const dialog = screen.getByRole("dialog", { name: /修改结论 F1/ });
  const statement = within(dialog).getByLabelText("修改后陈述");
  expect(statement).toHaveFocus();
  expect(
    within(dialog).getByRole("button", { name: "保存修改" }),
  ).toBeDisabled();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(/理由|不同/);
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("dialog", { name: /修改结论/ }),
  ).not.toBeInTheDocument();
  expect(opener).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "退回重新分析" }));
  const returnDialog = screen.getByRole("dialog", { name: "退回重新分析" });
  expect(within(returnDialog).getByLabelText("退回原因")).toHaveFocus();
  expect(
    within(returnDialog).getByRole("button", { name: "提交重分析" }),
  ).toBeDisabled();
  expect(within(returnDialog).getByRole("alert")).toHaveTextContent(
    /目标|来源|范围/,
  );
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("dialog", { name: "退回重新分析" }),
  ).not.toBeInTheDocument();
});

it("rejects an ambiguous evidence rule through the controlled UI", async () => {
  const user = userEvent.setup();
  let current = session();
  const onChange = vi.fn((next: ReviewWorkflowState) => {
    current = next;
    rerender(<ReviewPage state={current} onChange={onChange} />);
  });
  const { rerender } = render(
    <ReviewPage state={current} onChange={onChange} />,
  );
  const rule = screen.getAllByTestId("manual-rule")[0];
  await user.type(within(rule).getByLabelText("规则复核理由"), "当前证据不足");
  await user.click(within(rule).getByRole("button", { name: "否决该规则" }));
  expect(current.ruleReviewAttestations).toHaveLength(1);
  expect(current.ruleReviewAttestations[0].decision).toBe("rejected");
});
