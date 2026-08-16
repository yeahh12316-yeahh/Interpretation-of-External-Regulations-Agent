import { buildAnchors } from "../../parsing/build-anchors";
import {
  addHumanJudgment,
  createAnalysisVersion,
} from "../../review/review-actions";
import {
  createEmptyWorkflowSession,
  sealWorkflowSession,
  type WorkflowSession,
} from "../../../app/workflow-store";
import type { Finding } from "../../../domain/finding";

const regulatoryClauses = [
  "《监管办法》",
  "监管部门发布本办法规范机构管理",
  "机构应建立管理制度",
  "机构不得违规处理客户数据",
  "本办法自2026年9月1日起施行",
  "机构应在三个月内完成过渡安排",
  "本办法适用于境内金融机构",
];

const regulatoryUnitTexts = regulatoryClauses.map(
  (text, paragraphIndex) => `第${paragraphIndex + 1}条 ${text}`,
);

const finding = (
  findingId: string,
  category: string,
  statement: string,
  paragraphIndex: number,
  overrides: Partial<Finding> = {},
): Finding => ({
  findingId,
  category,
  statement,
  claimType: "regulatory_fact",
  sourceAnchors: [
    {
      sourceId: "REG-A",
      sourceType: "regulatory_text",
      page: null,
      article: `第${paragraphIndex + 1}条`,
      paragraphIndex,
      quote: statement,
    },
  ],
  inferenceParents: [],
  reviewStatus: "unreviewed",
  requiredReview: false,
  revisionRecords: [],
  ...overrides,
});

