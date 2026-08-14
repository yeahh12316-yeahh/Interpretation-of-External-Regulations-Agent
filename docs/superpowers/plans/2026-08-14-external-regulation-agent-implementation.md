# 外规解读agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成一个可公开访问、纯浏览器运行、支持真实监管文件解析、证据可追溯分析、人工修订和双报告导出的“外规解读agent”。

**Architecture:** 使用 React + TypeScript 构建静态单页应用，所有文件解析、OCR、质量校验、项目保存和报告导出均在浏览器内完成；只有经过用户确认的数据会发送至用户配置的 OpenAI 兼容模型接口。领域对象、解析器、模型网关、七项分析能力、证据校验、复核和报告编排保持独立，通过 Zod 校验的结构化数据连接。

**Tech Stack:** Vite、React、TypeScript、Zod、Dexie/IndexedDB、PDF.js、Mammoth、Tesseract.js、Zustand、Vitest、Testing Library、MSW、Playwright、docx、@react-pdf/renderer、pnpm。

## Global Constraints

- 产品名称统一为“外规解读agent”，主色为白、黑和 Deloitte Green `#86BC25`。
- 公开站点由私有 GitHub 仓库构建，应用不建设业务后端。
- 监管文件必填，官方解读选填；不抓取监管网页。
- 支持文字 PDF、扫描 PDF、DOCX、TXT 和粘贴文本。
- API Key 仅保存在内存或 `sessionStorage`，不得进入 IndexedDB、URL、日志、备份、报告或构建产物。
- 原始文件默认不持久化；仅在用户明确选择后写入 IndexedDB。
- 监管事实、官方说明、AI 推导、待确认事项和人工判断必须使用不同类型标记。
- 事实性结论引用覆盖率、引用反查通过率、AI 推导标记覆盖率和必审事项完成率达到 100%，且无依据结论为 0，才能生成“人工定稿”。
- 未完成人工复核时只能导出带“AI 草稿，未经人工复核”标记的文件。
- 报告生成器只能编排已验证或人工确认的数据，不得新增事实。
- 所有失败必须显示可操作的错误，不得白屏、按钮失效或虚假成功。
- 每项任务使用测试驱动开发；完成后运行该任务测试和全量回归并提交独立 commit。

## File Map

- `src/domain/`：稳定领域类型、Schema、项目状态机和质量指标。
- `src/features/intake/`：上传、粘贴、文件校验和哈希。
- `src/features/parsing/`：PDF/DOCX/TXT 解析、OCR、条款切分和来源锚点。
- `src/features/model/`：BYOK 设置、OpenAI 兼容请求、错误分类和结构化响应。
- `src/features/analysis/`：七项能力的提示词、分块、编排、去重和结果归一化。
- `src/features/evidence/`：引用反查、强度词/数字/日期校验和质量指标。
- `src/features/review/`：人工确认、修改、删除、新增判断、退回分析和修订历史。
- `src/features/reports/`：完整报告、快评、预览、DOCX/PDF 导出。
- `src/features/projects/`：IndexedDB、本地偏好、项目备份、恢复和删除。
- `src/app/`：五步流程、页面布局、错误边界和跨模块状态。
- `tests/fixtures/`：脱敏的文字 PDF、扫描 PDF、DOCX、TXT 和专家标注样本。
- `tests/e2e/`：真实浏览器全流程、隐私、响应式和故障场景。

---

### Task 1: 建立可测试、可构建的应用骨架

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `tsconfig.json`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/App.test.tsx`
- Create: `src/styles/tokens.css`
- Create: `src/styles/global.css`
- Create: `.gitignore`

**Interfaces:**
- Consumes: 无。
- Produces: `App(): JSX.Element`、统一 CSS tokens、`pnpm test`、`pnpm build` 和 `pnpm test:e2e` 命令。

- [ ] **Step 1: 在已建立的功能 worktree 中初始化前端依赖**

Run:

```bash
pnpm init
pnpm add react react-dom zod dexie zustand pdfjs-dist mammoth tesseract.js @tesseract.js-data/chi_sim @tesseract.js-data/eng docx @react-pdf/renderer file-saver
pnpm add -D typescript tsx vite @vitejs/plugin-react vitest jsdom fake-indexeddb @types/react @types/react-dom @types/file-saver @testing-library/react @testing-library/jest-dom @testing-library/user-event msw @playwright/test eslint prettier
```

Expected: `package.json` 和锁文件生成，依赖版本被 `pnpm-lock.yaml` 固定。

- [ ] **Step 2: 先写应用壳测试**

```tsx
import { render, screen } from '@testing-library/react';
import { App } from './App';

