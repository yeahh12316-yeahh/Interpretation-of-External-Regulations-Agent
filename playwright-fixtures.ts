import {
  expect,
  test as base,
  type ConsoleMessage,
  type Page,
} from "@playwright/test";

interface ErrorCaptureOptions {
  readonly allowedConsoleErrors: readonly RegExp[];
}

const capturedMessage = (message: ConsoleMessage): string =>
  `console.error: ${message.text()}`;

export const test = base.extend<ErrorCaptureOptions>({
  allowedConsoleErrors: [[], { option: true }],
  page: async ({ page, allowedConsoleErrors }, use) => {
    const errors: string[] = [];
    const whitelist = Array.isArray(allowedConsoleErrors)
      ? allowedConsoleErrors
      : [allowedConsoleErrors];
    const consoleListener = (message: ConsoleMessage) => {
      if (
        message.type() === "error" &&
        !whitelist.some((allowed) => allowed.test(message.text()))
      )
        errors.push(capturedMessage(message));
    };
    const pageErrorListener = (error: Error) => {
      errors.push(`pageerror: ${error.message}`);
    };
    page.on("console", consoleListener);
    page.on("pageerror", pageErrorListener);
    try {
      await use(page);
    } finally {
      page.off("console", consoleListener);
      page.off("pageerror", pageErrorListener);
      expect(errors, "unexpected browser console/page errors").toEqual([]);
    }
  },
});

export { expect, type Page };
