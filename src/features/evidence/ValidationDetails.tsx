import type { JSX } from "react";

import type { ValidationResult, ValidationRule } from "./validate-finding";

const RULE_LABELS: Record<ValidationRule, string> = {
  source_id: "来源 ID",
  source_type: "来源类型",
  locator_page: "页码定位",
  locator_paragraph: "段落定位",
  locator_article: "条款定位",
  quote_match: "引用反向匹配",
  modal_strength: "监管强度词",
  dates: "日期一致性",
  numbers: "数字与比例",
  inference_parent: "推导父项",
};

export interface ValidationDetailsProps {
  open: boolean;
  results: readonly ValidationResult[];
  onClose: () => void;
}

export function ValidationDetails({
  open,
  results,
  onClose,
}: ValidationDetailsProps): JSX.Element | null {
  if (!open) return null;

  return (
    <div className="validation-backdrop">
      <section
        aria-labelledby="validation-details-title"
        aria-modal="true"
        className="validation-dialog"
        role="dialog"
      >
        <div className="validation-dialog__header">
          <h3 id="validation-details-title">证据校验详情</h3>
          <button aria-label="关闭校验详情" onClick={onClose} type="button">
            关闭
          </button>
        </div>
        <ul className="validation-list">
          {results.map((item) => (
            <li data-severity={item.severity} key={item.rule}>
              <div>
                <strong>{RULE_LABELS[item.rule]}</strong>
                <span className="validation-state">
                  {item.passed ? "通过" : "未通过"}
                </span>
              </div>
              <p>{item.message}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
