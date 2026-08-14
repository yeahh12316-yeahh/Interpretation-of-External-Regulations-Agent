import type { Finding } from './finding';
import type { QualityMetrics } from './quality';
import type { SourceUnit } from './source';

export type WorkflowStep = 'intake' | 'parsing' | 'analysis' | 'review' | 'report';

export interface Project {
  projectId: string;
  projectName: string;
  workflowStep: WorkflowStep;
  sourceUnits: SourceUnit[];
  parsingCompleted: boolean;
  findings: Finding[];
  qualityMetrics: QualityMetrics;
}
