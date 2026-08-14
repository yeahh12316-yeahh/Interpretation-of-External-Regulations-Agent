import type { JSX } from 'react';

import { MaterialUpload } from '../features/intake/MaterialUpload';

export const workflowSteps = ['材料上传', '解析与OCR', '监管分析', '人工复核', '报告导出'] as const;

export function App(): JSX.Element {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>外规解读agent</h1>
      </header>

      <nav aria-label="外规解读工作流" className="workflow-nav">
        <ol>
          {workflowSteps.map((step, index) => (
            <li key={step}>
              <span aria-hidden="true">{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </nav>

      <main className="app-content">
        <MaterialUpload />
      </main>
    </div>
  );
}
