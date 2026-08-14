import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupServer } from "msw/node";

import {
  MODEL_BASE_URL,
  chatCompletionHandler,
} from "../../test/msw/model-handlers";
import { projectDatabase } from "../projects/db";
import { modelPreferences } from "../projects/model-preferences";
import {
  ApiSettingsDialog,
  ThirdPartyDataFlowDialog,
  thirdPartyDataFlowDisclosure,
} from "./ApiSettingsDialog";
import { sessionCredentials } from "./session-credentials";

const server = setupServer(
  chatCompletionHandler({ content: '{"connection":"ok"}' }),
);
const secret = "sk-dialog-secret";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  sessionCredentials.clear();
});
afterEach(async () => {
  server.resetHandlers();
  sessionCredentials.clear();
  await modelPreferences.clear();
});
afterAll(() => server.close());

describe("ApiSettingsDialog", () => {
  test("tests and saves BYOK settings while persisting only opted-in non-secret preferences", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ApiSettingsDialog open onClose={onClose} />);

    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(screen.getByLabelText("Base URL"), MODEL_BASE_URL);
    await user.type(screen.getByLabelText("API Key"), secret);
    await user.type(screen.getByLabelText("模型"), "model-a");
    await user.click(
      screen.getByRole("checkbox", { name: "记住接口地址和模型" }),
    );
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("status")).toHaveTextContent("连接成功");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(sessionCredentials.get()).toMatchObject({
      baseUrl: MODEL_BASE_URL,
      apiKey: secret,
      model: "model-a",
    });
    expect(await modelPreferences.load()).toEqual({
      baseUrl: MODEL_BASE_URL,
      model: "model-a",
    });
    expect(
      localStorage.getItem("external-regulation-agent:model-session"),
    ).toBeNull();
    expect(JSON.stringify(await modelPreferences.load())).not.toContain(secret);
    expect(
      JSON.stringify(await projectDatabase.modelPreferences.toArray()),
    ).not.toContain(secret);
    expect(document.body.textContent).not.toContain(secret);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("shows a redacted auth diagnosis and never renders the API key", async () => {
    server.use(chatCompletionHandler({ status: 401 }));
    const user = userEvent.setup();
    render(<ApiSettingsDialog open onClose={() => undefined} />);

    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(screen.getByLabelText("Base URL"), MODEL_BASE_URL);
    await user.type(screen.getByLabelText("API Key"), secret);
    await user.type(screen.getByLabelText("模型"), "missing-model");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("鉴权失败");
    expect(alert).not.toHaveTextContent(secret);
    expect(document.body.textContent).not.toContain(secret);
  });

  test("blocks non-HTTPS endpoints without sending a request", async () => {
    const user = userEvent.setup();
    render(<ApiSettingsDialog open onClose={() => undefined} />);

    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(
      screen.getByLabelText("Base URL"),
      "http://model.example/v1",
    );
    await user.type(screen.getByLabelText("API Key"), secret);
    await user.type(screen.getByLabelText("模型"), "model-a");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("HTTPS");
  });
});

describe("ThirdPartyDataFlowDialog", () => {
  test("requires explicit acknowledgement before the first regulatory text is sent", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    expect(thirdPartyDataFlowDisclosure.needsAcknowledgement()).toBe(true);
    render(
      <ThirdPartyDataFlowDialog
        open
        endpoint={MODEL_BASE_URL}
        model="model-a"
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "第三方模型数据流告知" });
    expect(within(dialog).getByText(/监管文本.*发送至/)).toBeVisible();
    expect(within(dialog).getByText(/model\.example/)).toBeVisible();
    const confirm = within(dialog).getByRole("button", { name: "确认并发送" });
    expect(confirm).toBeDisabled();

    await user.click(within(dialog).getByRole("checkbox", { name: /已了解/ }));
    await user.click(confirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(thirdPartyDataFlowDisclosure.needsAcknowledgement()).toBe(false);
  });
});
