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
    "https://app.localhost",
    "https://[::1]",
    "https://127.99.1.2",
    "https://0.12.3.4",
    "https://10.12.3.4",
    "https://100.64.0.1",
    "https://169.254.8.9",
    "https://172.31.8.9",
    "https://192.168.1.9",
    "https://[fc00::1]",
    "https://[fd12:3456::1]",
    "https://[fe80::1]",
    "https://[::ffff:127.0.0.1]",
    "https://deployment.example",
    "https://deployment.invalid",
    "https://deployment.test",
  ])("rejects insecure or local targets: %s", (target) => {
    expect(() => resolveProductionBaseUrl(target)).toThrow(/HTTPS|non-local/u);
  });

  it.each([
    "https://user@vercel.com",
    "https://user:password@vercel.com",
    "https://vercel.com/app?token=secret",
    "https://vercel.com/app#fragment",
  ])("rejects credentials and non-path URL state: %s", (target) => {
    expect(() => resolveProductionBaseUrl(target)).toThrow(
      /credentials|query|fragment/u,
    );
  });

  it("accepts a public HTTPS host and preserves an explicit base path", () => {
    expect(resolveProductionBaseUrl("https://vercel.com/app")).toBe(
      "https://vercel.com/app/",
    );
    expect(
      new URL(
        "production-smoke/deep-link",
        resolveProductionBaseUrl("https://vercel.com/app"),
      ).href,
    ).toBe("https://vercel.com/app/production-smoke/deep-link");
  });
});
