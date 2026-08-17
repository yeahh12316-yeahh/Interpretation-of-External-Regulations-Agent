import "fake-indexeddb/auto";

import { afterEach, expect, test } from "vitest";

import {
  type StoredSessionFile,
  projectDatabase,
} from "./db";
import {
  clearAllSessionFiles,
  deleteSessionFiles,
  getRawFileRetention,
  getSessionFile,
  listSessionFiles,
  restoreSessionFile,
  saveSessionFile,
  setRawFileRetention,
  verifySessionFile,
} from "./session-files";

const sha256Of = async (bytes: ArrayBuffer | Uint8Array): Promise<string> => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const buildFileRecord = async (
  overrides: Partial<StoredSessionFile> = {},
): Promise<StoredSessionFile> => {
  const bytes = new TextEncoder().encode("regulatory-source-bytes").buffer;
  return {
    sourceId: "SRC-regulatory_text-abc",
    projectId: "P1",
    fileHash: await sha256Of(bytes),
    fileName: "rule.pdf",
    fileType: "application/pdf",
    fileSize: bytes.byteLength,
    bytes,
    savedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
};

afterEach(async () => {
  await projectDatabase.sessionFiles.clear();
  await projectDatabase.retentionSettings.clear();
});

test("round-trips a stored source file keyed by sourceId", async () => {
  const record = await buildFileRecord();
  await saveSessionFile(record);

  const stored = await getSessionFile(record.sourceId);
  expect(stored).not.toBeNull();
  expect(stored?.projectId).toBe("P1");
  expect(new Uint8Array(stored!.bytes)).toEqual(new Uint8Array(record.bytes));
  expect(await listSessionFiles("P1")).toHaveLength(1);
  expect(await listSessionFiles("P2")).toHaveLength(0);
});

test("re-saving the same sourceId replaces the previous copy", async () => {
  const first = await buildFileRecord();
  await saveSessionFile(first);
  await saveSessionFile(
    await buildFileRecord({ projectId: "P2", fileName: "rule-v2.pdf" }),
  );

  const stored = await getSessionFile(first.sourceId);
  expect(stored?.projectId).toBe("P2");
  expect(stored?.fileName).toBe("rule-v2.pdf");
  expect(await projectDatabase.sessionFiles.count()).toBe(1);
});

test("verifies byte integrity against the recorded SHA-256", async () => {
  const record = await buildFileRecord();
  await saveSessionFile(record);
  expect(await verifySessionFile(record.sourceId)).toBe(true);

  const tampered = { ...record, fileHash: "0".repeat(64) };
  await saveSessionFile(tampered);
  expect(await verifySessionFile(record.sourceId)).toBe(false);
  expect(await verifySessionFile("SRC-missing")).toBe(false);
});

test("restores a File object whose hash still matches", async () => {
  const record = await buildFileRecord();
  await saveSessionFile(record);

  const file = await restoreSessionFile(record.sourceId);
  expect(file).not.toBeNull();
  expect(file!.name).toBe("rule.pdf");
  expect(file!.type).toBe("application/pdf");
  // jsdom hands back a cross-realm buffer; hash via a fresh local view.
  const restoredView = new Uint8Array(await file!.arrayBuffer());
  expect(await sha256Of(restoredView)).toBe(record.fileHash);
  expect(await restoreSessionFile("SRC-missing")).toBeNull();
});

test("deletes files per project and clears everything", async () => {
  await saveSessionFile(await buildFileRecord());
  await saveSessionFile(
    await buildFileRecord({
      sourceId: "SRC-official_interpretation-xyz",
      projectId: "P2",
    }),
  );

  await deleteSessionFiles("P1");
  expect(await projectDatabase.sessionFiles.count()).toBe(1);

  await clearAllSessionFiles();
  expect(await projectDatabase.sessionFiles.count()).toBe(0);
});

test("raw file retention preference defaults to off and persists", async () => {
  expect(await getRawFileRetention()).toBe(false);

  await setRawFileRetention(true);
  expect(await getRawFileRetention()).toBe(true);

  await setRawFileRetention(false);
  expect(await getRawFileRetention()).toBe(false);
});