it('renders the product identity and five workflow steps', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: '外规解读agent' })).toBeVisible();
  for (const name of ['材料上传', '解析与OCR', '监管分析', '人工复核', '报告导出']) {
    expect(screen.getByText(name)).toBeVisible();
  }
});
```

- [ ] **Step 3: 运行测试并确认红灯**

Run: `pnpm vitest run src/app/App.test.tsx`  
Expected: FAIL，原因是 `App` 尚未实现。

- [ ] **Step 4: 实现最小应用壳和样式 tokens**

```ts
export const workflowSteps = ['材料上传', '解析与OCR', '监管分析', '人工复核', '报告导出'] as const;
```

在 `App.tsx` 渲染产品名称、五步导航和主内容区域；在 `tokens.css` 定义 `--green:#86bc25`、`--black:#111111`、`--white:#ffffff`、字号和间距变量。

- [ ] **Step 5: 验证测试、构建并提交**

Run: `pnpm vitest run src/app/App.test.tsx && pnpm build`  
Expected: PASS，构建无 TypeScript 错误。

```bash
git add package.json pnpm-lock.yaml vite.config.ts vitest.config.ts playwright.config.ts tsconfig.json index.html src .gitignore
git commit -m "chore: initialize external regulation agent"
```

### Task 2: 固化领域模型、Schema 和流程状态机

**Files:**
- Create: `src/domain/source.ts`
- Create: `src/domain/finding.ts`
- Create: `src/domain/project.ts`
- Create: `src/domain/quality.ts`
- Create: `src/domain/schemas.ts`
- Create: `src/domain/state-machine.ts`
- Test: `src/domain/schemas.test.ts`
- Test: `src/domain/state-machine.test.ts`

**Interfaces:**
- Consumes: Zod。
- Produces: `SourceUnit`、`Finding`、`Project`、`QualityMetrics`、`FindingSchema`、`ProjectSchema`、`canTransition(project, nextStep)`。

- [ ] **Step 1: 写非法结论和越级流程的失败测试**

```ts
expect(() => FindingSchema.parse({ findingId: 'F1', statement: '应建立制度', claimType: 'regulatory_fact', sourceAnchors: [] })).toThrow();
expect(canTransition(emptyProject, 'analysis')).toEqual({ allowed: false, reason: '请先完成文件解析' });
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/domain`  
Expected: FAIL，Schema 和状态机模块不存在。

- [ ] **Step 3: 实现判别联合类型和 Schema**

```ts
export type ClaimType = 'regulatory_fact' | 'official_explanation' | 'ai_inference' | 'pending_confirmation' | 'human_judgment';
export type WorkflowStep = 'intake' | 'parsing' | 'analysis' | 'review' | 'report';
export interface SourceAnchor { sourceId: string; page: number | null; article: string | null; paragraphIndex: number; quote: string; }
export interface Finding { findingId: string; category: string; statement: string; claimType: ClaimType; sourceAnchors: SourceAnchor[]; inferenceParents: string[]; reviewStatus: 'unreviewed' | 'confirmed' | 'modified' | 'deleted'; requiredReview: boolean; }
```

`FindingSchema.superRefine` 强制监管事实具有监管原文锚点、官方说明具有官方解读锚点、AI 推导具有 `inferenceParents`，人工判断具有修订记录。

- [ ] **Step 4: 实现状态机**

`canTransition` 检查监管文件、解析完成、分析结果、必审事项和质量门槛；直接点击左侧步骤时复用同一函数，不在 UI 中复制规则。

- [ ] **Step 5: 跑测试、类型检查并提交**

Run: `pnpm vitest run src/domain && pnpm tsc --noEmit`  
Expected: PASS。

```bash
git add src/domain
git commit -m "feat: define evidence-first domain model"
```

### Task 3: 实现隐私安全的项目与接口设置存储

**Files:**
- Create: `src/features/projects/db.ts`
- Create: `src/features/projects/project-repository.ts`
- Create: `src/features/projects/project-backup.ts`
- Create: `src/features/projects/ProjectManager.tsx`
- Create: `src/features/projects/model-preferences.ts`
- Create: `src/features/model/session-credentials.ts`
- Test: `src/features/projects/project-repository.test.ts`
- Test: `src/features/projects/project-backup.test.ts`
- Test: `src/features/projects/ProjectManager.test.tsx`
- Test: `src/features/model/session-credentials.test.ts`

