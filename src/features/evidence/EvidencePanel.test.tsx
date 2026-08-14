import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import type { Finding } from "../../domain/finding";
import type { SourceUnit } from "../../domain/source";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import { EvidencePanel } from "./EvidencePanel";
import { ruleReviewBinding } from "./review-attestation";

const sources: SourceUnit[] = [
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    title: "监管文件甲.pdf",
    content: "第七条 金融机构应当建立制度。\n第十八条 金融机构不得删除记录。",
  },
  {
    sourceId: "OFF-1",
    sourceType: "official_interpretation",
    title: "官方解读乙.docx",
    content: "第十八条 官方解读说明不得删除记录。",
  },
];

const parsedUnits: ParsedSourceUnit[] = [
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 7,
    article: "第七条",
    paragraphIndex: 0,
    text: "第七条 金融机构应当建立制度。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
  {
    sourceId: "REG-1",
    sourceType: "regulatory_text",
    page: 18,
    article: "第十八条",
    paragraphIndex: 0,
    text: "第十八条 金融机构不得删除记录。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
  {
    sourceId: "OFF-1",
    sourceType: "official_interpretation",
    page: 18,
    article: "第十八条",
    paragraphIndex: 0,
    text: "第十八条 官方解读说明不得删除记录。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
];

const findings: Finding[] = [
  {
    findingId: "F1",
    category: "atomic_requirement",
    statement: "金融机构应当建立制度。",
    claimType: "regulatory_fact",
    sourceAnchors: [
      {
        sourceId: "REG-1",
        sourceType: "regulatory_text",
        page: 7,
        article: "第七条",
        paragraphIndex: 0,
        quote: "金融机构应当建立制度。",
      },
    ],
    inferenceParents: [],
    reviewStatus: "unreviewed",
    requiredReview: true,
    revisionRecords: [],
  },
  {
    findingId: "F2",
    category: "key_matter:prohibition",
    statement: "官方解读说明不得删除记录。",
    claimType: "official_explanation",
    sourceAnchors: [
      {
        sourceId: "OFF-1",
        sourceType: "official_interpretation",
        page: 18,
        article: "第十八条",
        paragraphIndex: 0,
        quote: "官方解读说明不得删除记录。",
      },
    ],
    inferenceParents: [],
    reviewStatus: "unreviewed",
    requiredReview: true,
    revisionRecords: [],
  },
];

describe("EvidencePanel", () => {
  test("updates file, page, article, excerpt, highlight, and type when selection changes", () => {
    const { rerender } = render(
      <EvidencePanel
        selectedFindingId="F1"
        findings={findings}
        sources={sources}
        parsedUnits={parsedUnits}
      />,
    );

    expect(screen.getByText("第7页")).toBeVisible();
    expect(screen.getAllByText("第七条").length).toBeGreaterThan(0);
    expect(screen.getByText("监管事实")).toBeVisible();
    expect(screen.getByTestId("evidence-highlight")).toHaveTextContent(
      "金融机构应当建立制度。",
    );

    rerender(
      <EvidencePanel
        selectedFindingId="F2"
        findings={findings}
        sources={sources}
        parsedUnits={parsedUnits}
      />,
    );

    expect(screen.getByText("第18页")).toBeVisible();
    expect(screen.getAllByText("第十八条").length).toBeGreaterThan(0);
    expect(screen.getByText("官方解读乙.docx")).toBeVisible();
    expect(screen.getAllByText("官方解读")).toHaveLength(2);
    expect(screen.getByTestId("evidence-original")).toHaveTextContent(
      "第十八条 官方解读说明不得删除记录。",
    );
    expect(screen.queryByText("第7页")).not.toBeInTheDocument();
  });

  test("opens and closes real per-rule validation details", () => {
    render(
      <EvidencePanel
        selectedFindingId="F1"
        findings={findings}
        sources={sources}
        parsedUnits={parsedUnits}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看校验详情" }));
    expect(screen.getByRole("dialog", { name: "证据校验详情" })).toBeVisible();
    expect(screen.getByText("引用反向匹配")).toBeVisible();
    expect(screen.getAllByText("自动通过").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "关闭校验详情" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("uses the same official-to-primary pairing boundary as quality validation", () => {
    const excerpt = "官方解读说明不得删除记录。";
    const officialFinding: Finding = {
      ...findings[1],
      category: "official_context:policy_background",
      statement: `官方解读材料摘录（政策背景）：“${excerpt}”。该摘录仅作为官方说明材料，不建立或覆盖监管文件效力、适用性或其他法律结论，须经人工合规复核。`,
      sourceAnchors: [{ ...findings[1].sourceAnchors[0], quote: excerpt }],
      inferenceParents: [findings[0].findingId],
    };
    const { rerender } = render(
      <EvidencePanel
        selectedFindingId={officialFinding.findingId}
        findings={[findings[0], officialFinding]}
        sources={sources}
        parsedUnits={parsedUnits}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看校验详情" }));
    let provenanceRule = screen.getByText("推导父项").closest("li");
    expect(provenanceRule).not.toBeNull();
    expect(within(provenanceRule!).getByText("校验失败")).toBeVisible();

    rerender(
      <EvidencePanel
        officialPrimarySourceIds={{ "OFF-1": ["REG-1"] }}
        selectedFindingId={officialFinding.findingId}
        findings={[findings[0], officialFinding]}
        sources={sources}
        parsedUnits={parsedUnits}
      />,
    );
    provenanceRule = screen.getByText("推导父项").closest("li");
    expect(provenanceRule).not.toBeNull();
    expect(within(provenanceRule!).getByText("自动通过")).toBeVisible();
  });

  test("distinguishes pending, confirmed, rejected, and failed validation outcomes", () => {
    const manualSource: SourceUnit = {
      sourceId: "REG-MANUAL",
      sourceType: "regulatory_text",
      title: "合成人工确认材料.txt",
      content: "机构应建立制度。",
    };
    const manualUnit: ParsedSourceUnit = {
      sourceId: manualSource.sourceId,
      sourceType: manualSource.sourceType,
      page: null,
      article: null,
      paragraphIndex: 0,
      text: manualSource.content,
      extractionMethod: "plain_text",
      confidence: 1,
    };
    const manualFinding: Finding = {
      ...findings[0],
      findingId: "F-MANUAL",
      statement: manualSource.content,
      sourceAnchors: [
        {
          sourceId: manualSource.sourceId,
          sourceType: manualSource.sourceType,
          page: null,
          article: null,
          paragraphIndex: 0,
          quote: manualSource.content,
        },
      ],
    };
    const requirement: AtomicRequirement = {
      requirementId: "AR-MANUAL",
      findingId: manualFinding.findingId,
      subject: "机构",
      strength: "应",
      action: "建立",
      object: "制度",
      condition: null,
      frequency: null,
      deadline: null,
      responsibility: null,
      exceptions: null,
      sharedContext: null,
      missingFacts: [],
      sourceAnchors: manualFinding.sourceAnchors,
      confidence: 1,
      manualVerificationRequired: false,
    };
    const binding = ruleReviewBinding(manualFinding, requirement);
    const baseAttestation = {
      ...binding,
      reviewer: "复核员",
      reviewedAt: "2026-08-15T01:00:00.000Z",
      reason: "已逐字核对原文与结构化字段。",
    };
    const { rerender } = render(
      <EvidencePanel
        atomicRequirements={[requirement]}
        selectedFindingId={manualFinding.findingId}
        findings={[manualFinding]}
        sources={[manualSource]}
        parsedUnits={[manualUnit]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看校验详情" }));
    expect(screen.getAllByText("需人工确认")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "关闭校验详情" }));

    const confirmed = (["atomic_structure", "modal_strength"] as const).map(
      (rule) => ({ ...baseAttestation, rule, decision: "confirmed" as const }),
    );
    rerender(
      <EvidencePanel
        atomicRequirements={[requirement]}
        ruleReviewAttestations={confirmed}
        selectedFindingId={manualFinding.findingId}
        findings={[manualFinding]}
        sources={[manualSource]}
        parsedUnits={[manualUnit]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看校验详情" }));
    expect(screen.getAllByText("人工已确认")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "关闭校验详情" }));

    rerender(
      <EvidencePanel
        atomicRequirements={[requirement]}
        ruleReviewAttestations={confirmed.map((attestation) => ({
          ...attestation,
          decision: "rejected" as const,
        }))}
        selectedFindingId={manualFinding.findingId}
        findings={[manualFinding]}
        sources={[manualSource]}
        parsedUnits={[manualUnit]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看校验详情" }));
    expect(screen.getAllByText("人工否决")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "关闭校验详情" }));

    rerender(
      <EvidencePanel
        atomicRequirements={[requirement]}
        ruleReviewAttestations={[...confirmed, { ...confirmed[0], reason: "" }]}
        selectedFindingId={manualFinding.findingId}
        findings={[manualFinding]}
        sources={[manualSource]}
        parsedUnits={[manualUnit]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看校验详情" }));
    expect(screen.getByText("确认记录完整性失败")).toBeVisible();
    expect(
      screen.getByText(/人工确认记录重复、陈旧、冲突或格式无效/u),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭校验详情" }));

    rerender(
      <EvidencePanel
        atomicRequirements={[requirement]}
        ruleReviewAttestations={confirmed}
        selectedFindingId={manualFinding.findingId}
        findings={[{ ...manualFinding, sourceAnchors: [] }]}
        sources={[manualSource]}
        parsedUnits={[manualUnit]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看校验详情" }));
    expect(screen.getAllByText("校验失败").length).toBeGreaterThan(0);
    expect(screen.queryByText("人工已确认")).not.toBeInTheDocument();
  });

  test("never presents an asserted locator when it conflicts with parsed evidence", () => {
    const conflicting: Finding = {
      ...findings[0],
      sourceAnchors: [
        {
          ...findings[0].sourceAnchors[0],
          page: 99,
          article: "第九十九条",
          paragraphIndex: 8,
        },
      ],
    };
    render(
      <EvidencePanel
        selectedFindingId="F1"
        findings={[conflicting]}
        sources={sources}
        parsedUnits={parsedUnits}
      />,
    );

    expect(screen.getByText("定位未验证/不可用")).toBeVisible();
    expect(screen.queryByText("第99页")).not.toBeInTheDocument();
    expect(screen.queryByText("第九十九条")).not.toBeInTheDocument();
    expect(screen.queryByText("第9段")).not.toBeInTheDocument();
  });

  test("focuses, contains, escapes, and restores focus for validation details", async () => {
    const user = userEvent.setup();
    render(
      <EvidencePanel
        selectedFindingId="F1"
        findings={findings}
        sources={sources}
        parsedUnits={parsedUnits}
      />,
    );
    const trigger = screen.getByRole("button", { name: "查看校验详情" });

    await user.click(trigger);
    const close = screen.getByRole("button", { name: "关闭校验详情" });
    expect(close).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("handles a missing or deleted source without crashing", () => {
    render(
      <EvidencePanel
        selectedFindingId="F1"
        findings={findings}
        sources={[]}
        parsedUnits={[]}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("来源已删除或不可用");
    expect(screen.getByRole("button", { name: "查看校验详情" })).toBeEnabled();
  });

  test("renders an untrusted quote as text and never as executable HTML", () => {
    const onError = vi.fn();
    const malicious = '<img src=x onerror="window.__xss=true">不得执行';
    window.addEventListener("error", onError);
    const maliciousFinding: Finding = {
      ...findings[0],
      findingId: "XSS",
      statement: malicious,
      sourceAnchors: [{ ...findings[0].sourceAnchors[0], quote: malicious }],
    };
    const maliciousUnit: ParsedSourceUnit = {
      ...parsedUnits[0],
      text: malicious,
    };

    const { container } = render(
      <EvidencePanel
        selectedFindingId="XSS"
        findings={[maliciousFinding]}
        sources={[{ ...sources[0], content: malicious }]}
        parsedUnits={[maliciousUnit]}
      />,
    );

    expect(screen.getByText(malicious)).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    window.removeEventListener("error", onError);
  });

  test("shows a safe empty state when the selected finding disappears", () => {
    render(
      <EvidencePanel
        selectedFindingId="DELETED"
        findings={findings}
        sources={sources}
        parsedUnits={parsedUnits}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "当前结论已删除或不存在",
    );
  });
});
