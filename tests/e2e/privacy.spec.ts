import { expect, test } from "@playwright/test";

import {
  installSuccessfulModelRoute,
  uploadAndAnalyze,
} from "./support/production-flow";

test("BYOK survives only in the permitted session credential boundary", async ({
  page,
}) => {
  const apiKey = "task11-secret-key-must-not-leak";
  const logs: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  await installSuccessfulModelRoute(page);
  await uploadAndAnalyze(page, apiKey);

  const beforeReload = await page.evaluate(
    (secret) => ({
      keyInSession: Object.values(sessionStorage).some((value) =>
        value.includes(secret),
      ),
      local: JSON.stringify({ ...localStorage }),
      url: location.href,
      dom: document.body.textContent ?? "",
    }),
    apiKey,
  );
  expect(beforeReload.keyInSession).toBe(true);
  expect(beforeReload.local).not.toContain(apiKey);
  expect(beforeReload.url).not.toContain(apiKey);
  expect(beforeReload.dom).not.toContain(apiKey);

  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "已自动恢复" }),
  ).toBeVisible();
  const persisted = await page.evaluate(async (secret) => {
    const [{ projectDatabase }, { projectRepository }, { exportProject }] =
      await Promise.all([
        import("/src/features/projects/db.ts"),
        import("/src/features/projects/project-repository.ts"),
        import("/src/features/projects/project-backup.ts"),
      ]);
    const workflow = (await projectDatabase.workflowSessions.toArray()).at(-1);
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
      indexedDb: JSON.stringify(databases),
      local: JSON.stringify({ ...localStorage }),
      backup,
      url: location.href,
      dom: document.body.textContent ?? "",
    };
  }, apiKey);
  expect(persisted.keyInSession).toBe(true);
  for (const surface of [
    persisted.indexedDb,
    persisted.local,
    persisted.backup,
    persisted.url,
    persisted.dom,
    logs.join("\n"),
    errors.join("\n"),
  ]) {
    expect(surface).not.toContain(apiKey);
  }
  expect(errors).toEqual([]);
});
