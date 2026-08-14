import { describe, expect, test } from 'vitest';

import type { Project } from './project';
import { canTransition } from './state-machine';

const emptyProject: Project = {
  projectId: 'P1',
  projectName: '外规解读',
  workflowStep: 'intake',
  sourceUnits: [],
  parsingCompleted: false,
  findings: [],
  qualityMetrics: { qualityGatePassed: false },
};

describe('canTransition', () => {
  test('blocks analysis before file parsing is complete', () => {
    expect(canTransition(emptyProject, 'analysis')).toEqual({
      allowed: false,
      reason: '请先完成文件解析',
    });
  });

  test('requires a regulatory file before parsing', () => {
    expect(canTransition(emptyProject, 'parsing')).toEqual({
      allowed: false,
      reason: '请先上传监管文件',
    });
  });

  test('blocks review until analysis produces findings', () => {
    expect(
      canTransition(
        { ...emptyProject, parsingCompleted: true, workflowStep: 'analysis' },
        'review',
      ),
    ).toEqual({ allowed: false, reason: '请先完成分析' });
  });

  test('blocks report until required reviews are completed', () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          parsingCompleted: true,
          workflowStep: 'review',
          findings: [
            {
              findingId: 'F1',
              category: '治理',
              statement: '应建立制度',
              claimType: 'regulatory_fact',
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: 'unreviewed',
              requiredReview: true,
              revisionRecords: [],
            },
          ],
        },
        'report',
      ),
    ).toEqual({ allowed: false, reason: '请先完成必审事项复核' });
  });

  test('blocks report until the quality gate passes', () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          parsingCompleted: true,
          workflowStep: 'review',
          findings: [
            {
              findingId: 'F1',
              category: '治理',
              statement: '应建立制度',
              claimType: 'regulatory_fact',
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: 'confirmed',
              requiredReview: true,
              revisionRecords: [],
            },
          ],
        },
        'report',
      ),
    ).toEqual({ allowed: false, reason: '请先通过质量门槛' });
  });

  test('allows report when evidence review and quality gates are met', () => {
    expect(
      canTransition(
        {
          ...emptyProject,
          parsingCompleted: true,
          workflowStep: 'review',
          qualityMetrics: { qualityGatePassed: true },
          findings: [
            {
              findingId: 'F1',
              category: '治理',
              statement: '应建立制度',
              claimType: 'regulatory_fact',
              sourceAnchors: [],
              inferenceParents: [],
              reviewStatus: 'modified',
              requiredReview: true,
              revisionRecords: [],
            },
          ],
        },
        'report',
      ),
    ).toEqual({ allowed: true });
  });
});
