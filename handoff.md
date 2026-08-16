# 外规解读 agent — 项目交接说明

> 更新时间：2026-08-17（Asia/Shanghai）  
> 代码仓库：[yeahh12316-yeahh/Interpretation-of-External-Regulations-Agent](https://github.com/yeahh12316-yeahh/Interpretation-of-External-Regulations-Agent)  
> 公开站点：[外规解读 agent](https://yeahh12316-yeahh.github.io/Interpretation-of-External-Regulations-Agent/)

## 1. 项目目标与已确认边界

本项目是一个面向金融机构合规人员的“外规解读 agent”。用户上传监管文件（必填）及官方解读（选填）后，系统在浏览器本地完成解析、结构化分析、证据校验、人工复核与报告导出。

已确认的关键原则：

- 不抓取网页；材料由用户直接上传 PDF、DOCX 或 TXT。
- 监管原文与官方解读必须分源处理；官方解读不能替代或创造监管事实。
- AI 仅在用户明确配置自己的 OpenAI 兼容接口并确认第三方数据流后，才可发送材料进行分析。
- 监管原文完整性、效力状态、生效日期、重大禁止事项及重大影响判断，必须由合规人员复核。
- 任何结论都必须反向定位原文；无法证实的结论进入待确认或人工判断，不能静默定稿。
- 每位使用者自行输入接口地址与 API Key。Key 不进入仓库、报告、URL、日志、IndexedDB 或 localStorage；仅在当前会话内存/sessionStorage 中保留。
- 当前 GitHub 仓库和 GitHub Pages 站点均为公开可访问。公开站点不含共享后端和共享模型密钥。

## 2. 使用者主流程

1. **材料上传**：上传监管文件，可选上传官方解读；文件在本地浏览器解析。
2. **解析与 OCR**：文本 PDF、DOCX、TXT 直接提取；扫描 PDF 使用同源本地 Tesseract 资源 OCR。低文本页或 OCR 失败页会阻断继续流程，必须完成人工 OCR 复核/纠错。
3. **接口设置与数据流确认**：用户填写 HTTPS 的 OpenAI-compatible Base URL、模型名与 API Key；首次发送材料前确认第三方数据流。
4. **监管分析**：将材料分块，按监管身份、原子要求、关键事项、机构影响四阶段顺序生成；每项结果附来源锚点。
5. **证据校验与人工复核**：系统验证引用、模态词、日期/金额、来源类型、推断边界、OCR 与解析完整性；人工可确认、修改、软删除、补充人工判断、确认/否决待人工规则。
6. **报告导出**：
   - 外规解读报告：完整结构化解读、证据与审计轨迹；
   - 新规快评：3–5 条变化要点及面向管理层的简短影响说明。
   两种报告均支持 PDF/DOCX。草稿带显著水印；最终报告受完整质量门禁限制。

## 3. 当前技术架构

### 前端与部署

- React 19 + TypeScript + Vite 6 的纯静态浏览器应用。
- GitHub Pages 工作流在 `main` 推送后构建 `dist` 并发布。
- Pages 子路径已配置为 `/Interpretation-of-External-Regulations-Agent/`；若仓库改名，须同步更新 `vite.config.ts` 的 `base`。
- 无应用后端、无服务端材料存储、无共享 API Key。

### 本地数据与隐私

- 项目、材料、解析结果、分析版本、人工复核动作、规则复核证明等通过 IndexedDB 的严格伴随会话模型保存。
- 文件 Blob 以字节与媒体类型持久化，恢复时重建；所有恢复数据须经过 schema、哈希、版本链和来源锚点校验。
- API Key 仅 sessionStorage/内存；备份、URL、报告、页面 DOM、浏览器控制台与构建产物均有扫描与回归测试。

### 关键模块

| 模块 | 主要职责 |
| --- | --- |
| `src/features/intake` | 材料上传、格式限制、文件状态与取消 |
| `src/features/parsing` | PDF/DOCX/TXT 提取、扫描识别、OCR 人工纠错、来源锚点 |
| `src/features/model` | BYOK 设置、HTTPS/CORS/超时错误分类、数据流确认、OpenAI-compatible 网关 |
| `src/features/analysis` | 分块、四阶段 skills 编排、严格结果 schema、取消/续跑、定向重分析 |
| `src/features/evidence` | 反向证据校验、质量指标、规则人工证明、Evidence Panel |
| `src/features/review` | 确认/修改/删除/人工判断、审计链与定向重分析控制 |
| `src/features/reports` | 完整解读报告/新规快评模型，PDF 与 DOCX 导出 |
| `src/app` | 五步工作流、持久化会话、状态机、恢复与最终门禁 |
| `src/evaluation`、`scripts/` | 基准语料、发布门禁、隐私/密钥/构建扫描、部署地址校验 |

## 4. 可信度与防幻觉设计

- **原文优先**：监管事实必须与受授权监管原文锚点逐字/规范化反向匹配。
- **来源隔离**：官方解读只能输出受限的上下文说明，必须绑定对应的监管原文来源；不能作为监管事实依据。
- **条款原子化**：原子要求保留主体、行动、对象、条件、频率、期限、强度、责任与例外；不完整或歧义结构进入人工确认。
- **推断可见**：机构影响仅作为 AI 推断或人工判断记录，不能伪装为监管原文事实。
- **OCR/解析 fail-closed**：缺页、OCR 失败、低置信度未复核、来源/页码/条款不一致、锚点篡改都会禁止最终定稿。
- **人工审计留痕**：修改、删除、人工判断与规则复核均绑定复核人、时间、理由、前后快照与链式哈希。
- **报告门禁**：最终报告必须通过事实反查率、引用反查率、人工复核率、推断标识率、未支持结论数等质量指标；草稿可预览但水印清晰标识。

## 5. 已完成的主要能力

### 材料与解析

- PDF、DOCX、TXT 解析；扫描 PDF 识别与逐页纠错。
- PDF 解析使用同源 worker；Tesseract worker/core/中英文语言包同源发布。
- PDF、DOCX、TXT 的页/段/条/来源定位统一到 `ParsedSourceUnit` 与 canonical anchors。
- OCR 纠错只能显式提交到当前权威解析结果；不会自动从 localStorage 伪造或覆盖权威内容。

### 分析与证据

- 24k 字符分块、2k 重叠；来源类型与授权 source ID 隔离。
- 四阶段分析编排：监管身份 → 原子要求 → 关键事项 → 机构影响。
- checkpoint、恢复、定向重分析都绑定目标 finding ID、类别、claim type、原子类型、阶段、来源与规范定位。
- 规则校验为自动通过 / 待人工确认 / 人工已确认 / 人工否决 / 校验失败五态；人工证明严格绑定当前 finding、来源锚点及原子结构摘要。

### 人工复核与报告

- 复核页提供查看原文/依据、修改、确认、软删除、新增人工判断、退回 AI 定向重分析。
- 审计重放以最新 AI 版本为基线，不允许重封历史版本、回滚 current finding、类别漂移或伪造人工动作。
- 完整报告和快评结构不同：快评严格要求 3–5 条变化要点，完整报告包括背景、适用范围、核心要求、禁止事项、时间安排、机构影响、证据附录及审计信息。
- DOCX/PDF 均已做中文、脚注、水印、分页和视觉 QA。

### 发布与安全门禁

- CI、构建密钥扫描和 GitHub Pages 发布工作流均使用不可变 Action SHA，checkout 不保留凭据。
- GitHub Pages 构建前会执行 `pnpm build` 与 `pnpm scan:build`。
- 部署 URL 校验拒绝 localhost、私网、保留网段、URL 凭据、query/hash，以及 DNS 解析到非公网地址的情形。
- 产物扫描覆盖压缩/嵌套压缩、OCR 资产完整性、UTF-16、未知容器、密钥及测试材料泄露。

## 6. 验证状态

最新项目代码已通过以下本地和线上验证：

- 全量 Vitest：413 tests（最后一次安全扫描修复后）。
- TypeScript 类型检查与 Vite 生产构建通过。
- Playwright 端到端测试此前已通过 19 项，覆盖上传、OCR、分析、复核、报告、响应式布局和隐私边界。
- 发布基准：正常语料 `exit 0`；故意失败语料 `exit 1`。
- GitHub Actions：最新 CI 与 Build secret scan 已通过。
- GitHub Pages：首次发布工作流成功；站点已实际打开并显示“材料上传”界面。

说明：Vite 仍会报告部分 OCR/PDF/DOCX 产物大于 500kB 的优化建议，属于性能优化项，不是构建失败。

## 7. 关键提交（按近期优先）

| 提交 | 内容 |
| --- | --- |
| `9b68a03` | GitHub Pages 发布工作流与子路径静态资源配置 |
| `cb13b59` | 修复 CI：在依赖 OCR `dist` 资源的单测前先构建 |
| `a5126b5` | 修复嵌套 skippable 压缩帧的构建扫描绕过 |
| `f601ca8` | 收口 NAT64、压缩容器与条款标题信任边界 |
| `422b31a` | 强化部署产物信任边界 |
| `568c63a` | 补齐部署证据边界 |
| `445e485` | 收口报告影响类别与回放语义 |
| `ba5164c` | 强化基准 fixture 的安全读取与 ZIP 校验 |

历史任务的完整 TDD、审阅与原始验证记录位于：
`/.superpowers/sdd/2026-08-14-external-regulation-agent-implementation/task-1-report.md` 至 `task-12-report.md`。

## 8. 本地开发与验证

要求：Node.js `24.19.0`、pnpm `11.19.0`。

```bash
pnpm install --frozen-lockfile
pnpm dev

# 关键门禁
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm benchmark
pnpm build
pnpm scan:build
pnpm scan:secrets -- --root src --root scripts --root dist --root artifacts
```

若当前终端无法找到 Node，可显式把 Codex runtime Node 加到 `PATH` 后再执行 pnpm；不要因为本机依赖缺失而删除现有 `node_modules` 或锁文件。

## 9. 运维与后续建议

1. **模型接入**：GitHub Pages 是静态站点。每位用户需自行提供符合 CORS 要求的 HTTPS OpenAI-compatible endpoint 和 API Key；若接口不允许浏览器跨域，需由接口提供方配置 CORS，或另行设计受控后端代理。
2. **仓库可见性**：当前仓库已公开，符合公开 Pages 的可访问目标；若要保留源代码私有但站点公开，建议后续迁移至 Vercel/Cloudflare Pages 等托管方案，并重新完成生产冒烟与隐私扫描。
3. **仓库改名**：必须同步更新 `vite.config.ts` 中 GitHub Pages 的 `base`，并验证 OCR 静态资源路径。
4. **性能优化**：重点关注 PDF.js、Tesseract、语言包、导出组件和中文字体的大体积产物；可研究按需下载、缓存策略、分包或更轻量的 OCR 方案，但不得破坏同源/完整性校验。
5. **监管质量维护**：基准语料仅用于回归，不代表未知监管文件的精度承诺。应以脱敏、授权的真实样本持续扩展 benchmark，并由合规专家复核标准答案。
6. **安全维护**：IANA 特殊地址表、OCR 资源 hash、GitHub Actions SHA 与依赖版本变更后，需要重新验证对应门禁。
7. **报告正式使用**：最终报告仍应由合规人员确认监管文件版本、效力、适用范围和重大判断；系统不构成法律意见。

## 10. 交接结论

项目已完成从本地原型到公开静态站点的闭环：代码已推送、CI 通过、GitHub Pages 已发布、公开页面已核验可打开。后续工作应优先围绕真实接口 CORS、受控真实样本 benchmark、性能分包，以及私有源码/公开站点的托管策略展开。
