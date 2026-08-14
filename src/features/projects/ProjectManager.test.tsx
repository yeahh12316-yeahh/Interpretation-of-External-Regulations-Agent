import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

import { afterEach, expect, test } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Project } from '../../domain/project';
import { ProjectManager } from './ProjectManager';
import { projectRepository } from './project-repository';

const acceptRestore = () => undefined;

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
  render(<ProjectManager onRestore={acceptRestore} />);
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
  render(<ProjectManager onRestore={acceptRestore} />);
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
  render(<ProjectManager onRestore={acceptRestore} />);
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: '清空本地数据' }));
  const dialog = screen.getByRole('dialog', { name: '确认清空本地数据' });
  expect(within(dialog).getByText(/2 个项目/)).toBeVisible();

  await user.click(within(dialog).getByRole('button', { name: '确认清空' }));

  await waitFor(async () => expect(await projectRepository.list()).toEqual([]));
  expect(screen.getByText('暂无本地项目')).toBeVisible();
});

test('reports restore success only after the required restore callback completes', async () => {
  await projectRepository.save(project('P1', '异步恢复项目'));
  let completeRestore!: () => void;
  const restoreCompletion = new Promise<void>((resolve) => {
    completeRestore = resolve;
  });
  render(<ProjectManager onRestore={() => restoreCompletion} />);
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: '恢复 异步恢复项目' }));

  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  completeRestore();
  expect(await screen.findByRole('status')).toHaveTextContent('已恢复项目：异步恢复项目');
});

test('reports restore failure without showing a false success message', async () => {
  await projectRepository.save(project('P1', '恢复失败项目'));
  render(
    <ProjectManager
      onRestore={async () => {
        throw new Error('restore rejected');
      }}
    />,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: '恢复 恢复失败项目' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('无法恢复项目');
  expect(screen.queryByText('已恢复项目：恢复失败项目')).not.toBeInTheDocument();
});