**Interfaces:**
- Consumes: `ProjectSchema`。
- Produces: `projectRepository.save(project)`、`load(id)`、`delete(id)`、`clearAll()`、`exportProject(id)`、`importProject(json)`、`modelPreferences.save/load()`、`sessionCredentials.set/get/clear()` 和项目管理 UI。

- [ ] **Step 1: 写 API Key 泄漏和原文件默认持久化的失败测试**

```ts
sessionCredentials.set({ baseUrl: 'https://model.example/v1', apiKey: 'secret-value', model: 'model-a' });
await projectRepository.save(projectWithRawFile);
expect(JSON.stringify(await projectRepository.load(projectWithRawFile.id))).not.toContain('secret-value');
expect((await projectRepository.load(projectWithRawFile.id))?.rawFiles).toEqual([]);
expect(await exportProject(projectWithRawFile.id)).not.toContain('secret-value');
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/features/projects src/features/model/session-credentials.test.ts`  
Expected: FAIL，存储接口不存在。

- [ ] **Step 3: 实现 Dexie 存储和显式原文件保存**

`save(project, { persistRawFiles:false })` 先执行 `ProjectSchema.parse`，剔除 API Key；只有 `persistRawFiles:true` 时保存 `Blob`。删除和清空操作由仓储层提供，但 UI 必须在后续任务中二次确认。

- [ ] **Step 4: 实现会话凭证和 JSON 备份净化**

`sessionCredentials` 使用 `sessionStorage`；只有用户勾选“记住接口设置”时，`modelPreferences` 才把 Base URL 和模型名称写入 IndexedDB，且永不接收 API Key。备份使用明确的 allow-list 序列化，不使用对象全量展开。导入时执行版本号和 Schema 校验。

项目管理 UI 提供恢复、导出 JSON、导入 JSON、删除项目和清空本地数据；删除和清空必须先展示具体项目名称/项目数量并要求二次确认。组件测试点击取消后数据仍存在，点击确认后仓储记录消失。

- [ ] **Step 5: 验证 IndexedDB、备份和泄漏测试并提交**

Run: `pnpm vitest run src/features/projects src/features/model/session-credentials.test.ts`  
Expected: PASS，测试输出和快照不含密钥。

```bash
git add src/features/projects src/features/model/session-credentials.ts src/features/model/session-credentials.test.ts
git commit -m "feat: add privacy-safe local project storage"
```

### Task 4: 完成真实材料上传、文件哈希和文本解析

**Files:**
- Create: `src/features/intake/file-policy.ts`
- Create: `src/features/intake/hash-file.ts`
- Create: `src/features/intake/MaterialUpload.tsx`
- Create: `src/features/parsing/parse-document.ts`
- Create: `src/features/parsing/parse-pdf.ts`
- Create: `src/features/parsing/parse-docx.ts`
- Create: `src/features/parsing/parse-text.ts`
- Create: `src/features/parsing/build-anchors.ts`
- Test: `src/features/intake/MaterialUpload.test.tsx`
- Test: `src/features/parsing/parse-document.test.ts`
- Fixtures: `tests/fixtures/regulation.txt`
- Fixtures: `tests/fixtures/regulation.docx`
- Fixtures: `tests/fixtures/text-regulation.pdf`

**Interfaces:**
- Consumes: `SourceUnit`、监管文件/官方解读来源类别。
- Produces: `parseDocument(file, sourceType, signal): Promise<ParseResult>`，其中 `ParseResult` 含页数、成功页、失败页、`SourceUnit[]` 和质量统计。

- [ ] **Step 1: 写真实文件解析和上传布局测试**

```ts
const result = await parseDocument(textPdf, 'regulation', new AbortController().signal);
expect(result.pageCount).toBe(2);
expect(result.units[0]).toMatchObject({ sourceType: 'regulation', page: 1, extractionMethod: 'text_layer' });
expect(result.units.map(unit => unit.text).join('')).toContain('商业银行应当');
```

