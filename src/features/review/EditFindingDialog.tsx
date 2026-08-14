import { useEffect, useState, type FormEvent, type JSX } from "react";

import type { Finding } from "../../domain/finding";

export interface EditFindingDialogProps {
  open: boolean;
  finding: Finding | null;
  onClose: () => void;
  onSave: (statement: string, reason: string) => void;
}

export function EditFindingDialog({
  open,
  finding,
  onClose,
  onSave,
}: EditFindingDialogProps): JSX.Element | null {
  const [statement, setStatement] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open && finding) {
      setStatement(finding.statement);
      setReason("");
    }
  }, [open, finding]);
  if (!open || !finding) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      !statement.trim() ||
      !reason.trim() ||
      statement.trim() === finding.statement
    )
      return;
    onSave(statement.trim(), reason.trim());
  };
  return (
    <div
      aria-labelledby="edit-finding-title"
      aria-modal="true"
      className="workflow-dialog"
      role="dialog"
    >
      <form onSubmit={submit}>
        <h2 id="edit-finding-title">修改结论 {finding.findingId}</h2>
        <p>AI 原始结论保留在不可变复核记录中。</p>
        <label>
          修改后陈述
          <textarea
            required
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
          />
        </label>
        <label>
          修改理由
          <textarea
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="submit">保存修改</button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
