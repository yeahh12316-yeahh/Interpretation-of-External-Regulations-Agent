export type ModelErrorKind =
  | "cors"
  | "auth"
  | "not_found"
  | "rate_limit"
  | "timeout"
  | "invalid_schema"
  | "consent_required"
  | "network";

const safeMessages: Record<ModelErrorKind, string> = {
  cors: "请求失败，可能是 CORS 限制或网络故障；浏览器无法可靠区分两者。",
  auth: "鉴权失败，请检查 API Key 是否有效。",
  not_found: "接口或模型不存在，请检查 Base URL 和模型名称。",
  rate_limit: "请求过于频繁或额度不足，请稍后重试。",
  timeout: "模型请求超时，请检查网络或稍后重试。",
  invalid_schema:
    "模型未按要求返回结构化 JSON，系统已自动尝试两次修复仍未通过；请更换支持结构化输出的模型或检查接口兼容性后重试。",
  consent_required: "发送用户材料前必须确认第三方模型数据流告知。",
  network: "模型接口不可用，请检查 HTTPS 地址和网络连接。",
};

export class ModelGatewayError extends Error {
  readonly kind: ModelErrorKind;

  constructor(kind: ModelErrorKind, safeMessage = safeMessages[kind]) {
    super(safeMessage);
    this.name = "ModelGatewayError";
    this.kind = kind;
  }
}

export const modelErrorMessage = (error: unknown): string => {
  if (error instanceof ModelGatewayError) {
    return error.message;
  }
  if (
    error instanceof Error &&
    /HTTPS|模型名称|最大输出|温度|Base URL/.test(error.message)
  ) {
    return error.message;
  }
  return safeMessages.network;
};
