// @vitest-environment node

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { z } from "zod";

import {
  MODEL_BASE_URL,
  MODEL_CHAT_URL,
  chatCompletionHandler,
} from "../../test/msw/model-handlers";
import {
  createModelGateway,
  modelDataFlowConsent,
  testConnection,
} from "./model-gateway";

const server = setupServer(chatCompletionHandler());
const secret = "sk-never-render-or-log";
const config = {
  baseUrl: MODEL_BASE_URL,
  model: "model-a",
  temperature: 0,
  maxOutputTokens: 800,
  timeoutMs: 100,
};
const findingsSchema = z.object({
  findings: z.array(z.object({ statement: z.string() })),
});
const request = {
  messages: [
    { role: "system" as const, content: "仅提取监管原文中的事实。" },
    { role: "user" as const, content: "监管文本：机构应当建立制度。" },
  ],
  schema: findingsSchema,
  schemaName: "regulatory_findings",
};

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => modelDataFlowConsent.acknowledge());
afterEach(() => {
  modelDataFlowConsent.clear();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("OpenAI-compatible model gateway", () => {
  test("performs no fetch before consent, sends after acknowledgement, and blocks again after clear", async () => {
    let fetchCount = 0;
    server.use(
      http.post(MODEL_CHAT_URL, () => {
        fetchCount += 1;
        return HttpResponse.json({
          choices: [{ message: { content: '{"findings":[]}' } }],
        });
      }),
    );
    modelDataFlowConsent.clear();

    const beforeConsent = createModelGateway(config, secret).requestStructured(
      request,
    );
    await expect(beforeConsent).rejects.toMatchObject({
      kind: "consent_required",
    });
    await expect(beforeConsent).rejects.not.toThrow(
      /机构应当建立制度|sk-never/,
    );
    expect(fetchCount).toBe(0);

    modelDataFlowConsent.acknowledge();
    await expect(
      createModelGateway(config, secret).requestStructured(request),
    ).resolves.toEqual({ findings: [] });
    expect(fetchCount).toBe(1);

    modelDataFlowConsent.clear();
    await expect(
      createModelGateway(config, secret).requestStructured(request),
    ).rejects.toMatchObject({ kind: "consent_required" });
    expect(fetchCount).toBe(1);
  });

  test("normalizes a /v1 base URL and validates a structured chat completion", async () => {
    let authorization = "";
    let body: Record<string, unknown> = {};
    server.use(
      http.post(MODEL_CHAT_URL, async ({ request: incoming }) => {
        authorization = incoming.headers.get("authorization") ?? "";
        body = (await incoming.json()) as Record<string, unknown>;
        return HttpResponse.json({
          choices: [
            {
              message: { content: '{"findings":[]}' },
              finish_reason: "stop",
              index: 0,
            },
          ],
          model: "model-a",
        });
      }),
    );

    await expect(
      createModelGateway(config, secret).requestStructured(request),
    ).resolves.toEqual({
      findings: [],
    });
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(body).toMatchObject({
      model: "model-a",
      temperature: 0,
      max_tokens: 800,
    });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  test("accepts provider message content returned as text parts", async () => {
    server.use(
      http.post(MODEL_CHAT_URL, () =>
        HttpResponse.json({
          choices: [
            {
              message: {
                content: [{ type: "text", text: '{"findings":[]}' }],
              },
            },
          ],
        }),
      ),
    );

    await expect(
      createModelGateway(config, secret).requestStructured(request),
    ).resolves.toEqual({ findings: [] });
  });

  test("extracts JSON when the model wraps it in explanation or Markdown", async () => {
    server.use(
      http.post(MODEL_CHAT_URL, () =>
        HttpResponse.json({
          choices: [
            {
              message: {
                content: '结果如下：\\n```json\\n{"findings":[]}\\n```\\n以上。',
              },
            },
          ],
        }),
      ),
    );

    await expect(
      createModelGateway(config, secret).requestStructured(request),
    ).resolves.toEqual({ findings: [] });
  });

  test.each([
    [401, "auth"],
    [404, "not_found"],
    [429, "rate_limit"],
  ] as const)(
    "classifies HTTP %s without exposing provider details",
    async (status, kind) => {
      server.use(chatCompletionHandler({ status }));

      const rejection = createModelGateway(config, secret).requestStructured(
        request,
      );
      await expect(rejection).rejects.toMatchObject({ kind });
      await expect(rejection).rejects.not.toThrow(/provider detail|sk-never/);
    },
  );

  test("explains Nova's JSON login challenge instead of reporting a generic network error", async () => {
    server.use(
      http.post(MODEL_CHAT_URL, () =>
        HttpResponse.json(
          {
            status: 402,
            locationUrl:
              "https://nova.deloitte.com.cn/del/data/v1/oauth2/authorization/D.Nova",
          },
          { status: 401 },
        ),
      ),
    );

    const rejection = createModelGateway(config, secret).requestStructured(
      request,
    );
    await expect(rejection).rejects.toMatchObject({ kind: "auth" });
    await expect(rejection).rejects.toThrow(/Nova.*登录|鉴权挑战/);
    await expect(rejection).rejects.not.toThrow(/sk-never/);
  });

  test("reports fetch rejection as an uncertain CORS-or-network diagnosis", async () => {
    server.use(http.post(MODEL_CHAT_URL, () => HttpResponse.error()));

    const rejection = createModelGateway(config, secret).requestStructured(
      request,
    );
    await expect(rejection).rejects.toMatchObject({ kind: "cors" });
    await expect(rejection).rejects.toThrow(/CORS.*网络|网络.*CORS/);
  });

  test("aborts an overdue request and classifies it as timeout", async () => {
    server.use(chatCompletionHandler({ waitMs: "infinite" }));

    await expect(
      createModelGateway(
        { ...config, timeoutMs: 10 },
        secret,
      ).requestStructured(request),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  test("honors caller cancellation separately from timeout", async () => {
    server.use(chatCompletionHandler({ waitMs: "infinite" }));
    const controller = new AbortController();
    const result = createModelGateway(config, secret).requestStructured({
      ...request,
      signal: controller.signal,
    });

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("repairs malformed JSON at most twice using only the prior output and no source messages", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let call = 0;
    server.use(
        http.post(MODEL_CHAT_URL, async ({ request: incoming }) => {
        requestBodies.push((await incoming.json()) as Record<string, unknown>);
        call += 1;
        return HttpResponse.json({
          choices: [
            {
              message: {
                content: call === 1 ? "findings: none" : '{"findings":[]}',
              },
            },
          ],
        });
      }),
    );

    await expect(
      createModelGateway(config, secret).requestStructured(request),
    ).resolves.toEqual({
      findings: [],
    });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toMatchObject({
      response_format: { type: "json_object" },
    });
    const repairText = JSON.stringify(requestBodies[1]);
    expect(repairText).toContain("findings: none");
    expect(repairText).toContain("不得新增");
    expect(repairText).toContain("findings");
    expect(repairText).not.toContain("机构应当建立制度");
  });

  test("returns invalid_schema after exactly two unsuccessful format repairs", async () => {
    let calls = 0;
    server.use(
      http.post(MODEL_CHAT_URL, () => {
        calls += 1;
        return HttpResponse.json({
          choices: [{ message: { content: "still invalid" } }],
        });
      }),
    );

    await expect(
      createModelGateway(config, secret).requestStructured(request),
    ).rejects.toMatchObject({
      kind: "invalid_schema",
    });
    expect(calls).toBe(3);
  });

  test("rejects non-HTTPS endpoints before fetch and does not echo credentials", async () => {
    const rejection = createModelGateway(
      { ...config, baseUrl: "http://model.example/v1" },
      secret,
    ).requestStructured(request);

    await expect(rejection).rejects.toMatchObject({ kind: "network" });
    await expect(rejection).rejects.not.toThrow(/sk-never/);
  });

  test("connection test exercises authentication, model response, and schema validation", async () => {
    let fetchCount = 0;
    modelDataFlowConsent.clear();
    server.use(
      http.post(MODEL_CHAT_URL, () => {
        fetchCount += 1;
        return HttpResponse.json({
          choices: [{ message: { content: '{"connection":"ok"}' } }],
        });
      }),
    );

    await expect(testConnection(config, secret)).resolves.toEqual({
      ok: true,
      model: "model-a",
    });
    expect(fetchCount).toBe(1);
  });
});
