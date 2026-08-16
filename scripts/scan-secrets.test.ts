import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { Document, Packer, Paragraph } from "docx";

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

  it("scans NUL-containing binaries, PDF bytes, and compressed DOCX entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-binary-"));
    const validPdf = await readFile(
      path.resolve("tests/fixtures/benchmark/sources/regulatory-scan.pdf"),
    );
    await writeFile(
      path.join(root, "nul.pdf"),
      Buffer.concat([
        validPdf,
        Buffer.from("\n%", "ascii"),
        Buffer.from([0, 1, 2]),
        Buffer.from("private-endpoint.example\n", "ascii"),
      ]),
    );
    const docx = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("sk-abcdefghijklmnopqrstuvwxyz123456"),
            ],
          },
        ],
      }),
    );
    await writeFile(path.join(root, "compressed.docx"), docx);

    await expect(
      scanPaths([root], ["private-endpoint.example"]),
    ).resolves.toEqual([
      expect.stringMatching(/compressed\.docx:credential_pattern/u),
      expect.stringMatching(/nul\.pdf:forbidden_needle/u),
    ]);
  });

  it("fails closed when a required scan root is missing and accepts clean assets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "secret-clean-"));
    await writeFile(path.join(root, "clean.bin"), Buffer.from([0, 1, 2, 3]));
    await expect(scanPaths([root])).resolves.toEqual([]);
    await expect(
      scanPaths([path.join(root, "missing-dist")]),
    ).rejects.toThrow(/required scan root/u);
  });
});
