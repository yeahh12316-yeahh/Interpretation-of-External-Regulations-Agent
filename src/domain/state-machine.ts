import type { Project, WorkflowStep } from './project';

export type TransitionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

const hasRegulatoryFile = (project: Project) =>
  project.sourceUnits.some((source) => source.sourceType === 'regulatory_text');

const hasAnalysisResults = (project: Project) => project.findings.length > 0;

const hasCompletedRequiredReviews = (project: Project) =>
  project.findings
    .filter((finding) => finding.requiredReview)
    .every(
      (finding) => finding.reviewStatus === 'confirmed' || finding.reviewStatus === 'modified',
    );

/**
 * The sole workflow gate for both programmatic transitions and direct UI navigation.
 */
export function canTransition(project: Project, nextStep: WorkflowStep): TransitionResult {
  if (nextStep === 'intake') {
    return { allowed: true };
  }

  if (nextStep === 'parsing') {
    return hasRegulatoryFile(project)
      ? { allowed: true }
      : { allowed: false, reason: '请先上传监管文件' };
  }

  if (nextStep === 'analysis') {
    return project.parsingCompleted
      ? { allowed: true }
      : { allowed: false, reason: '请先完成文件解析' };
  }

  if (nextStep === 'review') {
    return hasAnalysisResults(project)
      ? { allowed: true }
      : { allowed: false, reason: '请先完成分析' };
  }

  if (!hasAnalysisResults(project)) {
    return { allowed: false, reason: '请先完成分析' };
  }

  if (!hasCompletedRequiredReviews(project)) {
    return { allowed: false, reason: '请先完成必审事项复核' };
  }

  return project.qualityMetrics.qualityGatePassed
    ? { allowed: true }
    : { allowed: false, reason: '请先通过质量门槛' };
}
