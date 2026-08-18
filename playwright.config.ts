import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["src/**/*.e2e.ts", "tests/e2e/**/*.spec.ts"],
  testIgnore: [
    "tests/e2e/production-smoke.spec.ts",
    "**/.worktrees/**",
    "**/.pnpm-store/**",
    "src/features/projects/src/**",
    "src/features/projects/changed-files/**",
  ],
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node_modules/.bin/vite --host 127.0.0.1 --port 4173",
    // GitHub Pages needs a repository base path for the production build, but
    // the local Vite server used by Playwright must serve from `/`.
    env: { GITHUB_ACTIONS: "false" },
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
