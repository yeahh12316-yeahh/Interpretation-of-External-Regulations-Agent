import Dexie, { type Table } from "dexie";

/**
 * Legacy v1 snapshot table. The v1 repository path was removed; the Dexie
 * version declaration must stay so existing user databases can still
 * upgrade through the declared schema history.
 */
export type StoredProjectRecord = { projectId: string };

export interface StoredModelPreferences {
  id: "model-endpoint";
  baseUrl: string;
  model: string;
}

export interface StoredWorkflowSession {
  projectId: string;
  session: unknown;
  revision: number;
  updatedAt: string;
}

/**
 * Opt-in local copy of an uploaded source file. Never part of the
 * WorkflowSession (backup JSON stays session-only); the SHA-256 fileHash
 * lets restores verify byte integrity against the parse result.
 */
export interface StoredSessionFile {
  sourceId: string;
  projectId: string;
  fileHash: string;
  fileName: string | null;
  fileType: string;
  fileSize: number;
  bytes: ArrayBuffer;
  savedAt: string;
}

export interface StoredRetentionSetting {
  id: "raw-file-retention";
  enabled: boolean;
}

/**
 * Transient resume point for a running analysis. Kept outside the
 * WorkflowSession on purpose: it is runtime state, not review evidence,
 * so it never joins the session hash or backups.
 */
export interface StoredAnalysisCheckpoint {
  projectId: string;
  checkpoint: unknown;
  updatedAt: string;
}

class ExternalRegulationDatabase extends Dexie {
  projects!: Table<StoredProjectRecord, string>;
  modelPreferences!: Table<StoredModelPreferences, string>;
  workflowSessions!: Table<StoredWorkflowSession, string>;
  sessionFiles!: Table<StoredSessionFile, string>;
  retentionSettings!: Table<StoredRetentionSetting, string>;
  analysisCheckpoints!: Table<StoredAnalysisCheckpoint, string>;

  constructor() {
    super("external-regulation-agent");
    this.version(1).stores({
      projects: "projectId, updatedAt",
      modelPreferences: "id",
    });
    this.version(2).stores({
      projects: "projectId, updatedAt",
      modelPreferences: "id",
      workflowSessions: "projectId, updatedAt",
    });
    this.version(3).stores({
      projects: "projectId, updatedAt",
      modelPreferences: "id",
      workflowSessions: "projectId, revision, updatedAt",
    });
    this.version(4).stores({
      projects: "projectId, updatedAt",
      modelPreferences: "id",
      workflowSessions: "projectId, revision, updatedAt",
      sessionFiles: "sourceId, projectId",
      retentionSettings: "id",
    });
    this.version(5).stores({
      projects: "projectId, updatedAt",
      modelPreferences: "id",
      workflowSessions: "projectId, revision, updatedAt",
      sessionFiles: "sourceId, projectId",
      retentionSettings: "id",
      analysisCheckpoints: "projectId",
    });
  }
}

export const projectDatabase = new ExternalRegulationDatabase();
