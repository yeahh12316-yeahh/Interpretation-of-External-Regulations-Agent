import { useEffect, useState, type FormEvent, type JSX } from "react";

import type { Finding } from "../../domain/finding";
import type { SourceUnit } from "../../domain/source";
import type { AnalysisStage } from "../analysis/skill-orchestrator";
import type { ReturnForReanalysisInput } from "./review-actions";

const scopes: readonly [AnalysisStage, string][] = [
  ["document_identity", "文件身份"],
  ["key_matters", "关键事项"],
  ["atomic_clauses", "原子条款"],
  ["institution_impact", "机构影响"],
];

export interface ReturnToAnalysisDialogProps {
  open: boolean;
  findings: readonly Finding[];
  sources: readonly SourceUnit[];
  reviewer: string;
  onClose: () => void;
  onSubmit: (input: ReturnForReanalysisInput) => void;
}

export function ReturnToAnalysisDialog({
  open,
  findings,
  sources,
  reviewer,
  onClose,
  onSubmit,
}: ReturnToAnalysisDialogProps): JSX.Element | null {
  const [reason, setReason] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [selectedScopes, setSelectedScopes] = useState<AnalysisStage[]>([]);
  useEffect(() => {
    if (open) {
      setReason("");
      setTargetIds([]);
      setSourceIds([]);
      setSelectedScopes([]);
    }
  }, [open]);
  if (!open) return null;
  const toggle = <T extends string>(
    value: T,
    current: T[],
    set: (items: T[]) => void,
  ) =>
    set(
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      !reason.trim() ||
      !reviewer.trim() ||
      !targetIds.length ||
      !sourceIds.length ||
      !selectedScopes.length
    )
      return;
    onSubmit({
      reason: reason.trim(),
      targetFindingIds: targetIds,
      sourceIds,
      scope: selectedScopes,
      requestedBy: reviewer,
    });
  };
  return (
    <div
      aria-labelledby="return-analysis-title"
      aria-modal="true"
      className="workflow-dialog"
      role="dialog"
    >
      <form onSubmit={submit}>
        <h2 id="return-analysis-title">退回重新分析</h2>
        <label>
          退回原因
          <textarea
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <fieldset>
          <legend>目标结论</legend>
          {findings
            .filter((finding) => finding.reviewStatus !== "deleted")
            .map((finding) => (
              <label key={finding.findingId}>
                <input
                  checked={targetIds.includes(finding.findingId)}
                  type="checkbox"
                  onChange={() =>
                    toggle(finding.findingId, targetIds, setTargetIds)
                  }
                />
                {finding.findingId} {finding.statement}
              </label>
            ))}
        </fieldset>
        <fieldset>
          <legend>来源范围</legend>
          {sources.map((source) => (
            <label key={source.sourceId}>
              <input
                checked={sourceIds.includes(source.sourceId)}
                type="checkbox"
                onChange={() =>
                  toggle(source.sourceId, sourceIds, setSourceIds)
                }
              />
              {source.sourceId}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>分析范围</legend>
          {scopes.map(([scope, label]) => (
            <label key={scope}>
              <input
                checked={selectedScopes.includes(scope)}
                type="checkbox"
                onChange={() =>
                  toggle(scope, selectedScopes, setSelectedScopes)
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button type="submit">提交重分析</button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
