import type { Project, WorkflowStep } from './project';
import { hasPassedQualityGate } from './quality';

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
      (finding) =>
        finding.reviewStatus === 'confirmed' ||
        finding.reviewStatus === 'modified' ||
        (finding.reviewStatus === 'deleted' && finding.revisionRecords.length > 0),
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
    if (!project.parsingCompleted) {
      return { allowed: false, reason: '请先完成文件解析' };
    }
    return hasRegulatoryFile(project) ? { allowed: true } : { allowed: false, reason: '请先上传监管文件' };
  }

  if (nextStep === 'review') {
    if (!hasRegulatoryFile(project)) {
      return { allowed: false, reason: '请先上传监管文件' };
    }
    if (!project.parsingCompleted) {
      return { allowed: false, reason: '请先完成文件解析' };
    }
    return hasAnalysisResults(project) ? { allowed: true } : { allowed: false, reason: '请先完成分析' };
  }

  if (!hasRegulatoryFile(project)) {
    return { allowed: false, reason: '请先上传监管文件' };
  }

  if (!project.parsingCompleted) {
    return { allowed: false, reason: '请先完成文件解析' };
  }

  if (!hasAnalysisResults(project)) {
    return { allowed: false, reason: '请先完成分析' };
  }

  if (!hasCompletedRequiredReviews(project)) {
    return { allowed: false, reason: '请先完成必审事项复核' };
  }

  return hasPassedQualityGate(project.qualityMetrics)
    ? { allowed: true }
    : { allowed: false, reason: '请先通过质量门槛' };
}
