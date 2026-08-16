import { defineConfig } from "@playwright/test";
import { resolveProductionBaseUrl } from "./scripts/production-base-url.mjs";

export default defineConfig({
  testDir: ".",
  testMatch: ["tests/e2e/production-smoke.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: resolveProductionBaseUrl(process.env.PRODUCTION_BASE_URL),
    trace: "retain-on-failure",
  },
});
