import { type JSX, useCallback, useEffect, useMemo, useState } from "react";

import type { ClaimType, Finding } from "../../domain/finding";
import type { SourceUnit } from "../../domain/source";
import type { AtomicRequirement } from "../analysis/skill-orchestrator";
import type { ParsedSourceUnit } from "../parsing/build-anchors";
import "./evidence.css";
import { findNormalizedTextRange } from "./normalize-text";
import {
  createSourceIndex,
  findIndexedParsedUnitForAnchor,
  type OfficialPrimarySourceIds,
  validateFinding,
} from "./validate-finding";
import { ValidationDetails } from "./ValidationDetails";
import { resolveValidationResults } from "./review-attestation";

const CLAIM_LABELS: Record<ClaimType, string> = {
  regulatory_fact: "监管事实",
  official_explanation: "官方解读",
  ai_inference: "AI 推导",
  pending_confirmation: "待人工确认",
  human_judgment: "人工判断",
};

export interface EvidencePanelProps {
  selectedFindingId: string | null;
  findings: readonly Finding[];
  sources: readonly SourceUnit[];
  parsedUnits: readonly ParsedSourceUnit[];
  atomicRequirements?: readonly AtomicRequirement[];
  ruleReviewAttestations?: unknown;
  officialPrimarySourceIds?: OfficialPrimarySourceIds;
}

const HighlightedExcerpt = ({
  text,
  quote,
}: {
  text: string;
  quote: string;
}): JSX.Element => {
  const range = findNormalizedTextRange(text, quote);
  if (!range) return <span>{text}</span>;
  return (
    <>
      {text.slice(0, range.start)}
      <mark data-testid="evidence-highlight">
        {text.slice(range.start, range.end)}
      </mark>
      {text.slice(range.end)}
    </>
  );
};

export function EvidencePanel({
  selectedFindingId,
  findings,
  sources,
  parsedUnits,
  atomicRequirements = [],
  ruleReviewAttestations = [],
  officialPrimarySourceIds,
}: EvidencePanelProps): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  useEffect(() => setDetailsOpen(false), [selectedFindingId]);

  const finding = findings.find(
    ({ findingId }) => findingId === selectedFindingId,
  );
  const index = useMemo(
    () =>
      createSourceIndex({
        sources,
        parsedUnits,
        findings,
        atomicRequirements,
        officialPrimarySourceIds,
      }),
    [
      atomicRequirements,
      findings,
      officialPrimarySourceIds,
      parsedUnits,
      sources,
    ],
  );
  const results = useMemo(
    () =>
      finding
        ? resolveValidationResults(
            finding,
            validateFinding(finding, index),
            atomicRequirements,
            ruleReviewAttestations,
          )
        : [],
    [atomicRequirements, finding, index, ruleReviewAttestations],
  );

  if (!finding) {
    return (
      <aside aria-label="原文证据" className="evidence-panel">
        <p className="evidence-empty" role="status">
          当前结论已删除或不存在，请重新选择结论。
        </p>
      </aside>
    );
  }

  const anchor = finding.sourceAnchors[0];
  const source = anchor
    ? sources.find(({ sourceId }) => sourceId === anchor.sourceId)
    : undefined;
  const parsedEvidence = anchor
    ? findIndexedParsedUnitForAnchor(anchor, index)
    : undefined;
  const originalText = parsedEvidence?.unit.text;

  return (
    <aside aria-label="原文证据" className="evidence-panel">
      <header className="evidence-panel__header">
        <div>
          <p className="evidence-eyebrow">当前结论证据</p>
          <h2>{finding.category}</h2>
        </div>
        <span className="evidence-type">{CLAIM_LABELS[finding.claimType]}</span>
      </header>

      {!source ? (
        <p className="evidence-alert" role="alert">
          来源已删除或不可用，当前引用不能用于定稿。
        </p>
      ) : (
        <dl className="evidence-meta">
          <div>
            <dt>文件</dt>
            <dd>{source.title}</dd>
          </div>
          <div>
            <dt>位置</dt>
            {parsedEvidence ? (
              <dd>
                <span>
                  {parsedEvidence.unit.page === null
                    ? "无固定页码"
                    : `第${parsedEvidence.unit.page}页`}
                </span>
                <span>{parsedEvidence.effectiveArticle ?? "未标注条款"}</span>
                <span>第{parsedEvidence.unit.paragraphIndex + 1}段</span>
              </dd>
            ) : (
              <dd>定位未验证/不可用</dd>
            )}
          </div>
          <div>
            <dt>来源类别</dt>
            <dd>
              {source.sourceType === "regulatory_text"
                ? "监管文件"
                : "官方解读"}
            </dd>
          </div>
        </dl>
      )}

      <section className="evidence-excerpt" aria-label="原文摘录">
        <h3>原文摘录</h3>
        {originalText && anchor ? (
          <blockquote data-testid="evidence-original">
            <HighlightedExcerpt quote={anchor.quote} text={originalText} />
          </blockquote>
        ) : (
          <p className="evidence-pending">
            权威解析定位不可用，原文摘录待校验。
          </p>
        )}
      </section>

      <button
        className="btn btn-link"
        onClick={() => setDetailsOpen(true)}
        type="button"
      >
        查看校验详情
      </button>

      <ValidationDetails
        onClose={closeDetails}
        open={detailsOpen}
        results={results}
      />
    </aside>
  );
}
