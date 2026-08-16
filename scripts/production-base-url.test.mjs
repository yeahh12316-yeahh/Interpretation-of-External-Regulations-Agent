import { describe, expect, it } from "vitest";

import { resolveProductionBaseUrl } from "./production-base-url.mjs";

describe("production smoke URL boundary", () => {
  it("fails closed without an explicitly supplied URL", () => {
    expect(() => resolveProductionBaseUrl(undefined)).toThrow(
      /required.*no local fallback/u,
    );
  });

  it.each([
    "http://public.example",
    "http://127.0.0.1:4173",
    "https://localhost",
    "https://[::1]",
  ])("rejects insecure or local targets: %s", (target) => {
    expect(() => resolveProductionBaseUrl(target)).toThrow(/HTTPS|non-local/u);
  });

  it("accepts only an explicit public HTTPS base and strips query state", () => {
    expect(
      resolveProductionBaseUrl(
        "https://approved-public-host.example/app?secret=no#fragment",
      ),
    ).toBe("https://approved-public-host.example/app");
  });
});
