import { type ChangeEvent, type JSX, useEffect, useState } from 'react';

import type { Project } from '../../domain/project';
import { exportProject, importProject } from './project-backup';
import { projectRepository, type ProjectWithRawFiles } from './project-repository';

interface ProjectManagerProps {
  onRestore: (project: ProjectWithRawFiles) => void | Promise<void>;
}

type Confirmation =
  | { kind: 'delete'; projectId: string; projectName: string }
  | { kind: 'clear'; projectCount: number }
  | null;

const safeDownloadPart = (value: string) => value.replace(/[^\p{L}\p{N}._-]+/gu, '-');

export function ProjectManager({ onRestore }: ProjectManagerProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectWithRawFiles[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refreshProjects = async () => {
    setProjects(await projectRepository.list());
  };

  useEffect(() => {
    void refreshProjects().catch(() => setError('无法读取本地项目'));
  }, []);

  const restore = async (projectId: string) => {
    setNotice('');
    setError('');
    try {
      const restored = await projectRepository.load(projectId);
      if (!restored) {
        setError('项目不存在或已被删除');
        return;
      }
      await onRestore(restored);
      setNotice(`已恢复项目：${restored.projectName}`);
    } catch {
      setNotice('');
      setError('无法恢复项目');
    }
  };

  const downloadBackup = async (project: ProjectWithRawFiles) => {
    try {
      const json = await exportProject(project.projectId);
      const objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${safeDownloadPart(project.projectName)}.json`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setNotice(`已导出项目：${project.projectName}`);
      setError('');
    } catch {
      setError('无法导出项目');
    }
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    try {
      const restored = await importProject(await file.text());
      await refreshProjects();
      setNotice(`已导入项目：${restored.projectName}`);
      setError('');
    } catch {
      setError('无法导入备份，请检查版本和项目数据');
    }
  };

  const confirmDestructiveAction = async () => {
    if (!confirmation) {
      return;
    }

    try {
      if (confirmation.kind === 'delete') {
        await projectRepository.delete(confirmation.projectId);
      } else {
        await projectRepository.clearAll();
      }
      setConfirmation(null);
      setError('');
      await refreshProjects();
    } catch {
      setError('本地数据操作失败');
    }
  };

  return (
    <section aria-labelledby="project-manager-title">
      <h2 id="project-manager-title">本地项目</h2>

      <div>
        <label>
          导入 JSON
          <input accept="application/json,.json" onChange={importBackup} type="file" />
        </label>
        <button
          disabled={projects.length === 0}
          onClick={() => setConfirmation({ kind: 'clear', projectCount: projects.length })}
          type="button"
        >
          清空本地数据
        </button>
      </div>

      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      {projects.length === 0 ? (
        <p>暂无本地项目</p>
      ) : (
        <ul>
          {projects.map((project) => (
            <li key={project.projectId}>
              <span>{project.projectName}</span>
              <button onClick={() => void restore(project.projectId)} type="button">
                恢复 {project.projectName}
              </button>
              <button onClick={() => void downloadBackup(project)} type="button">
                导出 JSON {project.projectName}
              </button>
              <button
                onClick={() =>
                  setConfirmation({
                    kind: 'delete',
                    projectId: project.projectId,
                    projectName: project.projectName,
                  })
                }
                type="button"
              >
                删除 {project.projectName}
              </button>
            </li>
          ))}
        </ul>
      )}

      {confirmation?.kind === 'delete' ? (
        <div aria-labelledby="delete-project-title" aria-modal="true" role="dialog">
          <h3 id="delete-project-title">确认删除项目</h3>
          <p>将删除项目“{confirmation.projectName}”，删除后无法从本机恢复。</p>
          <button onClick={() => setConfirmation(null)} type="button">
            取消
          </button>
          <button onClick={() => void confirmDestructiveAction()} type="button">
            确认删除
          </button>
        </div>
      ) : null}

      {confirmation?.kind === 'clear' ? (
        <div aria-labelledby="clear-projects-title" aria-modal="true" role="dialog">
          <h3 id="clear-projects-title">确认清空本地数据</h3>
          <p>将清空本机保存的 {confirmation.projectCount} 个项目，清空后无法恢复。</p>
          <button onClick={() => setConfirmation(null)} type="button">
            取消
          </button>
          <button onClick={() => void confirmDestructiveAction()} type="button">
            确认清空
          </button>
        </div>
      ) : null}
    </section>
  );
}
