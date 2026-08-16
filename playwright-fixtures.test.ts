import { describe, expect, it } from "vitest";

import { reconcileConsoleErrors } from "./playwright-fixtures";

describe("browser console contract", () => {
  const expected = [
    {
      text: /^Failed to load resource: net::ERR_CONNECTION_REFUSED$/u,
      url: /^https:\/\/failure\.example\/v1\/chat\/completions$/u,
      count: 1,
    },
  ];

  it("requires exact per-test message, URL, and count and rejects extras", () => {
    const message = {
      text: "Failed to load resource: net::ERR_CONNECTION_REFUSED",
      url: "https://failure.example/v1/chat/completions",
    };
    expect(reconcileConsoleErrors(expected, [message])).toEqual([]);
    expect(reconcileConsoleErrors(expected, [message, message])).toEqual([
      expect.stringContaining("unexpected console.error"),
    ]);
    expect(reconcileConsoleErrors(expected, [])).toEqual([
      expect.stringContaining("unconsumed console.error expectation"),
    ]);
  });
});
