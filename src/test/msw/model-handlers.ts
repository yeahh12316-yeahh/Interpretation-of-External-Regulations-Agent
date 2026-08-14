import { delay, http, HttpResponse } from "msw";

export const MODEL_BASE_URL = "https://model.example/v1";
export const MODEL_CHAT_URL = `${MODEL_BASE_URL}/chat/completions`;

interface ChatCompletionOptions {
  content?: string;
  status?: number;
  waitMs?: number | "infinite";
}

export const chatCompletionHandler = ({
  content = JSON.stringify({ findings: [] }),
  status = 200,
  waitMs,
}: ChatCompletionOptions = {}) =>
  http.post(MODEL_CHAT_URL, async () => {
    if (waitMs !== undefined) {
      await delay(waitMs);
    }
    if (status !== 200) {
      return HttpResponse.json(
        { error: { message: "provider detail must not reach the UI" } },
        { status },
      );
    }
    return HttpResponse.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "model-a",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content },
        },
      ],
    });
  });
