import { expect, it } from "vitest";

import { buildFullReport } from "./build-full-report";
import { buildQuickCommentary } from "./build-quick-commentary";
import {
  draftReportSession,
  reviewedReportSession,
} from "./__test__/report-fixture";

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
