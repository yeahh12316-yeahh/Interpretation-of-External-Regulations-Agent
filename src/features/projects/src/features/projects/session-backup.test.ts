import "fake-indexeddb/auto";

import { afterEach, describe, expect, test } from "vitest";

import { projectDatabase } from "./db";
import { sessionCredentials } from "../model/session-credentials";
import { workflowSessionRepository } from "../../app/workflow-store";
import { stableValue } from "../evidence/evidence-hash";
import {
  SESSION_BACKUP_KIND,
  SESSION_BACKUP_VERSION,
  clearAllSessions,
  createSession,
  deleteSession,
  exportSession,
  importSession,
  listSessions,
} from "./session-backup";
import { buildCompleteSession } from "./__test__/session-fixture";

afterEach(async () => {
  sessionCredentials.clear();
  await projectDatabase.workflowSessions.clear();
  await projectDatabase.sessionFiles.clear();
});

const saveCompleteSession = async () =>
  workflowSessionRepository.save(buildCompleteSession(), 0);

describe("workflow session JSON backup", () => {
  test("exports an allow-listed, byte-identical envelope without credentials", async () => {
    await saveCompleteSession();
    sessionCredentials.set({
      baseUrl: "https://model.example/v1",
      apiKey: "secret-value",
      model: "model-a",
    });

    const first = await exportSession("P-BACKUP");
    const second = await exportSession("P-BACKUP");
    expect(first).toBe(second);

    const backup = JSON.parse(first) as Record<string, unknown>;
    expect(Object.keys(backup).sort()).toEqual(["kind", "session", "version"]);
    expect(backup.version).toBe(SESSION_BACKUP_VERSION);
    expect(backup.kind).toBe(SESSION_BACKUP_KIND);
    expect(first).not.toContain("secret-value");
    expect(first).not.toContain("apiKey");
    expect(first).not.toContain("model.example");

    const session = backup.session as Record<string, unknown>;
    expect(Object.keys(session).sort()).toEqual([
      "analysisVersions",
      "atomicRequirements",
      "contentHash",
      "lastSavedAt",
      "officialPrimarySourceIds",
      "parseResults",
      "parsedUnits",
      "pendingReanalysis",
      "project",
      "reviewActions",
      "reviewAudits",
      "revision",
      "ruleReviewAttestations",
      "selectedFindingId",
      "sessionVersion",
    ]);
    expect(session.reviewAudits).toHaveLength(1);
    expect(session.reviewActions).toHaveLength(1);
    expect(session.ruleReviewAttestations).toHaveLength(1);
    expect(session.analysisVersions).toHaveLength(1);
  });

  test("fails to export a missing project", async () => {
    await expect(exportSession("P-MISSING")).rejects.toThrow(
      "找不到要导出的项目",
    );
  });

  test("round-trips a complete session through export, wipe, and import", async () => {
    const saved = await saveCompleteSession();

    const json = await exportSession("P-BACKUP");
    await projectDatabase.workflowSessions.clear();
    expect(await workflowSessionRepository.load("P-BACKUP")).toBeNull();

    const imported = await importSession(json);
    expect(stableValue(imported)).toBe(stableValue(saved));

    const restored = await workflowSessionRepository.load("P-BACKUP");
    expect(stableValue(restored)).toBe(stableValue(saved));
    const record = await projectDatabase.workflowSessions.get("P-BACKUP");
    expect(record?.revision).toBe(saved.revision);
  });

  test("rejects malformed envelopes without writing anything", async () => {
    const cases: [string, string, unknown][] = [
      ["not json", "备份文件不是有效 JSON", "not json"],
      [
        "non-object",
        "备份文件格式无效",
        JSON.stringify("just a string"),
      ],
      [
        "unsupported version",
        "不支持的备份版本",
        JSON.stringify({
          version: 1,
          kind: SESSION_BACKUP_KIND,
          session: {},
        }),
      ],
      [
        "wrong kind",
        "备份文件格式无效",
        JSON.stringify({
          version: SESSION_BACKUP_VERSION,
          kind: "project-snapshot",
          session: {},
        }),
      ],
      [
        "extra envelope key",
        "备份文件格式无效",
        JSON.stringify({
          version: SESSION_BACKUP_VERSION,
          kind: SESSION_BACKUP_KIND,
          apiKey: "secret-value",
          session: {},
        }),
      ],
      [
        "session not object",
        "备份文件格式无效",
        JSON.stringify({
          version: SESSION_BACKUP_VERSION,
          kind: SESSION_BACKUP_KIND,
          session: "P-BACKUP",
        }),
      ],
    ];
    for (const [name, message, json] of cases) {
      await expect(importSession(json as string), name).rejects.toThrow(
        message,
      );
    }
    expect(await listSessions()).toEqual([]);
  });

  test("rejects a tampered session before writing anything", async () => {
    const saved = await saveCompleteSession();
    const backup = JSON.parse(await exportSession("P-BACKUP")) as {
      session: Record<string, unknown>;
    };
    const session = backup.session as {
      project: { findings: { statement: string }[] };
    };
    session.project.findings[0].statement = "伪造的监管结论";

    let message = "";
    try {
      await importSession(JSON.stringify(backup));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("伪造的监管结论");
    expect(
      (await listSessions()).map(({ projectId }) => projectId),
    ).toEqual(["P-BACKUP"]);
    const untouched = await workflowSessionRepository.load("P-BACKUP");
    expect(
      untouched?.project.findings[0].statement,
    ).toBe(saved.project.findings[0].statement);
  });

  test("refuses to import over an existing project without overwriting it", async () => {
    const saved = await saveCompleteSession();
    const json = await exportSession("P-BACKUP");

    await expect(importSession(json)).rejects.toThrow("同名项目已存在");
    const current = await workflowSessionRepository.load("P-BACKUP");
    expect(current?.revision).toBe(saved.revision);
  });

  test("lists, creates, and deletes workflow sessions", async () => {
    await saveCompleteSession();
    await createSession("P-NEW", "新项目");

    const summaries = await listSessions();
    expect(summaries.map(({ projectId }) => projectId).sort()).toEqual([
      "P-BACKUP",
      "P-NEW",
    ]);
    const backupSummary = summaries.find(
      ({ projectId }) => projectId === "P-BACKUP",
    );
    expect(backupSummary).toMatchObject({
      projectName: "备份项目",
      workflowStep: "review",
      revision: 1,
      findingCount: 1,
    });
    const newSummary = summaries.find(
      ({ projectId }) => projectId === "P-NEW",
    );
    expect(newSummary).toMatchObject({
      projectName: "新项目",
      workflowStep: "intake",
      findingCount: 0,
    });

    await deleteSession("P-NEW");
    expect((await listSessions()).map(({ projectId }) => projectId)).toEqual([
      "P-BACKUP",
    ]);

    await clearAllSessions();
    expect(await listSessions()).toEqual([]);
  });

  test("deleting a session also removes its retained raw file copies", async () => {
    await saveCompleteSession();
    await createSession("P-NEW", "新项目");
    const retainedFile = {
      fileHash: "a".repeat(64),
      fileName: "rule.pdf",
      fileType: "application/pdf",
      fileSize: 1,
      bytes: new ArrayBuffer(1),
      savedAt: "2026-08-17T00:00:00.000Z",
    };
    await projectDatabase.sessionFiles.bulkPut([
      { ...retainedFile, sourceId: "SRC-A", projectId: "P-BACKUP" },
      { ...retainedFile, sourceId: "SRC-B", projectId: "P-NEW" },
    ]);

    await deleteSession("P-BACKUP");
    expect(
      (await projectDatabase.sessionFiles.toArray()).map(
        ({ sourceId }) => sourceId,
      ),
    ).toEqual(["SRC-B"]);

    await clearAllSessions();
    expect(await projectDatabase.sessionFiles.count()).toBe(0);
  });
});
