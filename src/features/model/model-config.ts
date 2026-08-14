export interface ModelConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs?: number;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  baseUrl: "https://api.openai.com/v1",
  model: "",
  temperature: 0,
  maxOutputTokens: 2_000,
  timeoutMs: 60_000,
};

export function normalizeChatCompletionsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("请输入有效的 HTTPS Base URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("模型接口仅允许使用 HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Base URL 不得包含用户名或密码");
  }

  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path;
  } else if (!path) {
    url.pathname = "/v1/chat/completions";
  } else {
    url.pathname = `${path}/chat/completions`;
  }
  return url.toString();
}

export function validateModelConfig(config: ModelConfig): void {
  normalizeChatCompletionsUrl(config.baseUrl);
  if (!config.model.trim()) {
    throw new Error("请输入模型名称");
  }
  if (
    !Number.isFinite(config.temperature) ||
    config.temperature < 0 ||
    config.temperature > 2
  ) {
    throw new Error("温度必须在 0 到 2 之间");
  }
  if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1) {
    throw new Error("最大输出长度必须为正整数");
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1)
  ) {
    throw new Error("超时时间必须为正数");
  }
}
