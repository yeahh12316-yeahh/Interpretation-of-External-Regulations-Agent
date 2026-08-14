import 'fake-indexeddb/auto';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Project } from '../../domain/project';
import { sessionCredentials } from '../model/session-credentials';
import { modelPreferences } from './model-preferences';
import { projectRepository } from './project-repository';

const project = (projectId = 'P1', projectName = '外规解读'): Project => ({
  projectId,
  projectName,
  workflowStep: 'review',
  sourceUnits: [
    {
      sourceId: 'SRC-1',
      sourceType: 'regulatory_text',
      title: '监管文件',
      content: '金融机构应当建立相关制度。',
    },
  ],
  parsingCompleted: true,
  findings: [
    {
      findingId: 'F1',
      category: '治理',
      statement: '应建立制度',
      claimType: 'regulatory_fact',
      sourceAnchors: [
        {
          sourceId: 'SRC-1',
          sourceType: 'regulatory_text',
          page: 1,
          article: '第一条',
          paragraphIndex: 0,
          quote: '金融机构应当建立相关制度。',
        },
      ],
      inferenceParents: [],
      reviewStatus: 'confirmed',
      requiredReview: true,
      revisionRecords: [],
    },
  ],
  qualityMetrics: {
    factCitationCoverage: 1,
    citationReverseCheckRate: 1,
    unsupportedFindingCount: 0,
    inferenceMarkingRate: 1,
    requiredReviewCompletionRate: 1,
  },
});

afterEach(async () => {
  sessionCredentials.clear();
  await projectRepository.clearAll();
  await modelPreferences.clear();
});

describe('projectRepository', () => {
  test('validates projects and keeps raw source files out of storage by default', async () => {
    const rawFile = new Blob(['sensitive original'], { type: 'text/plain' });
    const arrayBufferRead = vi.spyOn(rawFile, 'arrayBuffer');

    await projectRepository.save({ ...project(), rawFiles: [rawFile] });

    const loaded = await projectRepository.load('P1');
    expect(loaded?.rawFiles).toEqual([]);
    expect(loaded?.projectName).toBe('外规解读');
    expect(arrayBufferRead).not.toHaveBeenCalled();
  });

  test('round-trips explicitly retained raw file bytes and metadata', async () => {
    const rawFile = new File([new Uint8Array([0, 1, 2, 254, 255])], '监管原文.bin', {
      type: 'application/octet-stream',
    });

    await projectRepository.save(
      { ...project(), rawFiles: [rawFile] },
      { persistRawFiles: true },
    );

    const loaded = await projectRepository.load('P1');
    expect(loaded?.rawFiles).toHaveLength(1);
    expect(loaded?.rawFiles[0]).toBeInstanceOf(Blob);
    expect(loaded?.rawFiles[0]).toMatchObject({
      name: '监管原文.bin',
      size: 5,
      type: 'application/octet-stream',
    });
    expect(Array.from(new Uint8Array(await loaded!.rawFiles[0].arrayBuffer()))).toEqual([
      0, 1, 2, 254, 255,
    ]);
  });

  test('rejects a project that violates the evidence schema', async () => {
    const invalid = {
      ...project(),
      findings: [{ ...project().findings[0], sourceAnchors: [] }],
    };

    await expect(projectRepository.save(invalid)).rejects.toThrow();
    expect(await projectRepository.load('P1')).toBeNull();
  });

  test('never mixes session API credentials into project persistence', async () => {
    sessionCredentials.set({
      baseUrl: 'https://model.example/v1',
      apiKey: 'secret-value',
      model: 'model-a',
    });

    await projectRepository.save(project());

    expect(JSON.stringify(await projectRepository.load('P1'))).not.toContain('secret-value');
  });

  test('deletes one project without affecting the others and can clear all projects', async () => {
    await projectRepository.save(project('P1', '项目一'));
    await projectRepository.save(project('P2', '项目二'));

    await projectRepository.delete('P1');
    expect(await projectRepository.load('P1')).toBeNull();
    expect(await projectRepository.load('P2')).not.toBeNull();

    await projectRepository.clearAll();
    expect(await projectRepository.list()).toEqual([]);
  });
});

describe('modelPreferences', () => {
  test('does not persist endpoint preferences unless remembering is explicitly enabled', async () => {
    await modelPreferences.save(
      { baseUrl: 'https://model.example/v1', model: 'model-a' },
      { remember: false },
    );

    expect(await modelPreferences.load()).toBeNull();
  });

  test('persists only the allowed endpoint fields when remembering is enabled', async () => {
    await modelPreferences.save(
      {
        baseUrl: 'https://model.example/v1',
        model: 'model-a',
        apiKey: 'secret-value',
      } as { baseUrl: string; model: string },
      { remember: true },
    );

    const stored = await modelPreferences.load();
    expect(stored).toEqual({ baseUrl: 'https://model.example/v1', model: 'model-a' });
    expect(JSON.stringify(stored)).not.toContain('secret-value');
  });
});
