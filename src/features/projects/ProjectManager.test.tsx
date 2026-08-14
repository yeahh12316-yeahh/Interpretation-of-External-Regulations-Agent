import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

import { afterEach, expect, test } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Project } from '../../domain/project';
import { ProjectManager } from './ProjectManager';
import { projectRepository } from './project-repository';

const project = (projectId: string, projectName: string): Project => ({
  projectId,
  projectName,
  workflowStep: 'intake',
  sourceUnits: [],
  parsingCompleted: false,
  findings: [],
  qualityMetrics: {
    factCitationCoverage: 0,
    citationReverseCheckRate: 0,
    unsupportedFindingCount: 0,
    inferenceMarkingRate: 0,
    requiredReviewCompletionRate: 0,
  },
});

afterEach(async () => {
  await projectRepository.clearAll();
});

test('shows the project name before deletion and cancellation preserves the record', async () => {
  await projectRepository.save(project('P1', '待保留项目'));
  render(<ProjectManager />);
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: '删除 待保留项目' }));
  const dialog = screen.getByRole('dialog', { name: '确认删除项目' });
  expect(within(dialog).getByText(/待保留项目/)).toBeVisible();

  await user.click(within(dialog).getByRole('button', { name: '取消' }));

  expect(await projectRepository.load('P1')).not.toBeNull();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('confirmation deletes only the named project', async () => {
  await projectRepository.save(project('P1', '待删除项目'));
  await projectRepository.save(project('P2', '保留项目'));
  render(<ProjectManager />);
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: '删除 待删除项目' }));
  await user.click(
    within(screen.getByRole('dialog', { name: '确认删除项目' })).getByRole('button', {
      name: '确认删除',
    }),
  );

  await waitFor(async () => expect(await projectRepository.load('P1')).toBeNull());
  expect(await projectRepository.load('P2')).not.toBeNull();
});

test('shows the exact project count before clearing and confirmation removes all records', async () => {
  await projectRepository.save(project('P1', '项目一'));
  await projectRepository.save(project('P2', '项目二'));
  render(<ProjectManager />);
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: '清空本地数据' }));
  const dialog = screen.getByRole('dialog', { name: '确认清空本地数据' });
  expect(within(dialog).getByText(/2 个项目/)).toBeVisible();

  await user.click(within(dialog).getByRole('button', { name: '确认清空' }));

  await waitFor(async () => expect(await projectRepository.list()).toEqual([]));
  expect(screen.getByText('暂无本地项目')).toBeVisible();
});
