import { defineConfig } from "@playwright/test";
import { resolveAndValidateProductionBaseUrl } from "./scripts/production-base-url.mjs";

const productionBaseUrl = await resolveAndValidateProductionBaseUrl(
  process.env.PRODUCTION_BASE_URL,
);

export default defineConfig({
  testDir: ".",
  testMatch: ["tests/e2e/production-smoke.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: productionBaseUrl,
    trace: "retain-on-failure",
  },
});
