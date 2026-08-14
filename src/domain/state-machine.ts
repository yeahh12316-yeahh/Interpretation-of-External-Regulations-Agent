import type { Project, WorkflowStep } from "./project";
import { hasPassedQualityGate } from "./quality";

export type TransitionResult =
  { allowed: true } | { allowed: false; reason: string };

export interface TransitionContext {
  /** Authoritative Task 4 parse/OCR outcome. Omit only for legacy domain callers. */
  parsingReady?: boolean;
  /** Task 8 evidence and current-bound manual-attestation outcome. */
  evidenceReady?: boolean;
  reanalysisPending?: boolean;
}

const hasRegulatoryFile = (project: Project) =>
  project.sourceUnits.some((source) => source.sourceType === "regulatory_text");

const hasAnalysisResults = (project: Project) => project.findings.length > 0;

const hasCompletedRequiredReviews = (project: Project) =>
  project.findings
    .filter((finding) => finding.requiredReview)
    .every(
      (finding) =>
        finding.reviewStatus === "confirmed" ||
        finding.reviewStatus === "modified" ||
        (finding.reviewStatus === "deleted" &&
          finding.revisionRecords.length > 0),
    );

/**
 * The sole workflow gate for both programmatic transitions and direct UI navigation.
 */
export function canTransition(
  project: Project,
  nextStep: WorkflowStep,
  context: TransitionContext = {},
): TransitionResult {
  if (nextStep === "intake") {
    return { allowed: true };
  }

  if (nextStep === "parsing") {
    return hasRegulatoryFile(project)
      ? { allowed: true }
      : { allowed: false, reason: "请先上传监管文件" };
  }

  if (nextStep === "analysis") {
    if (!project.parsingCompleted) {
      return { allowed: false, reason: "请先完成文件解析" };
    }
    if (context.parsingReady === false) {
      return { allowed: false, reason: "解析或 OCR 质量未通过" };
    }
    return hasRegulatoryFile(project)
      ? { allowed: true }
      : { allowed: false, reason: "请先上传监管文件" };
  }

  if (nextStep === "review") {
    if (context.reanalysisPending) {
      return { allowed: false, reason: "定向重分析尚未完成" };
    }
    if (!hasRegulatoryFile(project)) {
      return { allowed: false, reason: "请先上传监管文件" };
    }
    if (!project.parsingCompleted) {
      return { allowed: false, reason: "请先完成文件解析" };
    }
    if (context.parsingReady === false) {
      return { allowed: false, reason: "解析或 OCR 质量未通过" };
    }
    return hasAnalysisResults(project)
      ? { allowed: true }
      : { allowed: false, reason: "请先完成分析" };
  }

  if (!hasRegulatoryFile(project)) {
    return { allowed: false, reason: "请先上传监管文件" };
  }

  if (context.reanalysisPending) {
    return { allowed: false, reason: "定向重分析尚未完成" };
  }

  if (!project.parsingCompleted) {
    return { allowed: false, reason: "请先完成文件解析" };
  }

  if (!hasAnalysisResults(project)) {
    return { allowed: false, reason: "请先完成分析" };
  }

  if (!hasCompletedRequiredReviews(project)) {
    return { allowed: false, reason: "请先完成必审事项复核" };
  }

  if (context.evidenceReady === false) {
    return { allowed: false, reason: "证据校验或人工规则复核未通过" };
  }

  return hasPassedQualityGate(project.qualityMetrics)
    ? { allowed: true }
    : { allowed: false, reason: "请先通过质量门槛" };
}
