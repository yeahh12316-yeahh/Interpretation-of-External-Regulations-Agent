import type { ClaimType, Finding, ReviewStatus } from "../../domain/finding";
import type { SourceAnchor, SourceType } from "../../domain/source";
import type { WorkflowSession } from "../../app/workflow-store";
import {
  canFinalizeSession,
  hasAuthoritativeParsingEvidence,
  reviewSnapshotHash,
} from "../evidence/calculate-quality";
import { stableValue } from "../evidence/evidence-hash";
import { resolveValidationResults } from "../evidence/review-attestation";
import {
  createSourceIndex,
  validateFinding,
} from "../evidence/validate-finding";

export type ReportType = "full_report" | "quick_commentary";
export type ReportReviewStatus = "human_finalized" | "ai_draft";

export interface ReportEvidence {
  readonly sourceId: string;
  readonly sourceType: SourceType;
  readonly sourceLabel: "监管原文" | "官方解读";
  readonly sourceTitle: string;
  readonly page: number | null;
  readonly article: string | null;
  readonly paragraphIndex: number;
  readonly quote: string;
}

export interface ReportRevision {
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly reason: string;
}

export interface ReportItem {
  readonly itemId: string;
  readonly findingId: string;
  readonly text: string;
  readonly claimType: ClaimType;
  readonly claimLabel: "监管原文" | "官方解读" | "AI推导" | "人工判断";
  readonly reviewStatus: ReviewStatus;
  readonly evidence: readonly ReportEvidence[];
  readonly revisions: readonly ReportRevision[];
}

export interface ReportSection {
  readonly key: string;
  readonly title: string;
  readonly items: readonly ReportItem[];
}

export interface ReportSource {
  readonly sourceId: string;
  readonly sourceType: SourceType;
  readonly sourceLabel: "监管原文" | "官方解读";
  readonly title: string;
}

export interface ReportModel {
  readonly reportType: ReportType;
  readonly title: "外规解读报告" | "新规快评";
  readonly projectId: string;
  readonly projectName: string;
  readonly projectVersion: string;
  readonly generatedAt: string;
  readonly reviewStatus: ReportReviewStatus;
  readonly reviewStatusLabel: "人工定稿" | "AI草稿";
  readonly watermark: "AI草稿，未经人工复核" | null;
  readonly authoritativeParsing: boolean;
  readonly sources: readonly ReportSource[];
  readonly sections: readonly ReportSection[];
}

export interface ReportBuildOptions {
  readonly generatedAt?: string;
}

const sourceLabel = (sourceType: SourceType) =>
  sourceType === "regulatory_text" ? "监管原文" : "官方解读";

const claimLabel = (claimType: ClaimType): ReportItem["claimLabel"] => {
  if (claimType === "regulatory_fact") return "监管原文";
  if (claimType === "official_explanation") return "官方解读";
  if (claimType === "human_judgment") return "人工判断";
  return "AI推导";
};

const containsCredentialMaterial = (finding: Finding): boolean =>
  [
    finding.statement,
    ...finding.sourceAnchors.map(({ quote }) => quote),
    ...finding.revisionRecords.map(({ changeSummary }) => changeSummary),
  ].some((value) =>
    /(?:\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b|Bearer\s+\S+|api[_ -]?key\s*[:=]\s*\S+|session[-_ ]?secret|credential\s*[:=])/iu.test(
      value,
    ),
  );

const isControlledCurrentFinding = (
  finding: Finding,
  session: WorkflowSession,
): boolean => {
  if (finding.reviewStatus === "unreviewed") return true;
  if (finding.claimType === "human_judgment") {
    return session.reviewActions.some(
      (action) =>
        action.action === "add_human" &&
        action.findingId === finding.findingId &&
        action.afterHash === reviewSnapshotHash(finding) &&
        stableValue(action.afterSnapshot) === stableValue(finding),
    );
  }
  if (finding.reviewStatus === "modified") {
    const lastAudit = session.reviewAudits
      .filter(({ findingId }) => findingId === finding.findingId)
      .at(-1);
    return Boolean(
      lastAudit &&
      lastAudit.afterHash === reviewSnapshotHash(finding) &&
      stableValue(lastAudit.afterSnapshot) === stableValue(finding),
    );
  }
  return session.reviewActions.some(
    (action) =>
      action.action === "confirm" &&
      action.findingId === finding.findingId &&
      action.afterHash === reviewSnapshotHash(finding) &&
      stableValue(action.afterSnapshot) === stableValue(finding),
  );
};

