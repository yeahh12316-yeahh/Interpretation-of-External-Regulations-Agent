import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanPaths } from "./scan-secrets";

describe("scanPaths", () => {
  it("reports exact forbidden needles and credential-shaped values reproducibly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-scan-"));
    await writeFile(path.join(root, "safe.js"), "const value = 'safe';\n");
    expect(await scanPaths([root], ["private-endpoint.example"])).toEqual([]);

    await writeFile(
      path.join(root, "leak.js"),
      "const key = 'sk-abcdefghijklmnopqrstuvwxyz123456';\nconst endpoint = 'private-endpoint.example';\n",
    );
    expect(await scanPaths([root], ["private-endpoint.example"])).toEqual([
      expect.stringMatching(/leak\.js:credential_pattern/u),
      expect.stringMatching(/leak\.js:forbidden_needle/u),
    ]);
  });
});
