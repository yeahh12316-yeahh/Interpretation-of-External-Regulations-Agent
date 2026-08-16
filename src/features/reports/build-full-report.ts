import type { Finding } from "../../domain/finding";
import {
  humanJudgmentCategoryForPurpose,
  isClosedInstitutionImpactFinding,
} from "../../domain/closed-categories";
import {
  createReportContext,
  IMPACT_DIMENSIONS,
  itemsMatching,
  type ReportBuildOptions,
  type ReportModel,
  type ReportSection,
} from "./report-model";
import type { WorkflowSession } from "../../app/workflow-store";

const has = (finding: Finding, token: string) =>
  finding.category.includes(token);

export const buildFullReport = (
  session: WorkflowSession,
  options: ReportBuildOptions = {},
): ReportModel => {
  const context = createReportContext(session, options);
  const impactItems = itemsMatching(context, isClosedInstitutionImpactFinding);
  const sections: ReportSection[] = [
    {
      key: "executive_summary",
      title: "管理摘要",
      items: itemsMatching(
        context,
        (finding) =>
          has(finding, "core_requirement") ||
          has(finding, "prohibition") ||
          has(finding, "effective_date"),
        3,
      ),
    },
    {
      key: "document_information",
      title: "文件基本信息、发文机关、文号、发布日期及效力待复核提示",
      items: itemsMatching(context, (finding) =>
        has(finding, "document_identity"),
      ),
    },
    {
      key: "regulatory_background",
      title: "监管背景与政策目标",
      items: itemsMatching(
        context,
        (finding) =>
          has(finding, "regulatory_context") ||
          has(finding, "official_context"),
      ),
    },
    {
      key: "applicable_scope",
      title: "适用对象和适用范围",
      items: itemsMatching(context, (finding) => has(finding, "applicability")),
    },
    {
      key: "core_requirements",
      title: "核心要求逐项解读",
      items: itemsMatching(
        context,
        (finding) =>
          has(finding, "core_requirement") ||
          finding.category === "atomic_requirement",
      ),
    },
    {
      key: "red_lines",
      title: "禁止事项和监管红线",
      items: itemsMatching(context, (finding) => has(finding, "prohibition")),
    },
    {
      key: "dates_and_transition",
      title: "生效日期、实施安排与过渡期",
      items: itemsMatching(
        context,
        (finding) =>
          finding.category === "key_matter:effective_date" ||
          finding.category === "key_matter:implementation_arrangement" ||
          finding.category === "key_matter:transition_period" ||
          finding.category === "document_identity:effective_date" ||
          finding.category === "document_identity:deadline",
      ),
    },
    {
      key: "institution_impact",
      title: "对金融机构的主要影响",
      items: impactItems,
      groups: IMPACT_DIMENSIONS.map(({ dimension, title }) => ({
        dimension,
        title,
        items: impactItems.filter((item) => item.dimension === dimension),
      })),
    },
    {
      key: "recommended_actions",
      title: "建议行动及优先级",
      items: itemsMatching(
        context,
        (finding) =>
          finding.category ===
          humanJudgmentCategoryForPurpose("recommended_action"),
      ),
    },
    {
      key: "pending_and_risks",
      title: "待确认事项和风险提示",
      items: [],
    },
    {
      key: "evidence_appendix",
      title: "原文证据索引与人工修订留痕",
      items: itemsMatching(context, () => true),
    },
  ];
  return {
    ...context.base,
    reportType: "full_report",
    title: "外规解读报告",
    sections,
  };
};
