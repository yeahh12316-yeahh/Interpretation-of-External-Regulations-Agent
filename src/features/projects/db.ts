import Dexie, { type Table } from "dexie";

import type { Project } from "../../domain/project";

export interface StoredProjectRecord {
  projectId: string;
  project: Project;
  rawFiles: StoredRawFile[];
  updatedAt: string;
}

export interface StoredRawFile {
  bytes: ArrayBuffer;
  type: string;
  name: string | null;
  size: number;
}

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

class ExternalRegulationDatabase extends Dexie {
  projects!: Table<StoredProjectRecord, string>;
  modelPreferences!: Table<StoredModelPreferences, string>;
  workflowSessions!: Table<StoredWorkflowSession, string>;

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
  }
}

export const projectDatabase = new ExternalRegulationDatabase();
