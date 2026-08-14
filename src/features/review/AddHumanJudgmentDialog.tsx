import { useEffect, useState, type FormEvent, type JSX } from "react";

import type { Finding } from "../../domain/finding";
import { useAccessibleDialog } from "./use-accessible-dialog";

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
  const { dialogRef, initialFocusRef, onKeyDown } =
    useAccessibleDialog<HTMLTextAreaElement>(open, onClose);
  if (!open || !basisFinding?.sourceAnchors[0]) return null;
  const valid = statement.trim().length > 0 && reason.trim().length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSave(statement.trim(), reason.trim());
  };
  return (
    <div
      aria-labelledby="human-judgment-title"
      aria-modal="true"
      className="workflow-dialog"
      role="dialog"
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <form onSubmit={submit}>
        <h2 id="human-judgment-title">新增人工判断</h2>
        <p>依据：{basisFinding.sourceAnchors[0].quote}</p>
        <label>
          人工判断陈述
          <textarea
            ref={initialFocusRef}
            required
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
          />
        </label>
        {!valid ? <p role="alert">人工判断陈述与判断理由均为必填项。</p> : null}
        <label>
          判断理由
          <textarea
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="submit" disabled={!valid}>
            保存人工判断
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
