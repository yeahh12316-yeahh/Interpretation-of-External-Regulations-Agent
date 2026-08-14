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

const passingQualityMetrics = {
  factCitationCoverage: 1,
  citationReverseCheckRate: 1,
  unsupportedFindingCount: 0,
  inferenceMarkingRate: 1,
  requiredReviewCompletionRate: 1,
};

const regulatorySource = {
  sourceId: 'SRC-REG-1',
  sourceType: 'regulatory_text',
  title: '监管文件',
  content: '金融机构应当建立相关制度。',
};

const regulatoryFact = {
  findingId: 'F1',
  category: '治理',
  statement: '应建立制度',
  claimType: 'regulatory_fact' as const,
  sourceAnchors: [regulatoryAnchor],
  inferenceParents: [],
  reviewStatus: 'confirmed' as const,
  requiredReview: true,
  revisionRecords: [],
};

const validProject = () => ({
  projectId: 'P1',
  projectName: '外规解读',
  workflowStep: 'review' as const,
  sourceUnits: [regulatorySource],
  parsingCompleted: true,
  findings: [regulatoryFact],
  qualityMetrics: passingQualityMetrics,
});

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
  test('accepts a project with all five deterministic quality metrics', () => {
    expect(() => ProjectSchema.parse(validProject())).not.toThrow();
  });

  test('rejects API keys from domain persistence', () => {
    expect(() =>
      ProjectSchema.parse({
        projectId: 'P1',
        projectName: '外规解读',
        workflowStep: 'intake',
        sourceUnits: [],
        parsingCompleted: false,
        findings: [],
        qualityMetrics: passingQualityMetrics,
        apiKey: 'sk-not-allowed',
      }),
    ).toThrow();
  });

  test('rejects an anchor whose source ID does not exist in the project', () => {
    expect(() =>
      ProjectSchema.parse({
        ...validProject(),
        findings: [
          {
            ...regulatoryFact,
            sourceAnchors: [{ ...regulatoryAnchor, sourceId: 'SRC-MISSING' }],
          },
        ],
      }),
    ).toThrow();
  });

  test('rejects an anchor whose declared source type disagrees with its source unit', () => {
    expect(() =>
      ProjectSchema.parse({
        ...validProject(),
        findings: [
          {
            ...regulatoryFact,
            sourceAnchors: [
              { ...regulatoryAnchor, sourceType: 'official_interpretation' as const },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  test('rejects an AI inference that references a missing parent finding', () => {
    expect(() =>
      ProjectSchema.parse({
        ...validProject(),
        findings: [
          regulatoryFact,
          {
            findingId: 'F2',
            category: '影响分析',
            statement: '建议建立制度映射台账',
            claimType: 'ai_inference',
            sourceAnchors: [],
            inferenceParents: ['F-MISSING'],
            reviewStatus: 'unreviewed',
            requiredReview: false,
            revisionRecords: [],
          },
        ],
      }),
    ).toThrow();
  });

  test('rejects an AI inference that references itself or a downstream finding', () => {
    expect(() =>
      ProjectSchema.parse({
        ...validProject(),
        findings: [
          {
            findingId: 'F1',
            category: '影响分析',
            statement: '建议建立制度映射台账',
            claimType: 'ai_inference',
            sourceAnchors: [],
            inferenceParents: ['F1'],
            reviewStatus: 'unreviewed',
            requiredReview: false,
            revisionRecords: [],
          },
          regulatoryFact,
        ],
      }),
    ).toThrow();

    expect(() =>
      ProjectSchema.parse({
        ...validProject(),
        findings: [
          {
            findingId: 'F2',
            category: '影响分析',
            statement: '建议建立制度映射台账',
            claimType: 'ai_inference',
            sourceAnchors: [],
            inferenceParents: ['F1'],
            reviewStatus: 'unreviewed',
            requiredReview: false,
            revisionRecords: [],
          },
          regulatoryFact,
        ],
      }),
    ).toThrow();
  });
});
