import { projectDatabase, type StoredSessionFile } from "./db";

/**
 * Opt-in local retention of uploaded source files. The user's browser keeps
 * a verifiable byte copy (SHA-256) next to the parsed session so evidence
 * stays auditable after a restore. Copies live outside the WorkflowSession:
 * session backups stay session-only and credentials/original files are
 * never mixed into one export.
 */

const RETENTION_SETTING_ID = "raw-file-retention" as const;

export const saveSessionFile = (record: StoredSessionFile) =>
  projectDatabase.sessionFiles.put(record);

export const getSessionFile = (
  sourceId: string,
): Promise<StoredSessionFile | undefined> =>
  projectDatabase.sessionFiles.get(sourceId);

export const listSessionFiles = (
  projectId: string,
): Promise<StoredSessionFile[]> =>
  projectDatabase.sessionFiles.where("projectId").equals(projectId).toArray();

export const deleteSessionFiles = (projectId: string) =>
  projectDatabase.sessionFiles.where("projectId").equals(projectId).delete();

export const clearAllSessionFiles = (): Promise<void> =>
  projectDatabase.sessionFiles.clear();

const sha256Of = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** Byte integrity check: stored copy must still hash to fileHash. */
export const verifySessionFile = async (
  sourceId: string,
): Promise<boolean> => {
  const record = await getSessionFile(sourceId);
  if (!record) return false;
  try {
    return (await sha256Of(record.bytes)) === record.fileHash;
  } catch {
    return false;
  }
};

/** Rebuilds a File from the stored copy, or null if it is gone. */
export const restoreSessionFile = async (
  sourceId: string,
): Promise<File | null> => {
  const record = await getSessionFile(sourceId);
  if (!record) return null;
  return new File([record.bytes], record.fileName ?? "source-file", {
    type: record.fileType,
  });
};

export const getRawFileRetention = async (): Promise<boolean> => {
  const setting = await projectDatabase.retentionSettings.get(
    RETENTION_SETTING_ID,
  );
  return setting?.enabled ?? false;
};

export const setRawFileRetention = (enabled: boolean) =>
  projectDatabase.retentionSettings.put({
    id: RETENTION_SETTING_ID,
    enabled,
  });
