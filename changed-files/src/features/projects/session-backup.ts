import { projectDatabase } from "./db";
import {
  clearAllSessionFiles,
  deleteSessionFiles,
} from "./session-files";
import {
  createEmptyWorkflowSession,
  parseSession,
  workflowSessionRepository,
  type WorkflowSession,
} from "../../app/workflow-store";

/**
 * Full-fidelity workflow session backup. Unlike the legacy project snapshot
 * backup, this serializes the complete WorkflowSession — parse results,
 * analysis version chains, review audits, actions, and rule attestations —
 * so an imported backup passes the identical strict restore validation
 * (`parseSession`) used when loading from IndexedDB.
 *
 * Trust boundaries:
 * - The exported envelope is key-allow-listed; API keys never appear because
 *   sessions never contain credentials.
 * - Imports are rejected (fail-closed) on envelope tampering, session hash
 *   mismatch, or audit-chain inconsistency before anything is written.
 * - Importing over an existing projectId is refused; delete it first.
 */

export const SESSION_BACKUP_VERSION = 2;
export const SESSION_BACKUP_KIND = "workflow-session" as const;

const SESSION_KEYS = [
  "sessionVersion",
  "contentHash",
  "revision",
  "project",
  "parseResults",
  "parsedUnits",
  "atomicRequirements",
  "reviewAudits",
  "reviewActions",
  "ruleReviewAttestations",
  "analysisVersions",
  "pendingReanalysis",
  "officialPrimarySourceIds",
  "selectedFindingId",
  "lastSavedAt",
] as const satisfies (keyof WorkflowSession)[];

const pickSession = (session: WorkflowSession): WorkflowSession =>
  Object.fromEntries(
    SESSION_KEYS.map((key) => [key, session[key]]),
  ) as unknown as WorkflowSession;

const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const exportSession = async (
  projectId: string,
): Promise<string> => {
  const stored = await projectDatabase.workflowSessions.get(projectId);
  if (!stored) throw new Error("找不到要导出的项目");
  const session = parseSession(stored.session);
  if (stored.revision !== session.revision)
    throw new Error("工作流存储 revision 与内容不一致");
  return JSON.stringify({
    version: SESSION_BACKUP_VERSION,
    kind: SESSION_BACKUP_KIND,
    session: pickSession(session),
  });
};

export const importSession = async (
  json: string,
): Promise<WorkflowSession> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("备份文件不是有效 JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("备份文件格式无效");
  if (parsed.version !== SESSION_BACKUP_VERSION)
    throw new Error("不支持的备份版本");
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 3 ||
    keys.join(",") !== "kind,session,version" ||
    parsed.kind !== SESSION_BACKUP_KIND ||
    !isPlainObject(parsed.session)
  )
    throw new Error("备份文件格式无效");

  const session = parseSession(parsed.session);
  const existing = await projectDatabase.workflowSessions.get(
    session.project.projectId,
  );
  if (existing)
    throw new Error("同名项目已存在；请先删除本地同名项目再导入");
  await projectDatabase.workflowSessions.put({
    projectId: session.project.projectId,
    session,
    revision: session.revision,
    updatedAt: new Date().toISOString(),
  });
  return structuredClone(session);
};

export interface SessionSummary {
  projectId: string;
  projectName: string;
  workflowStep: WorkflowSession["project"]["workflowStep"];
  revision: number;
  updatedAt: string;
  findingCount: number;
}

export const listSessions = async (): Promise<SessionSummary[]> => {
  const records = await projectDatabase.workflowSessions
    .orderBy("updatedAt")
    .reverse()
    .toArray();
  return records.flatMap((record) => {
    // Listing is intentionally lightweight: rows stay visible even when a
    // stored payload is malformed, with defensive fallbacks, so the user can
    // still see (and delete) broken records; restore itself fails closed.
    const session = record.session as WorkflowSession | null;
    if (!session || typeof session !== "object" || !session.project) return [];
    return [
      {
        projectId: record.projectId,
        projectName: session.project.projectName ?? record.projectId,
        workflowStep: session.project.workflowStep ?? "unknown",
        revision: record.revision,
        updatedAt: record.updatedAt,
        findingCount: session.project.findings?.length ?? 0,
      },
    ];
  });
};

export const deleteSession = async (projectId: string): Promise<void> => {
  await projectDatabase.workflowSessions.delete(projectId);
  // Retained raw-file copies belong to the session; never outlive it.
  await deleteSessionFiles(projectId);
};

export const clearAllSessions = async (): Promise<void> => {
  await projectDatabase.workflowSessions.clear();
  await clearAllSessionFiles();
};

export const createSession = (
  projectId: string,
  projectName: string,
): Promise<WorkflowSession> =>
  workflowSessionRepository.save(
    createEmptyWorkflowSession(projectId, projectName),
    0,
  );
