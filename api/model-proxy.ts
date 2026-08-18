const NOVA_ORIGIN = "https://nova.deloitte.com.cn";
const NOVA_PATH = "/del/v1/chat/completions";
const MAX_REQUEST_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 90_000;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const allowedOrigin = (request: Request): string | null => {
  const origin = request.headers.get("origin");
  const configured = process.env.MODEL_PROXY_ALLOWED_ORIGIN?.trim();
  if (!origin || !configured || origin !== configured) return null;
  return origin;
};

const corsHeaders = (request: Request): HeadersInit => {
  const origin = allowedOrigin(request);
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        Vary: "Origin",
      }
    : {};
};

const jsonResponse = (
  request: Request,
  body: JsonRecord,
  status: number,
): Response =>
  Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const normalizeNovaUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.origin !== NOVA_ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/del/v1") return `${NOVA_ORIGIN}${NOVA_PATH}`;
    if (path === NOVA_PATH) return `${NOVA_ORIGIN}${NOVA_PATH}`;
    return null;
  } catch {
    return null;
  }
};

const isValidMessages = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (message) =>
      isRecord(message) &&
      (message.role === "system" ||
        message.role === "user" ||
        message.role === "assistant") &&
      typeof message.content === "string",
  );

const requestBody = async (request: Request): Promise<JsonRecord | null> => {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const forward = async (request: Request): Promise<Response> => {
  const auth = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(auth)) {
    return jsonResponse(request, { error: "missing_authorization" }, 401);
  }

  const input = await requestBody(request);
  if (!input) {
    return jsonResponse(request, { error: "invalid_request" }, 400);
  }

  const upstreamUrl = normalizeNovaUrl(input.upstreamUrl);
  if (!upstreamUrl) {
    return jsonResponse(request, { error: "unsupported_upstream" }, 400);
  }
  if (typeof input.model !== "string" || !input.model.trim()) {
    return jsonResponse(request, { error: "missing_model" }, 400);
  }
  if (!isValidMessages(input.messages)) {
    return jsonResponse(request, { error: "invalid_messages" }, 400);
  }

  const { upstreamUrl: _upstreamUrl, ...payload } = input;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const responseBody = await upstream.text();
    const contentType = upstream.headers.get("content-type") ?? "text/plain";
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        ...corsHeaders(request),
        "Cache-Control": "no-store",
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return jsonResponse(request, { error: "upstream_timeout" }, 504);
    }
    return jsonResponse(request, { error: "upstream_unavailable" }, 502);
  } finally {
    globalThis.clearTimeout(timeout);
  }
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          "Cache-Control": "no-store",
        },
      });
    }
    if (request.method !== "POST") {
      return jsonResponse(request, { error: "method_not_allowed" }, 405);
    }
    return forward(request);
  },
};
