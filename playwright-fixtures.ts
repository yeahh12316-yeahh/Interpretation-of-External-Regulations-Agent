import {
  expect,
  test as base,
  type ConsoleMessage,
} from "@playwright/test";

export interface ExpectedConsoleError {
  readonly text: RegExp;
  readonly url: RegExp;
  readonly count: number;
}

interface ErrorCaptureOptions {
  readonly expectedConsoleErrors: {
    readonly specs: readonly ExpectedConsoleError[];
  };
}

export interface CapturedConsoleError {
  readonly text: string;
  readonly url: string;
}

export const reconcileConsoleErrors = (
  expected: readonly ExpectedConsoleError[],
  actual: readonly CapturedConsoleError[],
): string[] => {
  const remaining = expected.map((spec) => ({ spec, count: spec.count }));
  const failures: string[] = [];
  for (const message of actual) {
    const match = remaining.find(
      ({ spec, count }) =>
        count > 0 && spec.text.test(message.text) && spec.url.test(message.url),
    );
    if (!match) {
      failures.push(`unexpected console.error: ${message.url} :: ${message.text}`);
      continue;
    }
    match.count -= 1;
  }
  for (const { spec, count } of remaining) {
    if (count !== 0)
      failures.push(
        `unconsumed console.error expectation (${count}/${spec.count}): ${String(spec.url)} :: ${String(spec.text)}`,
      );
  }
  return failures;
};

export const test = base.extend<ErrorCaptureOptions>({
  expectedConsoleErrors: [{ specs: [] }, { option: true }],
  page: async ({ page, expectedConsoleErrors }, use) => {
    const consoleErrors: CapturedConsoleError[] = [];
    const pageErrors: string[] = [];
    const consoleListener = (message: ConsoleMessage) => {
      if (message.type() !== "error") return;
      consoleErrors.push({
        text: message.text(),
        url: message.location().url,
      });
    };
    const pageErrorListener = (error: Error) => {
      pageErrors.push(`pageerror: ${error.message}`);
    };
    page.on("console", consoleListener);
    page.on("pageerror", pageErrorListener);
    try {
      await use(page);
    } finally {
      page.off("console", consoleListener);
      page.off("pageerror", pageErrorListener);
      expect(
        [
          ...pageErrors,
          ...reconcileConsoleErrors(expectedConsoleErrors.specs, consoleErrors),
        ],
        "unexpected, missing, or duplicate browser console/page errors",
      ).toEqual([]);
    }
  },
});

export { expect, type Page } from "@playwright/test";
