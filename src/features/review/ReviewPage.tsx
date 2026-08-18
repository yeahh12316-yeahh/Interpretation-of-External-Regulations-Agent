import { useEffect, useMemo, useState, type JSX } from "react";

import type { Finding } from "../../domain/finding";
import { EvidencePanel } from "../evidence/EvidencePanel";
import { resolveValidationResults } from "../evidence/review-attestation";
import {
  createSourceIndex,
  validateFinding,
} from "../evidence/validate-finding";
import { AddHumanJudgmentDialog } from "./AddHumanJudgmentDialog";
import { EditFindingDialog } from "./EditFindingDialog";
import {
  addHumanJudgment,
  attestValidationRule,
  confirmFinding,
  deleteFinding,
  modifyFinding,
  returnForReanalysis,
  type ReviewWorkflowState,
} from "./review-actions";
import { ReturnToAnalysisDialog } from "./ReturnToAnalysisDialog";

export interface ReviewPageProps {
  state: ReviewWorkflowState;
  onChange: (state: ReviewWorkflowState) => void;
  selectedFindingId?: string | null;
  onSelectedFindingIdChange?: (findingId: string | null) => void;
}

const orderFindings = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((left, right) => {
    const score = (finding: Finding) =>
      (finding.reviewStatus === "deleted" ? -100 : 0) +
      (finding.requiredReview ? 20 : 0) +
      (finding.claimType === "pending_confirmation" ? 10 : 0) +
      (finding.claimType === "regulatory_fact" ? 5 : 0);
    return score(right) - score(left);
  });

