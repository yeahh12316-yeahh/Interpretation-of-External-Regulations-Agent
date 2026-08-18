import { afterEach, describe, expect, test, vi } from "vitest";

import proxy from "./model-proxy";

const makeRequest = (body: unknown, headers?: Record<string, string>) =>
  new Request("https://app.example/api/model-proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer ak-test-only",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const validBody = {
  upstreamUrl: "https://nova.deloitte.com.cn/del/v1",
  model: "DeepSeek-V4-Flash",
  messages: [{ role: "user", content: "只返回 JSON" }],
  response_format: { type: "json_schema" },
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MODEL_PROXY_ALLOWED_ORIGIN;
});

describe("Vercel model proxy", () => {
  test("forwards only the fixed Nova endpoint and never includes the key in the body", async () => {
    const upstreamFetch = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer ak-test-only",
      });
      const forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(forwarded).not.toHaveProperty("upstreamUrl");
      expect(JSON.stringify(forwarded)).not.toContain("ak-test-only");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"connection":"ok"}' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await proxy.fetch(makeRequest(validBody));

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledWith(
      "https://nova.deloitte.com.cn/del/v1/chat/completions",
      expect.any(Object),
    );
  });

  test("rejects arbitrary upstream hosts before making a network request", async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await proxy.fetch(
      makeRequest({ ...validBody, upstreamUrl: "https://example.com/chat/completions" }),
    );

    expect(response.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  test("answers preflight only for the explicitly configured origin", async () => {
    process.env.MODEL_PROXY_ALLOWED_ORIGIN = "https://app.example";
    const response = await proxy.fetch(
      new Request("https://app.example/api/model-proxy", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example",
    );
  });

  test("allows the published Vercel and GitHub Pages origins by default", async () => {
    const response = await proxy.fetch(
      new Request("https://app.example/api/model-proxy", {
        method: "OPTIONS",
        headers: {
          Origin: "https://yeahh12316-yeahh.github.io",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://yeahh12316-yeahh.github.io",
    );
  });
});