上传组件测试必须验证监管文件必填、官方解读选填、拖拽/选择/粘贴可用，以及 1024px 宽度下两个上传区不会溢出容器。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/features/intake src/features/parsing/parse-document.test.ts`  
Expected: FAIL，解析器和组件不存在。

- [ ] **Step 3: 实现文件策略和 SHA-256 哈希**

允许 MIME/扩展名组合：PDF、DOCX、TXT；拒绝加密、空文件和超过配置上限的文件。`hashFile` 使用 `crypto.subtle.digest('SHA-256', arrayBuffer)`，错误信息不得包含文件正文。

- [ ] **Step 4: 实现 PDF、DOCX、TXT 分派解析**

PDF.js 逐页提取文本层和坐标；Mammoth 提取 DOCX 段落；TXT 识别 UTF-8/UTF-16 BOM；`buildAnchors` 识别“第X条”并生成稳定 `sourceId + page + paragraphIndex` 锚点。任何失败页写入 `failedPages`，不得静默跳过。

- [ ] **Step 5: 实现上传组件和解析进度**

组件使用 CSS Grid `repeat(auto-fit,minmax(280px,1fr))`，展示文件名、类型、大小、哈希、页数和来源；`AbortController` 支持取消。

- [ ] **Step 6: 跑测试、构建并提交**

Run: `pnpm vitest run src/features/intake src/features/parsing && pnpm build`  
Expected: PASS，三个 fixture 均产生可反向定位的原文单元。

```bash
git add src/features/intake src/features/parsing tests/fixtures
git commit -m "feat: parse uploaded regulatory documents"
```

### Task 5: 增加扫描 PDF 本地 OCR、置信度和人工纠错

**Files:**
- Create: `src/features/parsing/ocr/detect-scanned-page.ts`
- Create: `src/features/parsing/ocr/ocr-worker.ts`
- Create: `src/features/parsing/ocr/ocr-pipeline.ts`
- Create: `src/features/parsing/OcrReview.tsx`
- Test: `src/features/parsing/ocr/ocr-pipeline.test.ts`
- Test: `src/features/parsing/OcrReview.test.tsx`
- Fixture: `tests/fixtures/scanned-regulation.pdf`

**Interfaces:**
- Consumes: PDF 页面位图和 `AbortSignal`。
- Produces: `ocrPages(pages, signal, onProgress): Promise<OcrPageResult[]>`、`applyOcrCorrection(unitId, correctedText)`。

- [ ] **Step 1: 写扫描检测、低置信度和纠错测试**

```ts
const result = await ocrPages([scannedPage], signal, () => undefined);
expect(result[0].method).toBe('ocr');
expect(result[0].confidence).toBeGreaterThanOrEqual(0);
expect(result[0].confidence).toBeLessThanOrEqual(1);
expect(result[0].text).toContain('不得');
```

组件测试确认低置信度字符可编辑，保存后 `reviewStatus` 变为 `corrected` 且保留原始 OCR 文本。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/features/parsing/ocr src/features/parsing/OcrReview.test.tsx`  
Expected: FAIL。

- [ ] **Step 3: 实现本地 OCR worker**

Tesseract worker 和中文语言数据作为同源静态资源打包，不把页面图像发送到第三方；组件卸载或用户取消时调用 `worker.terminate()`。

- [ ] **Step 4: 接入解析器和质量摘要**

低文本密度页进入 OCR；合并结果时标记 `extractionMethod:'ocr'`、置信度、坐标和低置信度字符。OCR 失败页阻止进入定稿。

- [ ] **Step 5: 验证取消、纠错、内存释放并提交**

Run: `pnpm vitest run src/features/parsing && pnpm build`  
Expected: PASS；取消后 worker 终止，纠错记录可恢复。

```bash
git add src/features/parsing tests/fixtures/scanned-regulation.pdf
git commit -m "feat: add local OCR review pipeline"
```

### Task 6: 实现 BYOK 接口设置和 OpenAI 兼容模型网关

**Files:**
- Create: `src/features/model/model-config.ts`
- Create: `src/features/model/model-errors.ts`
- Create: `src/features/model/model-gateway.ts`
- Create: `src/features/model/ApiSettingsDialog.tsx`
- Test: `src/features/model/model-gateway.test.ts`
- Test: `src/features/model/ApiSettingsDialog.test.tsx`
- Create: `src/test/msw/model-handlers.ts`

**Interfaces:**
- Consumes: `ModelConfig`、API Key、JSON Schema 和消息数组。
- Produces: `testConnection(config, key)`、`requestStructured<T>(request): Promise<T>`、分类错误 `cors|auth|not_found|rate_limit|timeout|invalid_schema|network`。

- [ ] **Step 1: 写成功、CORS、401、429、超时和脏响应测试**

```ts
await expect(gateway.requestStructured(request)).resolves.toMatchObject({ findings: [] });
await expect(authGateway.requestStructured(request)).rejects.toMatchObject({ kind: 'auth' });
await expect(schemaGateway.requestStructured(request)).rejects.toMatchObject({ kind: 'invalid_schema' });
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/features/model`  
Expected: FAIL。

- [ ] **Step 3: 实现 URL 规范化、超时和 Schema 解析**