export function ReviewPage({
  state,
  onChange,
  selectedFindingId: controlledSelected,
  onSelectedFindingIdChange,
}: ReviewPageProps): JSX.Element {
  const ordered = useMemo(
    () => orderFindings(state.project.findings),
    [state.project.findings],
  );
  const [internalSelected, setInternalSelected] = useState<string | null>(
    ordered[0]?.findingId ?? null,
  );
  const selectedId =
    controlledSelected === undefined ? internalSelected : controlledSelected;
  const select = (findingId: string | null) => {
    setInternalSelected(findingId);
    onSelectedFindingIdChange?.(findingId);
  };
  useEffect(() => {
    if (
      !selectedId ||
      !state.project.findings.some(({ findingId }) => findingId === selectedId)
    )
      select(ordered[0]?.findingId ?? null);
    // Selection repair is deliberately tied to the finding collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.project.findings]);
  const selected =
    state.project.findings.find(({ findingId }) => findingId === selectedId) ??
    null;
  const [editOpen, setEditOpen] = useState(false);
  const [humanOpen, setHumanOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [validationDetailsRequest, setValidationDetailsRequest] = useState(0);
  const [reviewer, setReviewer] = useState("合规复核人");
  const [ruleReasons, setRuleReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const apply = (action: () => ReviewWorkflowState) => {
    try {
      setError(null);
      onChange(action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "复核操作失败");
    }
  };
  const meta = (reason: string) => ({ reviewer, reason });
  const index = useMemo(
    () =>
      createSourceIndex({
        sources: state.project.sourceUnits,
        parsedUnits: state.parsedUnits,
        findings: state.project.findings,
        atomicRequirements: state.atomicRequirements,
      }),
    [state],
  );
  const resolvedRules = selected
    ? resolveValidationResults(
        selected,
        validateFinding(selected, index),
        state.atomicRequirements,
        state.ruleReviewAttestations,
      )
    : [];
  const manualRules = resolvedRules.filter(
    ({ resolution }) =>
      resolution === "manual_review_pending" ||
      resolution === "manual_rejected",
  );
  const integrityFailed = resolvedRules.some(
    ({ resolution }) => resolution === "attestation_integrity_failed",
  );

  return (
    <section aria-labelledby="review-title" className="review-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">步骤 4</p>
          <h1 id="review-title">人工复核与修正</h1>
        </div>
        <button
          className="btn btn-small btn-primary"
          type="button"
          onClick={() => setHumanOpen(true)}
          disabled={!selected?.sourceAnchors[0]}
        >
          新增人工判断
        </button>
      </header>
      <label className="reviewer-field">
        当前复核人
        <input
          required
          value={reviewer}
          onChange={(event) => setReviewer(event.target.value)}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="review-layout">
        <div className="review-list" aria-label="复核事项">
          {ordered.map((finding) => (
            <article
              className={
                finding.findingId === selectedId
                  ? "review-card review-row is-selected"
                  : "review-card review-row"
              }
              data-testid="review-item"
              key={finding.findingId}
            >
              <p>
                <strong>{finding.findingId}</strong> ·{" "}
                {finding.requiredReview ? "必审" : "一般"} ·{" "}
                {finding.reviewStatus}
              </p>
              <h2>{finding.category}</h2>
              <p>{finding.statement}</p>
              {expandedId === finding.findingId ? (
                <dl>
                  <dt>结论类型</dt>
                  <dd>
                    {finding.claimType === "regulatory_fact"
                      ? "监管事实"
                      : finding.claimType}
                  </dd>
                  <dt>修订次数</dt>
                  <dd>{finding.revisionRecords.length}</dd>
                </dl>
              ) : null}
              <div className="card-actions">
                <button
                  className="btn btn-small"
                  type="button"
                  onClick={() => select(finding.findingId)}
                >
                  查看原文
                </button>
                <button
                  className="btn btn-small"
                  type="button"
                  onClick={() => {
                    select(finding.findingId);
                    setValidationDetailsRequest((current) => current + 1);
                  }}
                >
                  查看依据
                </button>
                <button
                  className="btn btn-small"
                  type="button"
                  onClick={() => {
                    select(finding.findingId);
                    setExpandedId(
                      expandedId === finding.findingId
                        ? null
                        : finding.findingId,
                    );
                  }}
                >
                  查看详情
                </button>
                <button
                  className="btn btn-small btn-primary"
                  aria-label={`确认 ${finding.findingId}`}
                  disabled={
                    !reviewer.trim() || finding.reviewStatus === "deleted"
                  }
                  type="button"
                  onClick={() =>
                    apply(() =>
                      confirmFinding(
                        state,
                        finding.findingId,
                        meta("确认当前结论"),
                      ),
                    )
                  }
                >
                  确认
                </button>
                <button
                  className="btn btn-small"
                  aria-label={`修改 ${finding.findingId}`}
                  disabled={finding.reviewStatus === "deleted"}
                  type="button"
                  onClick={() => {
                    select(finding.findingId);
                    setEditOpen(true);
                  }}
                >
                  修改
                </button>
                <button
                  className="btn btn-small btn-danger"
                  aria-label={`删除 ${finding.findingId}`}
                  disabled={
                    !reviewer.trim() || finding.reviewStatus === "deleted"
                  }
                  type="button"
                  onClick={() =>
                    apply(() =>
                      deleteFinding(
                        state,
                        finding.findingId,
                        meta("人工软删除"),
                      ),
                    )
                  }
                >
                  删除
                </button>
              </div>
            </article>
          ))}
          <button
            className="btn btn-small"
            type="button"
            onClick={() => setReturnOpen(true)}
          >
            退回重新分析
          </button>
        </div>
        <div>
          <EvidencePanel
            selectedFindingId={selectedId}
            findings={state.project.findings}
            sources={state.project.sourceUnits}
            parsedUnits={state.parsedUnits}
            atomicRequirements={state.atomicRequirements}
            ruleReviewAttestations={state.ruleReviewAttestations}
            officialPrimarySourceIds={state.officialPrimarySourceIds}
            openValidationDetailsRequest={validationDetailsRequest}
          />
          {integrityFailed ? (
            <p role="alert">
              当前人工证据确认已因结论或来源变更而失效，请退回重分析并重新复核。
            </p>
          ) : null}
          {manualRules.length ? (
            <section aria-label="人工证据规则">
              <h2>待人工确认的证据规则</h2>
              {manualRules.map((rule) => {
                if (rule.rule === "attestation_integrity") return null;
                const validationRule = rule.rule;
                const key = `${selectedId}:${validationRule}`;
                return (
                  <div data-testid="manual-rule" key={key}>
                    <p>
                      {validationRule}：{rule.message}
                    </p>
                    <label>
                      规则复核理由
                      <input
                        value={ruleReasons[key] ?? ""}
                        onChange={(event) =>
                          setRuleReasons((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      className="btn btn-small btn-primary"
                      type="button"
                      disabled={
                        !reviewer.trim() || !(ruleReasons[key] ?? "").trim()
                      }
                      onClick={() =>
                        selected &&
                        apply(() =>
                          attestValidationRule(
                            state,
                            selected.findingId,
                            validationRule,
                            "confirmed",
                            meta(ruleReasons[key] ?? ""),
                          ),
                        )
                      }
                    >
                      确认该规则
                    </button>
                    <button
                      className="btn btn-small btn-danger"
                      type="button"
                      disabled={
                        !reviewer.trim() || !(ruleReasons[key] ?? "").trim()
                      }
                      onClick={() =>
                        selected &&
                        apply(() =>
                          attestValidationRule(
                            state,
                            selected.findingId,
                            validationRule,
                            "rejected",
                            meta(ruleReasons[key] ?? ""),
                          ),
                        )
                      }
                    >
                      否决该规则
                    </button>
                  </div>
                );
              })}
            </section>
          ) : null}
        </div>
      </div>
      <EditFindingDialog
        open={editOpen}
        finding={selected}
        onClose={() => setEditOpen(false)}
        onSave={(statement, reason) => {
          if (!selected) return;
          apply(() => {
            setEditOpen(false);
            return modifyFinding(
              state,
              selected.findingId,
              statement,
              meta(reason),
            );
          });
        }}
      />
      <AddHumanJudgmentDialog
        open={humanOpen}
        basisFinding={selected}
        onClose={() => setHumanOpen(false)}
        onSave={(statement, reason, purpose) => {
          if (!selected?.sourceAnchors[0]) return;
          apply(() => {
            setHumanOpen(false);
            return addHumanJudgment(state, {
              findingId: `H-${state.project.findings.length + 1}`,
              purpose,
              statement,
              reason,
              reviewer,
              anchor: selected.sourceAnchors[0],
            });
          });
        }}
      />
      <ReturnToAnalysisDialog
        open={returnOpen}
        findings={state.project.findings}
        sources={state.project.sourceUnits}
        reviewer={reviewer}
        onClose={() => setReturnOpen(false)}
        onSubmit={(input) =>
          apply(() => {
            setReturnOpen(false);
            return returnForReanalysis(state, input);
          })
        }
      />
    </section>
  );
}
