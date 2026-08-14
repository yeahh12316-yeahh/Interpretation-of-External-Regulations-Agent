import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

it('renders the product identity and five workflow steps', () => {
  render(<App />);

  expect(screen.getByRole('heading', { name: '外规解读agent' })).toBeVisible();
  for (const name of ['材料上传', '解析与OCR', '监管分析', '人工复核', '报告导出']) {
    expect(screen.getByText(name)).toBeVisible();
  }
});
