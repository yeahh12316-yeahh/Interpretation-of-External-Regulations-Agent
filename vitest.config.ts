import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/e2e/**",
      ".worktrees/**",
      ".pnpm-store/**",
      "src/features/projects/src/**",
      "src/features/projects/changed-files/**",
    ],
    globals: true,
  },
});
