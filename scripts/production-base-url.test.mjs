import { describe, expect, it } from "vitest";

import {
  isGlobalUnicastIp,
  resolveAndValidateProductionBaseUrl,
  resolveProductionBaseUrl,
} from "./production-base-url.mjs";

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
    "https://192.0.2.10",
    "https://198.51.100.10",
    "https://203.0.113.10",
    "https://240.0.0.1",
    "https://[fc00::1]",
    "https://[fd12:3456::1]",
    "https://[fe80::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[2001:db8::1]",
    "https://[3fff::1]",
    "https://deployment.example",
    "https://deployment.example.",
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

  it.each([
    ["93.184.216.34", true],
    ["2606:2800:220:1:248:1893:25c8:1946", true],
    ["192.0.2.1", false],
    ["198.51.100.1", false],
    ["203.0.113.1", false],
    ["2001:db8::1", false],
    ["2001::1", false],
    ["2001:100::1", false],
    ["2001:3::1", true],
    ["3fff::1", false],
    ["ff02::1", false],
  ])("classifies IANA global-only address %s", (address, expected) => {
    expect(isGlobalUnicastIp(address)).toBe(expected);
  });

  it("fails closed when DNS returns any private or reserved address", async () => {
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.4", family: 4 },
    ];
    await expect(
      resolveAndValidateProductionBaseUrl("https://vercel.com/app", lookup),
    ).rejects.toThrow(/DNS.*non-global/u);
  });

  it("fails closed on empty or failed DNS and accepts only all-global answers", async () => {
    await expect(
      resolveAndValidateProductionBaseUrl(
        "https://vercel.com/app",
        async () => [],
      ),
    ).rejects.toThrow(/DNS.*failed/u);
    await expect(
      resolveAndValidateProductionBaseUrl(
        "https://vercel.com/app",
        async () => {
          throw new Error("synthetic DNS failure");
        },
      ),
    ).rejects.toThrow(/DNS.*failed/u);
    await expect(
      resolveAndValidateProductionBaseUrl(
        "https://vercel.com/app",
        async () => [
          { address: "93.184.216.34", family: 4 },
          {
            address: "2606:2800:220:1:248:1893:25c8:1946",
            family: 6,
          },
        ],
      ),
    ).resolves.toBe("https://vercel.com/app/");
  });
});
