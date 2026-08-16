import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file) => readFile(path.resolve(process.cwd(), file), "utf8");

describe("deployment configuration contract", () => {
  it("runs the fail-closed build scan inside the Vercel build command", async () => {
    const config = JSON.parse(await read("vercel.json"));
    expect(config.buildCommand).toBe("pnpm build && pnpm scan:build");
  });

  it("sets browser security headers compatible with local workers and HTTPS BYOK", async () => {
    const config = JSON.parse(await read("vercel.json"));
    const headers = Object.fromEntries(
      config.headers.flatMap((entry) =>
        entry.headers.map(({ key, value }) => [key.toLowerCase(), value]),
      ),
    );
    expect(headers["content-security-policy"]).toContain(
      "worker-src 'self' blob:",
    );
    expect(headers["content-security-policy"]).toContain(
      "connect-src 'self' https:",
    );
    expect(headers["content-security-policy"]).toContain(
      "font-src 'self' data:",
    );
    expect(headers["content-security-policy"]).toContain(
      "img-src 'self' data: blob:",
    );
    expect(headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["permissions-policy"]).toMatch(
      /camera=\(\).*microphone=\(\)/u,
    );
  });

  it("pins every third-party Action to an immutable full SHA", async () => {
    for (const workflow of [
      ".github/workflows/ci.yml",
      ".github/workflows/secret-scan.yml",
    ]) {
      const yaml = await read(workflow);
      const uses = [
        ...yaml.matchAll(/^\s*- uses: ([^\s#]+)(?:\s+#\s*(.+))?$/gmu),
      ];
      expect(uses.length).toBeGreaterThan(0);
      for (const [, action, comment] of uses) {
        expect(action).toMatch(
          /^(?:actions\/checkout|actions\/setup-node|pnpm\/action-setup)@[0-9a-f]{40}$/u,
        );
        expect(comment).toMatch(/^v\d/u);
      }
      expect(yaml).not.toMatch(/uses:\s+[^\s]+@v\d/u);
      expect(yaml).toMatch(
        /actions\/checkout@[0-9a-f]{40}\s+#\s+v4\.3\.1[\s\S]*?persist-credentials:\s+false/u,
      );
      expect(yaml).toContain('node-version: "24.19.0"');
    }
  });

  it("declares the exact supported Node and pnpm engines", async () => {
    const packageJson = JSON.parse(await read("package.json"));
    expect(packageJson.packageManager).toBe("pnpm@11.19.0");
    expect(packageJson.engines).toEqual({
      node: "24.19.0",
      pnpm: "11.19.0",
    });
  });
});