仅允许 HTTPS；把 base URL 规范化到兼容端点；使用 `AbortController` 实现超时；响应先取 JSON，再用传入的 Zod Schema 校验。最多执行两次格式修复请求，业务事实不得在修复阶段新增。

- [ ] **Step 4: 实现设置对话框与首次数据流告知**

对话框包含 Base URL、API Key、模型、温度和最大输出长度；连接测试分别显示 CORS、鉴权、模型不存在等原因。首次发送材料前弹窗说明文本将发往用户选择的模型服务商。

- [ ] **Step 5: 验证密钥不落盘并提交**

Run: `pnpm vitest run src/features/model src/features/projects`  
Expected: PASS，测试检查 IndexedDB、localStorage、导出 JSON 和 DOM 错误文本均无 API Key。

```bash
git add src/features/model src/test/msw
git commit -m "feat: add browser BYOK model gateway"
```

### Task 7: 实现七项分析能力和长文件编排

**Files:**
- Create: `src/features/analysis/prompts/shared-guardrails.ts`
- Create: `src/features/analysis/prompts/document-identity.ts`
- Create: `src/features/analysis/prompts/atomic-clauses.ts`
- Create: `src/features/analysis/prompts/key-matters.ts`
- Create: `src/features/analysis/prompts/institution-impact.ts`
- Create: `src/features/analysis/chunk-document.ts`
- Create: `src/features/analysis/merge-findings.ts`
- Create: `src/features/analysis/skill-orchestrator.ts`
- Test: `src/features/analysis/chunk-document.test.ts`
- Test: `src/features/analysis/merge-findings.test.ts`
- Test: `src/features/analysis/skill-orchestrator.test.ts`

**Interfaces:**
- Consumes: `SourceUnit[]`、`ModelGateway`、官方解读存在标志。
- Produces: `runAnalysis(input, signal, onProgress): Promise<AnalysisDraft>`，所有结果通过 `FindingSchema`。

- [ ] **Step 1: 写分块、来源隔离、去重和推导标签测试**

```ts
const chunks = chunkDocument(units, { maxChars: 24000, overlapUnits: 2 });
expect(chunks.every(chunk => chunk.units.every(unit => unit.sourceType === chunk.sourceType))).toBe(true);
const merged = mergeFindings([duplicateA, duplicateB]);
expect(merged).toHaveLength(1);
expect(merged[0].sourceAnchors).toHaveLength(2);
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/features/analysis`  
Expected: FAIL。

- [ ] **Step 3: 实现共享护栏和四组分析提示词**

共享护栏明确：只能引用输入 source ID；不得推定效力；保持强度词；官方解读不得覆盖原文；影响必须标为 `ai_inference`；证据不足输出 `pending_confirmation`。解析和证据校验属于确定性能力，不用模型提示词伪装完成。

- [ ] **Step 4: 实现顺序编排**

顺序为：文件身份与背景 → 条款原子化 → 核心/禁止/时间归纳 → 机构影响 → Schema 校验 → 去重。每个分块记录模型、提示词版本、输入 source IDs 和响应哈希，支持取消和从最后成功节点重试。

- [ ] **Step 5: 验证无官方解读、冲突和长文档场景并提交**

Run: `pnpm vitest run src/features/analysis src/domain`  
Expected: PASS；无官方解读时产生限制提示，冲突项进入待确认。

```bash
git add src/features/analysis
git commit -m "feat: orchestrate evidence-bound regulation analysis"
```

### Task 8: 实现证据反查、质量指标和动态原文面板

**Files:**
- Create: `src/features/evidence/normalize-text.ts`
- Create: `src/features/evidence/validate-finding.ts`
- Create: `src/features/evidence/calculate-quality.ts`
- Create: `src/features/evidence/EvidencePanel.tsx`
- Create: `src/features/evidence/ValidationDetails.tsx`
- Test: `src/features/evidence/validate-finding.test.ts`
- Test: `src/features/evidence/calculate-quality.test.ts`
- Test: `src/features/evidence/EvidencePanel.test.tsx`

**Interfaces:**
- Consumes: `Finding`、`SourceUnit[]`、当前选择的 `findingId`。
- Produces: `validateFinding(finding, sourceIndex): ValidationResult[]`、`calculateQuality(project): QualityMetrics`、`EvidencePanel`。

- [ ] **Step 1: 写引用变化、强度词和无依据结论测试**

