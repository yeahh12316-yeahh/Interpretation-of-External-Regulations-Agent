import { useEffect, useState, type FormEvent, type JSX } from "react";

import type { Finding } from "../../domain/finding";

export interface AddHumanJudgmentDialogProps {
  open: boolean;
  basisFinding: Finding | null;
  onClose: () => void;
  onSave: (statement: string, reason: string) => void;
}

export function AddHumanJudgmentDialog({
  open,
  basisFinding,
  onClose,
  onSave,
}: AddHumanJudgmentDialogProps): JSX.Element | null {
  const [statement, setStatement] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) {
      setStatement("");
      setReason("");
    }
  }, [open]);
  if (!open || !basisFinding?.sourceAnchors[0]) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!statement.trim() || !reason.trim()) return;
    onSave(statement.trim(), reason.trim());
  };
  return (
    <div
      aria-labelledby="human-judgment-title"
      aria-modal="true"
      className="workflow-dialog"
      role="dialog"
    >
      <form onSubmit={submit}>
        <h2 id="human-judgment-title">新增人工判断</h2>
        <p>依据：{basisFinding.sourceAnchors[0].quote}</p>
        <label>
          人工判断陈述
          <textarea
            required
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
          />
        </label>
        <label>
          判断理由
          <textarea
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="submit">保存人工判断</button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
