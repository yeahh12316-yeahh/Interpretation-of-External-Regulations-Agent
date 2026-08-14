import 'fake-indexeddb/auto';

import { afterEach, describe, expect, test } from 'vitest';

import type { Project } from '../../domain/project';
import { sessionCredentials } from '../model/session-credentials';
import { exportProject, importProject } from './project-backup';
import { projectRepository } from './project-repository';

const validProject: Project = {
  projectId: 'P-BACKUP',
  projectName: '备份项目',
  workflowStep: 'analysis',
  sourceUnits: [],
  parsingCompleted: true,
  findings: [],
  qualityMetrics: {
    factCitationCoverage: 1,
    citationReverseCheckRate: 1,
    unsupportedFindingCount: 0,
    inferenceMarkingRate: 1,
    requiredReviewCompletionRate: 1,
  },
};

afterEach(async () => {
  sessionCredentials.clear();
  await projectRepository.clearAll();
});

describe('project JSON backup', () => {
  test('exports an allow-listed project without credentials or raw source files', async () => {
    sessionCredentials.set({
      baseUrl: 'https://model.example/v1',
      apiKey: 'secret-value',
      model: 'model-a',
    });
    await projectRepository.save(
      { ...validProject, rawFiles: [new Blob(['raw'])] },
      { persistRawFiles: true },
    );

    const json = await exportProject('P-BACKUP');
    const backup = JSON.parse(json) as Record<string, unknown>;

    expect(backup).toEqual({ version: 1, project: validProject });
    expect(json).not.toContain('secret-value');
    expect(json).not.toContain('rawFiles');
  });

  test('imports a supported, schema-valid backup into the repository', async () => {
    const restored = await importProject(JSON.stringify({ version: 1, project: validProject }));

    expect(restored).toEqual(validProject);
    expect(await projectRepository.load('P-BACKUP')).toEqual({
      ...validProject,
      rawFiles: [],
    });
  });

  test('rejects unsupported versions before writing anything', async () => {
    await expect(
      importProject(JSON.stringify({ version: 2, project: validProject })),
    ).rejects.toThrow('不支持的备份版本');

    expect(await projectRepository.load('P-BACKUP')).toBeNull();
  });

  test('rejects schema-invalid imports without exposing secret input in the error', async () => {
    const json = JSON.stringify({
      version: 1,
      project: { ...validProject, apiKey: 'secret-value' },
    });

    let message = '';
    try {
      await importProject(json);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('备份项目数据无效');
    expect(message).not.toContain('secret-value');
    expect(await projectRepository.load('P-BACKUP')).toBeNull();
  });

  test('rejects non-allow-listed backup envelope fields without exposing their value', async () => {
    const json = JSON.stringify({
      version: 1,
      project: validProject,
      apiKey: 'secret-value',
    });

    let message = '';
    try {
      await importProject(json);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('备份文件格式无效');
    expect(message).not.toContain('secret-value');
    expect(await projectRepository.load('P-BACKUP')).toBeNull();
  });
});