```ts
expect(validateFinding(matchedFinding, index)).toContainEqual(expect.objectContaining({ rule: 'quote_match', passed: true }));
expect(validateFinding(weakenedProhibition, index)).toContainEqual(expect.objectContaining({ rule: 'modal_strength', passed: false }));
rerender(<EvidencePanel selectedFindingId="F2" findings={findings} sources={sources} />);
expect(screen.getByText('第18页')).toBeVisible();
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/features/evidence`  
Expected: FAIL。

- [ ] **Step 3: 实现确定性证据校验**

统一全角/半角、空白和换行后反向查找引用；分别检查文件 ID、页码、条款、引用、强度词、日期、数字、来源类型和推导父项。每条规则返回 `rule`、`passed`、`message` 和 `severity`。

- [ ] **Step 4: 实现质量指标与定稿闸门**

计算解析覆盖、引用覆盖、反查通过、无依据数量、推导标记和必审完成率；`canFinalize(metrics)` 仅在规格规定的五项门槛全部满足时返回 true。

- [ ] **Step 5: 实现动态证据面板和校验详情**

点击任一结论更新 `selectedFindingId`；面板显示文件、页码、条款、原文、高亮引用和结论类型；“查看校验详情”打开真实规则结果，不使用固定示例。

- [ ] **Step 6: 验证并提交**

Run: `pnpm vitest run src/features/evidence && pnpm build`  
Expected: PASS，F1/F2 切换时页码、条款和原文均变化。

```bash
git add src/features/evidence
git commit -m "feat: validate citations and expose evidence details"
```

### Task 9: 实现五步界面和可修订的人工复核闭环

**Files:**
- Create: `src/app/WorkflowShell.tsx`
- Create: `src/app/workflow-store.ts`
- Create: `src/features/analysis/AnalysisPage.tsx`
- Create: `src/features/review/review-actions.ts`
- Create: `src/features/review/ReviewPage.tsx`
- Create: `src/features/review/EditFindingDialog.tsx`
- Create: `src/features/review/AddHumanJudgmentDialog.tsx`
- Create: `src/features/review/ReturnToAnalysisDialog.tsx`
- Test: `src/app/WorkflowShell.test.tsx`
- Test: `src/features/review/review-actions.test.ts`
- Test: `src/features/review/ReviewPage.test.tsx`

**Interfaces:**
- Consumes: 状态机、`Finding[]`、验证结果、模型编排器和项目仓储。
- Produces: `confirmFinding`、`modifyFinding`、`deleteFinding`、`addHumanJudgment`、`returnForReanalysis` 以及五步可恢复 UI。

- [ ] **Step 1: 写全部复核按钮和版本留痕测试**

```ts
const updated = modifyFinding(project, 'F1', '商业银行必须建立管理机制', { reviewer: '合规复核人', reason: '保持原文强度' });
expect(updated.findings[0].revisionHistory[0]).toMatchObject({ original: '商业银行应建立管理机制', reason: '保持原文强度' });
expect(updated.findings[0].statement).toBe('商业银行必须建立管理机制');
```

UI 测试逐一点击查看原文、查看依据、修改、确认、删除、新增人工判断和退回 AI，验证状态或对话框真实变化。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/app src/features/review`  
Expected: FAIL。

- [ ] **Step 3: 实现不可变复核动作和历史记录**

任何修改创建新 revision，不覆盖 AI 原始内容；人工判断必须填写陈述、依据、复核人和理由；退回 AI 必须指定原因、目标 findings 和分析范围，重分析结果以新版本返回。

- [ ] **Step 4: 实现分析页、复核页和流程按钮**

每页提供上一步/下一步；左侧导航调用 `canTransition`；分析卡片和复核条目共享 `selectedFindingId`，确保右侧证据同步；必审项按严重程度置顶。

- [ ] **Step 5: 实现错误边界、loading、取消和恢复**

根组件增加 React Error Boundary；每个长操作显示阶段、进度和取消；异常后保留最近已保存项目，界面显示“重试”和“返回上一步”。

- [ ] **Step 6: 验证全流程组件测试并提交**

Run: `pnpm vitest run src/app src/features/review src/features/evidence && pnpm build`  
Expected: PASS，无按钮为无处理器的装饰元素。

```bash
git add src/app src/features/analysis/AnalysisPage.tsx src/features/review
git commit -m "feat: add five-step review and correction workflow"
```

### Task 10: 生成结构不同的两类报告并真实导出 DOCX/PDF

**Files:**
- Create: `src/features/reports/report-model.ts`
- Create: `src/features/reports/build-full-report.ts`
- Create: `src/features/reports/build-quick-commentary.ts`
- Create: `src/features/reports/ReportPreview.tsx`
- Create: `src/features/reports/export-docx.ts`
- Create: `src/features/reports/export-pdf.tsx`
- Create: `src/features/reports/ReportPage.tsx`
- Test: `src/features/reports/report-builders.test.ts`
- Test: `src/features/reports/export-docx.test.ts`
- Test: `src/features/reports/export-pdf.test.tsx`
- Test: `src/features/reports/ReportPage.test.tsx`

**Interfaces:**
- Consumes: 仅已验证或人工确认的 findings、项目状态、来源清单和修订记录。
- Produces: `buildFullReport(project)`、`buildQuickCommentary(project)`、`exportDocx(report)`、`exportPdf(report)`。

- [ ] **Step 1: 写报告差异、禁止新增事实和草稿标记测试**

```ts
const full = buildFullReport(reviewedProject);
const quick = buildQuickCommentary(reviewedProject);
expect(full.sections.map(section => section.key)).toContain('evidence_appendix');
expect(quick.sections.map(section => section.key)).toEqual(['one_line', 'why_it_matters', 'top_changes', 'red_lines', 'dates', 'affected_scope', 'actions', 'limitations']);
expect(JSON.stringify(full)).not.toContain('UNSUPPORTED_SENTENCE');
expect(buildFullReport(unreviewedProject).watermark).toBe('AI草稿，未经人工复核');
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `pnpm vitest run src/features/reports`  
Expected: FAIL。

