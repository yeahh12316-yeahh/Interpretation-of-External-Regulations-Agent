import { describe, expect, test } from 'vitest';

import { FindingSchema, ProjectSchema } from './schemas';

const regulatoryAnchor = {
  sourceId: 'SRC-REG-1',
  sourceType: 'regulatory_text',
  page: 1,
  article: '第一条',
  paragraphIndex: 0,
  quote: '金融机构应当建立相关制度。',
};

describe('FindingSchema', () => {
  test('rejects a regulatory fact without a regulatory-text anchor', () => {
    expect(() =>
      FindingSchema.parse({
        findingId: 'F1',
        category: '治理',
        statement: '应建立制度',
        claimType: 'regulatory_fact',
        sourceAnchors: [],
        inferenceParents: [],
        reviewStatus: 'unreviewed',
        requiredReview: false,
      }),
    ).toThrow();
  });

  test('requires an official interpretation anchor for an official explanation', () => {
    expect(() =>
      FindingSchema.parse({
        findingId: 'F2',
        category: '解读',
        statement: '监管部门明确了执行口径',
        claimType: 'official_explanation',
        sourceAnchors: [regulatoryAnchor],
        inferenceParents: [],
        reviewStatus: 'unreviewed',
        requiredReview: false,
      }),
    ).toThrow();
  });

  test('requires parent findings for an AI inference', () => {
    expect(() =>
      FindingSchema.parse({
        findingId: 'F3',
        category: '影响分析',
        statement: '建议建立制度映射台账',
        claimType: 'ai_inference',
        sourceAnchors: [],
        inferenceParents: [],
        reviewStatus: 'unreviewed',
        requiredReview: false,
      }),
    ).toThrow();
  });

  test('requires a revision record for human judgment', () => {
    expect(() =>
      FindingSchema.parse({
        findingId: 'F4',
        category: '人工判断',
        statement: '建议优先安排制度修订',
        claimType: 'human_judgment',
        sourceAnchors: [],
        inferenceParents: [],
        reviewStatus: 'confirmed',
        requiredReview: true,
      }),
    ).toThrow();
  });
});

describe('ProjectSchema', () => {
  test('rejects API keys from domain persistence', () => {
    expect(() =>
      ProjectSchema.parse({
        projectId: 'P1',
        projectName: '外规解读',
        workflowStep: 'intake',
        sourceUnits: [],
        parsingCompleted: false,
        findings: [],
        qualityMetrics: { qualityGatePassed: false },
        apiKey: 'sk-not-allowed',
      }),
    ).toThrow();
  });
});
