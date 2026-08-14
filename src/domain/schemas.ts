import { z } from 'zod';

import type { Finding } from './finding';
import type { Project } from './project';

const SourceTypeSchema = z.enum(['regulatory_text', 'official_interpretation']);

const SourceAnchorSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceType: SourceTypeSchema,
    page: z.number().int().positive().nullable(),
    article: z.string().min(1).nullable(),
    paragraphIndex: z.number().int().nonnegative(),
    quote: z.string().min(1),
  })
  .strict();

const RevisionRecordSchema = z
  .object({
    revisedBy: z.string().min(1),
    revisedAt: z.string().datetime(),
    changeSummary: z.string().min(1),
  })
  .strict();

export const FindingSchema = z
  .object({
    findingId: z.string().min(1),
    category: z.string().min(1),
    statement: z.string().min(1),
    claimType: z.enum([
      'regulatory_fact',
      'official_explanation',
      'ai_inference',
      'pending_confirmation',
      'human_judgment',
    ]),
    sourceAnchors: z.array(SourceAnchorSchema),
    inferenceParents: z.array(z.string().min(1)).default([]),
    reviewStatus: z.enum(['unreviewed', 'confirmed', 'modified', 'deleted']),
    requiredReview: z.boolean(),
    revisionRecords: z.array(RevisionRecordSchema).default([]),
  })
  .strict()
  .superRefine((finding, context) => {
    const hasAnchorType = (sourceType: 'regulatory_text' | 'official_interpretation') =>
      finding.sourceAnchors.some((anchor) => anchor.sourceType === sourceType);

    if (finding.claimType === 'regulatory_fact' && !hasAnchorType('regulatory_text')) {
      context.addIssue({
        code: 'custom',
        path: ['sourceAnchors'],
        message: '监管事实必须关联监管原文锚点',
      });
    }

    if (
      finding.claimType === 'official_explanation' &&
      !hasAnchorType('official_interpretation')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sourceAnchors'],
        message: '官方说明必须关联官方解读锚点',
      });
    }

    if (finding.claimType === 'ai_inference' && finding.inferenceParents.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['inferenceParents'],
        message: 'AI 推导必须关联父结论',
      });
    }

    if (finding.claimType === 'human_judgment' && finding.revisionRecords.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['revisionRecords'],
        message: '人工判断必须保留修订记录',
      });
    }
  });

const SourceUnitSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceType: SourceTypeSchema,
    title: z.string().min(1),
    content: z.string(),
  })
  .strict();

const QualityMetricsSchema = z
  .object({
    qualityGatePassed: z.boolean(),
    sourceAnchorCoverage: z.number().min(0).max(1).optional(),
    inferenceTraceability: z.number().min(0).max(1).optional(),
    requiredReviewCompletion: z.number().min(0).max(1).optional(),
  })
  .strict();

export const ProjectSchema = z
  .object({
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    workflowStep: z.enum(['intake', 'parsing', 'analysis', 'review', 'report']),
    sourceUnits: z.array(SourceUnitSchema),
    parsingCompleted: z.boolean(),
    findings: z.array(FindingSchema),
    qualityMetrics: QualityMetricsSchema,
  })
  .strict();

type _FindingSchemaMatchesDomain = z.infer<typeof FindingSchema> extends Finding ? true : never;
type _ProjectSchemaMatchesDomain = z.infer<typeof ProjectSchema> extends Project ? true : never;
void (undefined as unknown as _FindingSchemaMatchesDomain);
void (undefined as unknown as _ProjectSchemaMatchesDomain);