export const reviewedReportSession = (): WorkflowSession => {
  const base = createEmptyWorkflowSession("REPORT-P1", "外规报告 QA 项目");
  const regulatorySource = {
    sourceId: "REG-A",
    sourceType: "regulatory_text" as const,
    title: "监管办法",
    content: regulatoryUnitTexts.join("\n\n"),
  };
  const officialSource = {
    sourceId: "OFF-A",
    sourceType: "official_interpretation" as const,
    title: "监管办法官方解读",
    content: "第一条 官方解读说明本办法旨在完善机构治理",
  };
  const regulatoryUnits = regulatoryUnitTexts.map((text, paragraphIndex) => ({
    unitId: `REG-U${paragraphIndex + 1}`,
    sourceId: "REG-A",
    sourceType: "regulatory_text" as const,
    page: null,
    article: `第${paragraphIndex + 1}条`,
    paragraphIndex,
    text,
    extractionMethod: "plain_text" as const,
    confidence: 1,
  }));
  const officialUnit = {
    unitId: "OFF-U1",
    sourceId: "OFF-A",
    sourceType: "official_interpretation" as const,
    page: null,
    article: "第一条",
    paragraphIndex: 0,
    text: officialSource.content,
    extractionMethod: "plain_text" as const,
    confidence: 1,
  };
  const initialFindings: Finding[] = [
    finding(
      "F-TITLE",
      "document_identity:document_title",
      regulatoryClauses[0],
      0,
    ),
    finding(
      "F-BG",
      "regulatory_context:policy_background",
      regulatoryClauses[1],
      1,
    ),
    finding("F-CORE", "key_matter:core_requirement", regulatoryClauses[2], 2),
    finding("F-RED", "key_matter:prohibition", regulatoryClauses[3], 3),
    finding("F-DATE", "key_matter:effective_date", regulatoryClauses[4], 4),
    finding(
      "F-TRANSITION",
      "key_matter:transition_period",
      regulatoryClauses[5],
      5,
    ),
    finding("F-SCOPE", "key_matter:applicability", regulatoryClauses[6], 6),
    finding(
      "F-IMPACT",
      "institution_impact:governance",
      regulatoryClauses[2],
      2,
      {
        claimType: "ai_inference",
        inferenceParents: ["F-CORE"],
      },
    ),
    {
      findingId: "F-OFFICIAL",
      category: "official_context:policy_background",
      statement: "官方解读说明本办法旨在完善机构治理",
      claimType: "official_explanation",
      sourceAnchors: [
        {
          sourceId: "OFF-A",
          sourceType: "official_interpretation",
          page: null,
          article: "第一条",
          paragraphIndex: 0,
          quote: "官方解读说明本办法旨在完善机构治理",
        },
      ],
      inferenceParents: ["F-BG"],
      reviewStatus: "unreviewed",
      requiredReview: false,
      revisionRecords: [],
    },
  ];
  const session: WorkflowSession = sealWorkflowSession({
    ...base,
    project: {
      ...base.project,
      workflowStep: "report",
      sourceUnits: [regulatorySource, officialSource],
      parsingCompleted: true,
      findings: initialFindings,
      qualityMetrics: {
        factCitationCoverage: 1,
        citationReverseCheckRate: 1,
        unsupportedFindingCount: 0,
        inferenceMarkingRate: 1,
        requiredReviewCompletionRate: 1,
      },
    },
    parseResults: [
      {
        fileHash: "a".repeat(64),
        source: regulatorySource,
        pageCount: null,
        successfulPages: [],
        failedPages: [],
        units: regulatoryUnits,
        ocrReviews: [],
        anchors: buildAnchors(regulatoryUnits),
        quality: {
          totalCharacters: regulatorySource.content.length,
          parsedUnitCount: regulatoryUnits.length,
          failedPageCount: 0,
          lowTextPages: [],
          extractionCoverage: 1,
          ocrFailedPages: [],
          finalizationBlocked: false,
        },
      },
      {
        fileHash: "b".repeat(64),
        source: officialSource,
        pageCount: null,
        successfulPages: [],
        failedPages: [],
        units: [officialUnit],
        ocrReviews: [],
        anchors: buildAnchors([officialUnit]),
        quality: {
          totalCharacters: officialSource.content.length,
          parsedUnitCount: 1,
          failedPageCount: 0,
          lowTextPages: [],
          extractionCoverage: 1,
          ocrFailedPages: [],
          finalizationBlocked: false,
        },
      },
    ],
    parsedUnits: [...regulatoryUnits, officialUnit],
    officialPrimarySourceIds: { "OFF-A": ["REG-A"] },
    analysisVersions: [
      createAnalysisVersion({
        versionId: "V1",
        projectId: base.project.projectId,
        parentVersionHash: null,
        createdAt: "2026-08-16T01:00:00.000Z",
        reason: "报告 QA 基线",
        findings: initialFindings,
        atomicRequirements: [],
        inferenceRelationships: [
          {
            relationshipId: "REL-IMPACT",
            fromFindingIds: ["F-CORE"],
            toFindingId: "F-IMPACT",
            relationshipType: "potential",
            sourceAnchors: initialFindings.find(
              ({ findingId }) => findingId === "F-CORE",
            )!.sourceAnchors,
            rationale: "结构化测试关系",
            confidence: 1,
            manualVerificationRequired: false,
          },
        ],
        conflicts: [],
        replacedFindingIds: initialFindings.map(({ findingId }) => findingId),
        sourceIds: ["REG-A", "OFF-A"],
        scope: [
          "document_identity",
          "atomic_clauses",
          "key_matters",
          "institution_impact",
        ],
        reanalysisProvenance: null,
      }),
    ],
    lastSavedAt: "2026-08-16T01:30:00.000Z",
  });
  return sealWorkflowSession(
    addHumanJudgment(session, {
      findingId: "H-ACTION",
      purpose: "recommended_action",
      statement: "人工判断：优先完善管理制度",
      anchor: initialFindings.find(({ findingId }) => findingId === "F-CORE")!
        .sourceAnchors[0],
      reviewer: "合规复核人",
      reason: "结合原文确定优先行动",
      reviewedAt: "2026-08-16T02:00:00.000Z",
    }) as WorkflowSession,
  );
};

export const draftReportSession = (): WorkflowSession => {
  const session = reviewedReportSession();
  return sealWorkflowSession({
    ...session,
    project: {
      ...session.project,
      findings: session.project.findings.map((item) =>
        item.findingId === "F-CORE"
          ? { ...item, requiredReview: true, reviewStatus: "unreviewed" }
          : item,
      ),
    },
  });
};
