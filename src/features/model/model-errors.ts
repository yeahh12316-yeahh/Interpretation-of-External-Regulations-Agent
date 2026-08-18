export type ModelErrorKind =
  | "cors"
  | "auth"
  | "not_found"
  | "rate_limit"
  | "timeout"
  | "request_too_large"
  | "bad_request"
  | "upstream_unavailable"
  | "invalid_schema"
  | "consent_required"
  | "network";

const safeMessages: Record<ModelErrorKind, string> = {
  cors: "请求失败，可能是 CORS 限制或网络故障；浏览器无法可靠区分两者。",
  auth: "鉴权失败，请检查 API Key 是否有效。",
  not_found: "接口或模型不存在，请检查 Base URL 和模型名称。",
  rate_limit: "请求过于频繁或额度不足，请稍后重试。",
  timeout:
    "模型请求超过单次分析的 120 秒等待上限；请检查接口是否能处理当前材料，或稍后重试。",
  request_too_large: "本次分析请求超过代理可处理的大小，请减少材料范围后重试。",
  bad_request:
    "模型接口拒绝了正式分析请求，请检查模型名称、输入长度和接口兼容性。",
  upstream_unavailable:
    "模型代理暂时无法连接上游接口；连接测试可能成功，但正式分析请求被上游拒绝或中断，请稍后重试。",
  invalid_schema:
    "模型未按要求返回结构化 JSON；系统已尝试 JSON Schema、兼容 JSON 模式和两次修复仍未通过。请更换支持结构化输出的模型或检查接口兼容性后重试。",
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
