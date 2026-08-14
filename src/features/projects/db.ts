import Dexie, { type Table } from 'dexie';

import type { Project } from '../../domain/project';

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
  id: 'model-endpoint';
  baseUrl: string;
  model: string;
}

class ExternalRegulationDatabase extends Dexie {
  projects!: Table<StoredProjectRecord, string>;
  modelPreferences!: Table<StoredModelPreferences, string>;

  constructor() {
    super('external-regulation-agent');
    this.version(1).stores({
      projects: 'projectId, updatedAt',
      modelPreferences: 'id',
    });
  }
}

export const projectDatabase = new ExternalRegulationDatabase();