- [ ] **Step 3: 实现两个纯函数报告构建器**

完整版生成 11 个规定章节和证据索引；快评生成 8 个短章节并将变化控制在三至五项。构建器不调用模型，只接收 allow-list 字段；无依据或已删除 finding 不得进入正文。

- [ ] **Step 4: 实现预览、DOCX 和 PDF 导出**

DOCX 使用 `docx` 创建可编辑标题、段落、表格、页眉和证据脚注；PDF 使用 `@react-pdf/renderer` 和同源中文字体生成可搜索文本。导出文件含成果类型、项目版本、生成时间、来源和复核状态。

- [ ] **Step 5: 用解包和 PDF 文本提取验证真实文件**

测试生成 Blob：DOCX 必须为有效 ZIP 且 `word/document.xml` 包含报告标题；PDF 头为 `%PDF-`，提取文本包含标题和水印。预览与导出共同使用同一 `ReportModel`。

- [ ] **Step 6: 跑测试并提交**

Run: `pnpm vitest run src/features/reports && pnpm build`  
Expected: PASS，两种成果章节顺序和篇幅明显不同，下载文件可打开。

```bash
git add src/features/reports
git commit -m "feat: export full interpretation and quick commentary"
```

### Task 11: 建立基准评测、端到端测试和故障注入

**Files:**
- Create: `src/evaluation/evaluate-findings.ts`
- Create: `src/evaluation/evaluation-report.ts`
- Create: `tests/fixtures/benchmark/manifest.json`
- Create: `tests/fixtures/benchmark/expected-findings.json`
- Create: `tests/e2e/full-flow.spec.ts`
- Create: `tests/e2e/privacy.spec.ts`
- Create: `tests/e2e/failures.spec.ts`
- Create: `tests/e2e/responsive.spec.ts`
- Create: `scripts/run-benchmark.ts`
- Test: `src/evaluation/evaluate-findings.test.ts`

**Interfaces:**
- Consumes: 专家标注 findings 和系统 findings。
- Produces: `evaluateFindings(expected, actual): EvaluationMetrics`、机器可读 `benchmark-report.json` 和人读摘要。

- [ ] **Step 1: 写精确率、召回率和重大遗漏测试**

```ts
const metrics = evaluateFindings(expected, actual);
expect(metrics.critical.precision).toBe(1);
expect(metrics.critical.recall).toBe(0.5);
expect(metrics.criticalOmissions).toEqual(['CRITICAL-002']);
```

- [ ] **Step 2: 实现评测匹配规则和发布门槛**

按类别、标准化陈述、主体/动作/期限和来源锚点匹配；输出重大事项与全部原子要求的 precision/recall、引用有效率、未标记推导、OCR 关键字段准确率。任一规格门槛失败，脚本退出码为 1。

- [ ] **Step 3: 写真实浏览器全流程测试**

`full-flow.spec.ts` 上传脱敏监管文件、连接 MSW 模型、解析、分析、切换两条结论核对右栏、修改一条结论、完成复核并下载两类报告；断言 DOCX/PDF 下载成功且报告结构不同。

