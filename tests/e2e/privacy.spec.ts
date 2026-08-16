import { expect, test } from "../../playwright-fixtures";

import {
  downloadReport,
  installSuccessfulModelRoute,
  reviewAllFindings,
  uploadAndAnalyze,
} from "./support/production-flow";

test("BYOK survives only in the permitted session credential boundary", async ({
  page,
}) => {
  const apiKey = "task11-secret-key-must-not-leak";
  const endpoint = "https://privacy-endpoint.example/v1";
  const logs: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  await installSuccessfulModelRoute(page, endpoint);
  await uploadAndAnalyze(page, apiKey, endpoint);

  const beforeReload = await page.evaluate(
    ([secret, endpoint]) => ({
      keyInSession: Object.values(sessionStorage).some((value) =>
        value.includes(secret),
      ),
      endpointInSession: Object.values(sessionStorage).some((value) =>
        value.includes(endpoint),
      ),
      local: JSON.stringify({ ...localStorage }),
      url: location.href,
      dom: document.body.textContent ?? "",
    }),
    [apiKey, endpoint],
  );
  expect(beforeReload.keyInSession).toBe(true);
  expect(beforeReload.endpointInSession).toBe(true);
  for (const secret of [apiKey, endpoint]) {
    expect(beforeReload.local).not.toContain(secret);
    expect(beforeReload.url).not.toContain(secret);
    expect(beforeReload.dom).not.toContain(secret);
  }

  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "已自动恢复" }),
  ).toBeVisible();
  const persisted = await page.evaluate(
    async ([secret, endpoint]) => {
      const [{ projectDatabase }, { projectRepository }, { exportProject }] =
        await Promise.all([
          import("/src/features/projects/db.ts"),
          import("/src/features/projects/project-repository.ts"),
          import("/src/features/projects/project-backup.ts"),
        ]);
      const workflow = (await projectDatabase.workflowSessions.toArray()).at(
        -1,
      );
      if (!workflow) throw new Error("workflow session missing");
      const project = (workflow.session as { project: never }).project;
      await projectRepository.save(project);
      const backup = await exportProject(
        (project as { projectId: string }).projectId,
      );
      const databases: unknown[] = [];
      for (const descriptor of await indexedDB.databases()) {
        if (!descriptor.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(descriptor.name!);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        for (const storeName of [...db.objectStoreNames]) {
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const transaction = db.transaction(storeName, "readonly");
            const request = transaction.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          databases.push(...values);
        }
        db.close();
      }
      return {
        keyInSession: Object.values(sessionStorage).some((value) =>
          value.includes(secret),
        ),
        endpointInSession: Object.values(sessionStorage).some((value) =>
          value.includes(endpoint),
        ),
        indexedDb: JSON.stringify(databases),
        local: JSON.stringify({ ...localStorage }),
        backup,
        url: location.href,
        dom: document.body.textContent ?? "",
      };
    },
    [apiKey, endpoint] as const,
  );
  expect(persisted.keyInSession).toBe(true);
  expect(persisted.endpointInSession).toBe(true);

  await page.getByRole("button", { name: "确认 F1" }).click();
  await reviewAllFindings(page);
  await page.getByRole("button", { name: "下一步" }).click();
  const fullDocx = await downloadReport(page, "下载 DOCX", "docx");
  const fullPdf = await downloadReport(page, "下载 PDF", "pdf");
  await page.getByRole("tab", { name: "新规快评" }).click();
  const quickDocx = await downloadReport(page, "下载 DOCX", "docx");
  const quickPdf = await downloadReport(page, "下载 PDF", "pdf");
  const docxSurfaces = [fullDocx, quickDocx].flatMap((report) =>
    [...(report.archiveEntries ?? new Map())]
      .filter(
        ([name]) =>
          name.endsWith(".xml") ||
          name.endsWith(".rels") ||
          name.startsWith("docProps/"),
      )
      .map(([name, bytes]) => `${name}\n${bytes.toString("utf8")}`),
  );
  const pdfSurfaces = [fullPdf, quickPdf].flatMap((report) => [
    report.bytes.toString("latin1"),
    report.text,
  ]);
  for (const secret of [apiKey, endpoint]) {
    for (const surface of [
      persisted.indexedDb,
      persisted.local,
      persisted.backup,
      persisted.url,
      persisted.dom,
      logs.join("\n"),
      errors.join("\n"),
      ...docxSurfaces,
      ...pdfSurfaces,
    ]) {
      expect(surface).not.toContain(secret);
    }
  }
  expect(errors).toEqual([]);
});
