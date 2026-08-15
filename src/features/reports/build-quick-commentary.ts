import type { Finding } from "../../domain/finding";
import type { WorkflowSession } from "../../app/workflow-store";
import {
  createReportContext,
  itemsMatching,
  type ReportBuildOptions,
  type ReportModel,
  type ReportSection,
} from "./report-model";

const has = (finding: Finding, token: string) =>
  finding.category.includes(token);

export const buildQuickCommentary = (
  session: WorkflowSession,
  options: ReportBuildOptions = {},
): ReportModel => {
  const context = createReportContext(session, options);
  const topChanges = itemsMatching(
    context,
    (finding) =>
      has(finding, "key_matter") ||
      has(finding, "core_requirement") ||
      has(finding, "atomic_requirement") ||
      has(finding, "applicability"),
    5,
  );
  const sections: ReportSection[] = [
    {
      key: "one_line",
      title: "一句话结论",
      items: topChanges.slice(0, 1),
    },
    {
      key: "why_it_matters",
      title: "新规为什么重要",
      items: itemsMatching(
        context,
        (finding) =>
          has(finding, "regulatory_context") ||
          has(finding, "official_context"),
        2,
      ),
    },
    {
      key: "top_changes",
      title: "最值得关注的三至五项变化",
      items: topChanges,
    },
    {
      key: "red_lines",
      title: "禁止事项和不可触碰红线",
      items: itemsMatching(
        context,
        (finding) => has(finding, "prohibition"),
        3,
      ),
    },
    {
      key: "dates",
      title: "关键日期、过渡期和紧迫程度",
      items: itemsMatching(
        context,
        (finding) =>
          has(finding, "effective_date") || has(finding, "transition"),
        3,
      ),
    },
    {
      key: "affected_scope",
      title: "主要受影响机构、业务和部门",
      items: itemsMatching(
        context,
        (finding) =>
          has(finding, "applicability") || has(finding, "institution_impact"),
        3,
      ),
    },
    {
      key: "actions",
      title: "近期行动清单",
      items: itemsMatching(
        context,
        (finding) => has(finding, "recommended_action"),
        5,
      ),
    },
    {
      key: "limitations",
      title: "重要限制、待确认事项和来源说明",
      items: itemsMatching(
        context,
        (finding) => finding.claimType === "official_explanation",
        2,
      ),
    },
  ];
  return {
    ...context.base,
    reportType: "quick_commentary",
    title: "新规快评",
    sections,
  };
};
