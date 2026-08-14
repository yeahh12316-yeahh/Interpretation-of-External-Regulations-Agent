import type { Project } from '../../domain/project';
import { ProjectSchema } from '../../domain/schemas';
import { projectDatabase, type StoredRawFile } from './db';

export type RawFile = Blob & { readonly name?: string };
export type ProjectWithRawFiles = Project & { rawFiles: RawFile[] };
export type ProjectSaveInput = Project & { rawFiles?: readonly Blob[] };

export interface SaveProjectOptions {
  persistRawFiles?: boolean;
}

const validatedProjectFromInput = (input: ProjectSaveInput): Project => {
  const { rawFiles: _rawFiles, ...projectFields } = input;
  return ProjectSchema.parse(projectFields);
};

const selectedRawFiles = async (
  input: ProjectSaveInput,
  options: SaveProjectOptions,
): Promise<StoredRawFile[]> => {
  if (!options.persistRawFiles) {
    return [];
  }

  const rawFiles = input.rawFiles ?? [];
  if (rawFiles.some((file) => !(file instanceof Blob))) {
    throw new Error('原文件必须是 Blob');
  }
  return Promise.all(
    rawFiles.map(async (file) => ({
      bytes: await file.arrayBuffer(),
      type: file.type,
      name: 'name' in file && typeof file.name === 'string' ? file.name : null,
      size: file.size,
    })),
  );
};

const restoreRawFile = (stored: StoredRawFile): RawFile => {
  if (stored.bytes.byteLength !== stored.size) {
    throw new Error('本地原文件数据无效');
  }

  if (stored.name !== null && typeof File !== 'undefined') {
    return new File([stored.bytes], stored.name, { type: stored.type });
  }
  return new Blob([stored.bytes], { type: stored.type });
};

export const projectRepository = {
  async save(input: ProjectSaveInput, options: SaveProjectOptions = {}): Promise<ProjectWithRawFiles> {
    const project = validatedProjectFromInput(input);
    const storedRawFiles = await selectedRawFiles(input, options);

    await projectDatabase.projects.put({
      projectId: project.projectId,
      project,
      rawFiles: storedRawFiles,
      updatedAt: new Date().toISOString(),
    });

    return { ...project, rawFiles: storedRawFiles.map(restoreRawFile) };
  },

  async load(projectId: string): Promise<ProjectWithRawFiles | null> {
    const record = await projectDatabase.projects.get(projectId);
    if (!record) {
      return null;
    }

    const project = ProjectSchema.parse(record.project);
    return { ...project, rawFiles: (record.rawFiles ?? []).map(restoreRawFile) };
  },

  async list(): Promise<ProjectWithRawFiles[]> {
    const records = await projectDatabase.projects.orderBy('updatedAt').reverse().toArray();
    return records.map((record) => ({
      ...ProjectSchema.parse(record.project),
      rawFiles: (record.rawFiles ?? []).map(restoreRawFile),
    }));
  },

  async delete(projectId: string): Promise<void> {
    await projectDatabase.projects.delete(projectId);
  },

  async clearAll(): Promise<void> {
    await projectDatabase.projects.clear();
  },
};
