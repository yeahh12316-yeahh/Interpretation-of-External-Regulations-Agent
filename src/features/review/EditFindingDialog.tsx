import { useEffect, useState, type FormEvent, type JSX } from "react";

import type { Finding } from "../../domain/finding";
import { useAccessibleDialog } from "./use-accessible-dialog";

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
  const { dialogRef, initialFocusRef, onKeyDown } =
    useAccessibleDialog<HTMLTextAreaElement>(open, onClose);
  if (!open || !finding) return null;
  const valid =
    statement.trim().length > 0 &&
    reason.trim().length > 0 &&
    statement.trim() !== finding.statement;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSave(statement.trim(), reason.trim());
  };
  return (
    <div
      aria-labelledby="edit-finding-title"
      aria-modal="true"
      className="workflow-dialog"
      role="dialog"
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <form onSubmit={submit}>
        <h2 id="edit-finding-title">修改结论 {finding.findingId}</h2>
        <p>AI 原始结论保留在不可变复核记录中。</p>
        <label>
          修改后陈述
          <textarea
            ref={initialFocusRef}
            required
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
          />
        </label>
        {!valid ? (
          <p role="alert">
            修改后陈述必须非空且不同于当前结论，并填写修改理由。
          </p>
        ) : null}
        <label>
          修改理由
          <textarea
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="submit" disabled={!valid}>
            保存修改
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
