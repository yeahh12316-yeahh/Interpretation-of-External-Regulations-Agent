import { useEffect, useState, type FormEvent, type JSX } from "react";

import { modelPreferences } from "../projects/model-preferences";
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "./model-config";
import { modelErrorMessage } from "./model-errors";
import { modelDataFlowConsent, testConnection } from "./model-gateway";
import { sessionCredentials } from "./session-credentials";

export interface ApiSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (config: ModelConfig) => void;
}

type ConnectionState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function ApiSettingsDialog({
  open,
  onClose,
  onSaved,
}: ApiSettingsDialogProps): JSX.Element | null {
  const current = sessionCredentials.get();
  const [baseUrl, setBaseUrl] = useState(
    current?.baseUrl ?? DEFAULT_MODEL_CONFIG.baseUrl,
  );
  const [apiKey, setApiKey] = useState(current?.apiKey ?? "");
  const [model, setModel] = useState(current?.model ?? "");
  const [temperature, setTemperature] = useState(
    DEFAULT_MODEL_CONFIG.temperature,
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    DEFAULT_MODEL_CONFIG.maxOutputTokens,
  );
  const [remember, setRemember] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({
    kind: "idle",
  });

  useEffect(() => {
    if (!open || current) return;
    let active = true;
    void modelPreferences.load().then((saved) => {
      if (!active || !saved) return;
      setBaseUrl(saved.baseUrl);
      setModel(saved.model);
      setRemember(true);
    });
    return () => {
      active = false;
    };
  }, [open, current]);

  if (!open) return null;

  const config = (): ModelConfig => ({
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    temperature,
    maxOutputTokens,
    timeoutMs: DEFAULT_MODEL_CONFIG.timeoutMs,
  });

  const runConnectionTest = async (): Promise<void> => {
    setConnection({ kind: "testing" });
    try {
      await testConnection(config(), apiKey);
      setConnection({
        kind: "success",
        message: "连接成功：鉴权、模型响应和结构化输出均正常。",
      });
    } catch (error) {
      setConnection({ kind: "error", message: modelErrorMessage(error) });
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      const selected = config();
      await testConnection(selected, apiKey);
      sessionCredentials.set({
        baseUrl: selected.baseUrl,
        apiKey,
        model: selected.model,
      });
      await modelPreferences.save(
        { baseUrl: selected.baseUrl, model: selected.model },
        { remember },
      );
      onSaved?.(selected);
      onClose();
    } catch (error) {
      setConnection({ kind: "error", message: modelErrorMessage(error) });
    }
  };

  return (
    <div aria-labelledby="api-settings-title" aria-modal="true" role="dialog">
      <form onSubmit={(event) => void save(event)}>
        <h2 id="api-settings-title">模型接口设置</h2>
        <p>API Key 仅保存在当前浏览器会话，不写入项目、备份或长期存储。</p>

        <label>
          Base URL
          <input
            required
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label>
          API Key
          <input
            autoComplete="off"
            required
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label>
          模型
          <input
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label>
          温度
          <input
            max="2"
            min="0"
            step="0.1"
            type="number"
            value={temperature}
            onChange={(event) => setTemperature(event.target.valueAsNumber)}
          />
        </label>
        <label>
          最大输出长度
          <input
            min="1"
            step="1"
            type="number"
            value={maxOutputTokens}
            onChange={(event) => setMaxOutputTokens(event.target.valueAsNumber)}
          />
        </label>
        <label>
          <input
            checked={remember}
            type="checkbox"
            onChange={(event) => setRemember(event.target.checked)}
          />
          记住接口地址和模型
        </label>

        {connection.kind === "testing" ? (
          <p role="status">正在测试连接…</p>
        ) : null}
        {connection.kind === "success" ? (
          <p role="status">{connection.message}</p>
        ) : null}
        {connection.kind === "error" ? (
          <p role="alert">{connection.message}</p>
        ) : null}

        <button
          disabled={connection.kind === "testing"}
          type="button"
          onClick={() => void runConnectionTest()}
        >
          测试连接
        </button>
        <button type="submit">保存设置</button>
        <button type="button" onClick={onClose}>
          取消
        </button>
      </form>
    </div>
  );
}

export interface ThirdPartyDataFlowDialogProps {
  open: boolean;
  endpoint: string;
  model: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ThirdPartyDataFlowDialog({
  open,
  endpoint,
  model,
  onConfirm,
  onCancel,
}: ThirdPartyDataFlowDialogProps): JSX.Element | null {
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => setAcknowledged(false), [open, endpoint, model]);
  if (!open) return null;

  let provider = "所选第三方模型服务商";
  try {
    provider = new URL(endpoint).host;
  } catch {
    // The settings form performs full URL validation before any request.
  }

  const confirm = (): void => {
    modelDataFlowConsent.acknowledge();
    onConfirm();
  };

  return (
    <div aria-labelledby="data-flow-title" aria-modal="true" role="dialog">
      <h2 id="data-flow-title">第三方模型数据流告知</h2>
      <p>
        本次操作会将监管文本及相关提示词发送至 {provider} 的模型{" "}
        {model || "（未命名）"}。
        数据处理受该服务商的条款与隐私政策约束，请确认材料允许发送至该服务商。
      </p>
      <label>
        <input
          checked={acknowledged}
          type="checkbox"
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        我已了解上述第三方数据流并确认可以发送
      </label>
      <button disabled={!acknowledged} type="button" onClick={confirm}>
        确认并发送
      </button>
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