export interface ReportContext {
  readonly session: WorkflowSession;
  readonly eligibleFindings: readonly Finding[];
  readonly itemByFindingId: ReadonlyMap<string, ReportItem>;
  readonly base: Omit<ReportModel, "reportType" | "title" | "sections">;
}

export const createReportContext = (
  session: WorkflowSession,
  options: ReportBuildOptions = {},
): ReportContext => {
  const authoritativeParsing = hasAuthoritativeParsingEvidence(session);
  const index = createSourceIndex({
    sources: session.project.sourceUnits,
    parsedUnits: session.parseResults.flatMap(({ units }) => units),
    findings: session.project.findings,
    officialPrimarySourceIds: session.officialPrimarySourceIds,
    atomicRequirements: session.atomicRequirements,
  });
  const eligibleFindings = authoritativeParsing
    ? session.project.findings.filter((finding) => {
        if (
          finding.reviewStatus === "deleted" ||
          finding.claimType === "pending_confirmation" ||
          containsCredentialMaterial(finding) ||
          !isControlledCurrentFinding(finding, session)
        )
          return false;
        const resolved = resolveValidationResults(
          finding,
          validateFinding(finding, index),
          session.atomicRequirements,
          session.ruleReviewAttestations,
        );
        return (
          resolved.length > 0 &&
          resolved.every(({ effectivePassed }) => effectivePassed)
        );
      })
    : [];
  const sourceById = new Map(
    session.project.sourceUnits.map((source) => [source.sourceId, source]),
  );
  const itemByFindingId = new Map(
    eligibleFindings.map((finding): [string, ReportItem] => [
      finding.findingId,
      {
        itemId: `finding:${finding.findingId}`,
        findingId: finding.findingId,
        text: finding.statement,
        claimType: finding.claimType,
        claimLabel: claimLabel(finding.claimType),
        reviewStatus: finding.reviewStatus,
        evidence: finding.sourceAnchors.map((anchor: SourceAnchor) => {
          const source = sourceById.get(anchor.sourceId);
          return {
            ...anchor,
            sourceLabel: sourceLabel(anchor.sourceType),
            sourceTitle: source?.title ?? anchor.sourceId,
          };
        }),
        revisions: finding.revisionRecords.map((revision) => ({
          reviewer: revision.revisedBy,
          reviewedAt: revision.revisedAt,
          reason: revision.changeSummary,
        })),
      },
    ]),
  );
  const finalized = canFinalizeSession(session);
  return {
    session,
    eligibleFindings,
    itemByFindingId,
    base: {
      projectId: session.project.projectId,
      projectName: session.project.projectName,
      projectVersion:
        session.analysisVersions.at(-1)?.versionId ?? `R${session.revision}`,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      reviewStatus: finalized ? "human_finalized" : "ai_draft",
      reviewStatusLabel: finalized ? "人工定稿" : "AI草稿",
      watermark: finalized ? null : "AI草稿，未经人工复核",
      authoritativeParsing,
      sources: session.project.sourceUnits.map((source) => ({
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        sourceLabel: sourceLabel(source.sourceType),
        title: source.title,
      })),
    },
  };
};

export const itemsMatching = (
  context: ReportContext,
  predicate: (finding: Finding) => boolean,
  limit?: number,
): readonly ReportItem[] => {
  const items = context.eligibleFindings
    .filter(predicate)
    .map((finding) => context.itemByFindingId.get(finding.findingId)!)
    .filter(Boolean);
  return limit === undefined ? items : items.slice(0, limit);
};
