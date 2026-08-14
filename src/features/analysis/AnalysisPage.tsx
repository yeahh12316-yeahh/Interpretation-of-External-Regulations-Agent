import type { JSX } from "react";

import type { Finding } from "../../domain/finding";
import { EvidencePanel } from "../evidence/EvidencePanel";
import type { ReviewWorkflowState } from "../review/review-actions";

export interface AnalysisPageProps {
  state: ReviewWorkflowState;
  selectedFindingId: string | null;
  onSelectedFindingIdChange: (findingId: string) => void;
  onRun: () => void;
  onCancel: () => void;
  running: boolean;
  progress: { stage: string; completed: number; total: number } | null;
}

const severity = (finding: Finding) =>
  finding.requiredReview ? "必审" : "一般";

export function AnalysisPage({
  state,
  selectedFindingId,
  onSelectedFindingIdChange,
  onRun,
  onCancel,
  running,
  progress,
}: AnalysisPageProps): JSX.Element {
  return (
    <section aria-labelledby="analysis-title">
      <header className="page-heading">
        <div>
          <p className="eyebrow">步骤 3</p>
          <h1 id="analysis-title">监管分析</h1>
        </div>
        {running ? (
          <button type="button" onClick={onCancel}>
            取消分析
          </button>
        ) : (
          <button type="button" onClick={onRun}>
            {state.pendingReanalysis ? "执行定向重分析" : "开始监管分析"}
          </button>
        )}
      </header>
      {running && progress ? (
        <div role="status">
          <p>阶段：{progress.stage}</p>
          <progress max={progress.total} value={progress.completed} />{" "}
          <span>
            {progress.completed}/{progress.total}
          </span>
        </div>
      ) : null}
      {!state.project.findings.length ? (
        <p>尚无分析结论。模型不会在未配置并确认第三方数据流前自动调用。</p>
      ) : (
        <div className="review-layout">
          <div className="analysis-cards">
            {state.project.findings.map((finding) => (
              <button
                className={
                  selectedFindingId === finding.findingId
                    ? "analysis-card is-selected"
                    : "analysis-card"
                }
                key={finding.findingId}
                type="button"
                onClick={() => onSelectedFindingIdChange(finding.findingId)}
              >
                <strong>
                  {finding.findingId} · {severity(finding)}
                </strong>
                <span>{finding.category}</span>
                <span>{finding.statement}</span>
              </button>
            ))}
          </div>
          <EvidencePanel
            selectedFindingId={selectedFindingId}
            findings={state.project.findings}
            sources={state.project.sourceUnits}
            parsedUnits={state.parsedUnits}
            atomicRequirements={state.atomicRequirements}
            ruleReviewAttestations={state.ruleReviewAttestations}
          />
        </div>
      )}
    </section>
  );
}
