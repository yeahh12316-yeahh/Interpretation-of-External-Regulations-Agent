import { describe, expect, it } from "vitest";

import { buildFullReport } from "./build-full-report";
import { buildQuickCommentary } from "./build-quick-commentary";
import {
  draftReportSession,
  reviewedReportSession,
} from "./__test__/report-fixture";
import { reportExportBlockReason, type ReportModel } from "./report-model";
import { addHumanJudgment } from "../review/review-actions";
import type { WorkflowSession } from "../../app/workflow-store";

it("builds distinct 11-section and exact 8-key reports from one allow-listed model", () => {
  const session = reviewedReportSession();
  const generatedAt = "2026-08-16T03:00:00.000Z";
  const full = buildFullReport(session, { generatedAt });
  const quick = buildQuickCommentary(session, { generatedAt });

  expect(full.sections).toHaveLength(11);
  expect(full.sections.map(({ key }) => key)).toEqual([
    "executive_summary",
    "document_information",
    "regulatory_background",
    "applicable_scope",
    "core_requirements",
    "red_lines",
    "dates_and_transition",
    "institution_impact",
    "recommended_actions",
    "pending_and_risks",
    "evidence_appendix",
  ]);
  expect(quick.sections.map(({ key }) => key)).toEqual([
    "one_line",
    "why_it_matters",
    "top_changes",
    "red_lines",
    "dates",
    "affected_scope",
    "actions",
    "limitations",
  ]);
  expect(
    quick.sections.find(({ key }) => key === "top_changes")?.items,
  ).toHaveLength(5);
  expect(full.sections.flatMap(({ items }) => items)).not.toEqual(
    quick.sections.flatMap(({ items }) => items),
  );
  expect(full.generatedAt).toBe(quick.generatedAt);
  expect(full.sources).toEqual(quick.sources);
});

it("excludes deleted, pending, failed and unattested material without inventing text", () => {
  const session = reviewedReportSession();
  const anchor = session.project.findings[0].sourceAnchors[0];
  session.project.findings.push(
    {
      ...session.project.findings[0],
      findingId: "DELETED",
      statement: "UNSUPPORTED_SENTENCE_DELETED",
      reviewStatus: "deleted",
    },
    {
      ...session.project.findings[0],
      findingId: "PENDING",
      statement: "UNSUPPORTED_SENTENCE_PENDING",
      claimType: "pending_confirmation",
    },
    {
      ...session.project.findings[0],
      findingId: "FAILED",
      statement: "UNSUPPORTED_SENTENCE_FAILED",
      sourceAnchors: [
        { ...anchor, paragraphIndex: 999, quote: "not in source" },
      ],
    },
  );

  const serialized = JSON.stringify(buildFullReport(session));
  expect(serialized).not.toContain("UNSUPPORTED_SENTENCE");
  expect(serialized).not.toContain("not in source");
  expect(serialized).toContain("监管原文");
  expect(serialized).toContain("官方解读");
  expect(serialized).toContain("AI推导");
  expect(serialized).toContain("人工判断");
});

it("marks a non-finalized but parse-authoritative preview as an AI draft", () => {
  const report = buildFullReport(draftReportSession(), {
    generatedAt: "2026-08-16T03:00:00.000Z",
  });
  expect(report.watermark).toBe("AI草稿，未经人工复核");
  expect(report.reviewStatus).toBe("ai_draft");
});

describe("quick commentary export cardinality", () => {
  for (const count of [0, 1, 2, 3, 5, 6]) {
    it(`${count} verified top changes ${count >= 3 && count <= 5 ? "passes" : "fails"} closed`, () => {
      const base = buildQuickCommentary(reviewedReportSession());
      const available = base.sections.flatMap(({ items }) => items);
      const topItems = Array.from({ length: count }, (_, index) => ({
        ...(available[index % Math.max(available.length, 1)] ?? {
          itemId: "placeholder",
          findingId: "placeholder",
          text: "placeholder",
          claimType: "regulatory_fact" as const,
          claimLabel: "监管原文" as const,
          reviewStatus: "unreviewed" as const,
          evidence: [],
          revisions: [],
        }),
        itemId: `top-${index}`,
      }));
      const report: ReportModel = {
        ...base,
        sections: base.sections.map((section) =>
          section.key === "top_changes"
            ? { ...section, items: topItems }
            : section,
        ),
      };
      expect(reportExportBlockReason(report) === null).toBe(
        count >= 3 && count <= 5,
      );
    });
  }

  it("does not apply quick top-change cardinality to the full report", () => {
    expect(
      reportExportBlockReason(buildFullReport(reviewedReportSession())),
    ).toBeNull();
  });
});

it("routes implementation arrangements to both exact date sections", () => {
  const session = reviewedReportSession();
  const basis = session.project.findings.find(
    ({ findingId }) => findingId === "F-TRANSITION",
  )!;
  session.project.findings.push({
    ...basis,
    findingId: "F-IMPLEMENTATION",
    category: "key_matter:implementation_arrangement",
    statement: basis.statement,
  });

  const full = buildFullReport(session);
  const quick = buildQuickCommentary(session);
  expect(
    full.sections.find(({ key }) => key === "dates_and_transition")?.items,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ findingId: "F-IMPLEMENTATION" }),
    ]),
  );
  expect(quick.sections.find(({ key }) => key === "dates")?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ findingId: "F-IMPLEMENTATION" }),
    ]),
  );
});

it("preserves a closed seven-dimension institutional-impact structure", () => {
  const report = buildFullReport(reviewedReportSession());
  const impact = report.sections.find(
    ({ key }) => key === "institution_impact",
  )!;
  expect(impact.groups?.map(({ dimension }) => dimension)).toEqual([
    "governance",
    "institution",
    "process",
    "system",
    "data",
    "people",
    "reporting",
  ]);
  expect(
    impact.groups?.find(({ dimension }) => dimension === "governance")
      ?.items[0],
  ).toMatchObject({
    category: "institution_impact:governance",
    dimension: "governance",
  });
  expect(
    impact.groups?.find(({ dimension }) => dimension === "institution")?.items,
  ).toEqual([]);
});

it("routes only the closed recommended-action human purpose into action sections", () => {
  const base = reviewedReportSession();
  const anchor = base.project.findings.find(
    ({ findingId }) => findingId === "F-CORE",
  )!.sourceAnchors[0];
  const session = addHumanJudgment(base, {
    findingId: "H-GENERIC",
    purpose: "generic",
    statement: "一般人工判断不构成行动建议",
    anchor,
    reviewer: "合规复核人",
    reason: "仅作一般判断",
    reviewedAt: "2026-08-16T02:30:00.000Z",
  }) as WorkflowSession;
  const full = buildFullReport(session);
  const quick = buildQuickCommentary(session);
  expect(
    full.sections.find(({ key }) => key === "recommended_actions")?.items,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ findingId: "H-ACTION" }),
    ]),
  );
  expect(
    full.sections.find(({ key }) => key === "recommended_actions")?.items,
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ findingId: "H-GENERIC" }),
    ]),
  );
  expect(
    quick.sections.find(({ key }) => key === "actions")?.items,
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ findingId: "H-GENERIC" }),
    ]),
  );
  expect(
    full.sections.find(({ key }) => key === "evidence_appendix")?.items,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ findingId: "H-GENERIC" }),
    ]),
  );
});