- [ ] **Step 4: 写隐私、故障和响应式测试**

`privacy.spec.ts` 检查刷新、备份、IndexedDB 和页面 URL 无 API Key；`failures.spec.ts` 模拟 CORS、401、429、超时、Schema 错误、OCR 失败和导出失败；`responsive.spec.ts` 在 1440×900、1024×768、768×1024 下确认上传区、导航、证据抽屉和按钮可用。

- [ ] **Step 5: 运行全量质量门槛并提交**

Run: `pnpm test && pnpm exec playwright test && pnpm tsx scripts/run-benchmark.ts && pnpm build`  
Expected: 全部 PASS；基准报告满足规格阈值；浏览器控制台无未捕获异常。

```bash
git add src/evaluation tests scripts
git commit -m "test: add benchmark and end-to-end quality gates"
```

### Task 12: 配置私有 GitHub 到公开静态站点的发布闸门

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/secret-scan.yml`
- Create: `vercel.json`
- Create: `playwright.production.config.ts`
- Create: `.env.example`
- Create: `README.md`
- Create: `docs/deployment.md`
- Create: `docs/privacy.md`
- Create: `scripts/scan-build-secrets.mjs`
- Create: `tests/e2e/production-smoke.spec.ts`

**Interfaces:**
- Consumes: 全量测试、构建产物 `dist/` 和用户授权的 GitHub/Vercel 配置。
- Produces: CI 状态、无敏感信息的静态构建、部署说明和生产冒烟证据。

- [ ] **Step 1: 写构建产物敏感信息扫描器测试**

```ts
expect(scanText('const key="sk-test-secret"')).toEqual([{ type: 'api-key-pattern', line: 1 }]);
expect(scanText('外规解读agent')).toEqual([]);
```

- [ ] **Step 2: 实现 CI 和发布检查**

CI 固定 Node/pnpm major，执行安装、类型检查、单元测试、Playwright、基准评测、构建和 `dist/` 敏感信息扫描。`.env.example` 只含字段说明，不含值；生产构建不得注入共享模型密钥。

- [ ] **Step 3: 编写部署、隐私和品牌授权说明**

`docs/deployment.md` 说明私有仓库如何连接静态托管、如何配置公开访问和 SPA fallback；`docs/privacy.md` 明确平台本地处理与用户模型接口数据流。README 说明正式 Deloitte 标识仅在获得授权资产后启用。

- [ ] **Step 4: 在本地模拟生产构建**

Run: `pnpm install --frozen-lockfile && pnpm test && pnpm build && node scripts/scan-build-secrets.mjs dist`  
Expected: PASS，`dist/` 不含 API Key、上传样本、测试响应或真实项目数据。

- [ ] **Step 5: 经用户授权后连接远端并执行线上冒烟**

用户授权仓库后，在终端运行 `read -r REGULATION_AGENT_REPO_URL` 并粘贴已批准的私有仓库 URL；随后运行：

```bash
test -n "$REGULATION_AGENT_REPO_URL"
git remote add origin "$REGULATION_AGENT_REPO_URL"
git push -u origin main
pnpm exec playwright test tests/e2e/production-smoke.spec.ts --config=playwright.production.config.ts
```

Expected: 用户提供的公开网址可打开；上传脱敏样本至导出流程成功；浏览器控制台无白屏或关键错误。此步骤必须在用户提供并授权远端仓库和托管目标后执行。

- [ ] **Step 6: 提交发布配置**

```bash
git add .github vercel.json .env.example README.md docs scripts tests/e2e/production-smoke.spec.ts
git commit -m "chore: add secure static deployment gates"
```

## Final Verification Gate

- [ ] Run: `pnpm install --frozen-lockfile`
- [ ] Run: `pnpm tsc --noEmit`
- [ ] Run: `pnpm test`
- [ ] Run: `pnpm exec playwright test`
- [ ] Run: `pnpm tsx scripts/run-benchmark.ts`
- [ ] Run: `pnpm build`
- [ ] Run: `node scripts/scan-build-secrets.mjs dist`
- [ ] Verify all five workflow steps with a text PDF and scanned PDF.
- [ ] Verify every analysis/review selection updates the evidence panel.
- [ ] Verify every review button mutates state and creates revision evidence.
- [ ] Verify full report and quick commentary differ in structure and exported content.
- [ ] Verify draft watermark and human-final gate.
- [ ] Verify API Key is absent from URL, logs, IndexedDB, backup, report and `dist/`.
- [ ] Verify the actual public URL after deployment; local build success alone is not deployment evidence.
