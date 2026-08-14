import type { Finding } from '../../domain/finding';
import type { Project } from '../../domain/project';
import type { SourceUnit } from '../../domain/source';
import { ProjectSchema } from '../../domain/schemas';
import { projectRepository } from './project-repository';

const BACKUP_VERSION = 1;

const allowListedSource = (source: SourceUnit): SourceUnit => ({
  sourceId: source.sourceId,
  sourceType: source.sourceType,
  title: source.title,
  content: source.content,
});

const allowListedFinding = (finding: Finding): Finding => ({
  findingId: finding.findingId,
  category: finding.category,
  statement: finding.statement,
  claimType: finding.claimType,
  sourceAnchors: finding.sourceAnchors.map((anchor) => ({
    sourceId: anchor.sourceId,
    sourceType: anchor.sourceType,
    page: anchor.page,
    article: anchor.article,
    paragraphIndex: anchor.paragraphIndex,
    quote: anchor.quote,
  })),
  inferenceParents: Array.from(finding.inferenceParents),
  reviewStatus: finding.reviewStatus,
  requiredReview: finding.requiredReview,
  revisionRecords: finding.revisionRecords.map((revision) => ({
    revisedBy: revision.revisedBy,
    revisedAt: revision.revisedAt,
    changeSummary: revision.changeSummary,
  })),
});

const allowListedProject = (project: Project): Project => ({
  projectId: project.projectId,
  projectName: project.projectName,
  workflowStep: project.workflowStep,
  sourceUnits: project.sourceUnits.map(allowListedSource),
  parsingCompleted: project.parsingCompleted,
  findings: project.findings.map(allowListedFinding),
  qualityMetrics: {
    factCitationCoverage: project.qualityMetrics.factCitationCoverage,
    citationReverseCheckRate: project.qualityMetrics.citationReverseCheckRate,
    unsupportedFindingCount: project.qualityMetrics.unsupportedFindingCount,
    inferenceMarkingRate: project.qualityMetrics.inferenceMarkingRate,
    requiredReviewCompletionRate: project.qualityMetrics.requiredReviewCompletionRate,
  },
});

export const exportProject = async (projectId: string): Promise<string> => {
  const stored = await projectRepository.load(projectId);
  if (!stored) {
    throw new Error('找不到要导出的项目');
  }

  return JSON.stringify({
    version: BACKUP_VERSION,
    project: allowListedProject(stored),
  });
};

export const importProject = async (json: string): Promise<Project> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('备份文件不是有效 JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('备份文件格式无效');
  }

  const backup = parsed as Record<string, unknown>;
  if (backup.version !== BACKUP_VERSION) {
    throw new Error('不支持的备份版本');
  }

  const envelopeKeys = Object.keys(backup);
  if (
    envelopeKeys.length !== 2 ||
    envelopeKeys.some((key) => key !== 'version' && key !== 'project')
  ) {
    throw new Error('备份文件格式无效');
  }

  const result = ProjectSchema.safeParse(backup.project);
  if (!result.success) {
    throw new Error('备份项目数据无效');
  }

  await projectRepository.save(result.data);
  return result.data;
};
