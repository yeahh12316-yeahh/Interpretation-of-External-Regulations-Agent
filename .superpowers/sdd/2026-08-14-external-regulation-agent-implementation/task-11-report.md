# Task 11 实施报告

## Status

- Base HEAD：`445e485d66b0585740ba86caccfa59c425f1b743`，开始时 clean。
- 实现范围：闭合 one-to-one 基准评测、稳定 CLI 报告、生产 App 全流程 E2E、BYOK 隐私、UI 故障注入、1440/1024/768 响应式门禁。
- 基准声明：**合成回归基准，仅证明该测试语料/版本，不代表未知文件95%正确率**。
- fixtures 均为合成内容，未使用客户、个人、项目原文或真实密钥。

## 关键实现

1. `evaluateFindings` 不使用 findingId、substring 或一个 actual 多次命中；按类别、NFKC/既有证据规范化后的 statement、完整九项 AtomicRequirement 字段和完整来源锚点执行确定性 one-to-one 匹配。
2. 四类重大事项分别 fail closed：核心要求、禁止事项、关键日期、过渡期 precision/recall 均需 `>=95%`；原子要求 precision `>=90%`、recall `>=85%`；事实引用 `100%`；未标记 AI 推导与重大遗漏均为 0；OCR 字符准确率 `>=99%`。
3. 任一必需类别、原子、事实引用或 OCR 分母为 0 时返回 `null/not_evaluable` 并阻断 release gate，不产生 `NaN` 或乐观 1。
4. OCR 用 Unicode code point Levenshtein CER；逐页低于 99% 的页面进入 `manualReviewPages`。
5. manifest 严格声明 PDF 文字/扫描、DOCX、TXT、文字/扫描/表格/附件/长文、官方解读有/无、监管机构类型与四类重大事项覆盖；每个 sample 强制 `synthetic:true`。
6. CLI 真实读取 manifest/expected/actual，稳定输出 `artifacts/benchmark/benchmark-report.json` 与 `benchmark-summary.txt`；机器报告不写 findings 原文。
7. 新 Playwright helper 只存在于 `tests/e2e/support`，没有生产 test hook/demo data。生产流真实上传监管原文和官方解读、浏览器解析、HTTPS 模型 route、Task7/8/9/10、两结论证据切换、修改审计、规则复核，并实际下载/解包/解析 full+quick DOCX/PDF 四文件。

## RED 证据（raw）

### 评测模块缺失

```text
FAIL src/evaluation/evaluate-findings.test.ts
Error: Failed to resolve import "./evaluate-findings"
Test Files 1 failed
```

在最小导出骨架后，行为断言 RED：

```text
Test Files 1 failed (1)
Tests 5 failed (5)
```

### CLI 缺失

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'scripts/run-benchmark.ts'
exit_code: 1
```

### full-flow 缺失共享编排

Command:

```text
PATH=... node_modules/.bin/playwright test tests/e2e/full-flow.spec.ts
```

Output:

```text
Error: Cannot find module 'tests/e2e/support/production-flow'
exit_code: 1
```

### 真实 review gate 行为 RED

```text
Error: expect(locator).toBeEnabled() failed
Locator: getByRole('button', { name: '下一步' })
Expected: enabled
Received: disabled
```

按约束停止重复重跑后，只读 IndexedDB 诊断一次：

```text
parseAuthority=true
factCitationCoverage=1
citationReverseCheckRate=1
unsupportedFindingCount=0
inferenceMarkingRate=1
requiredReviewCompletionRate=1
automaticValidationRuleCount=42
manualConfirmedValidationRuleCount=2
manualReviewPendingRuleCount=0
manualRejectedValidationRuleCount=0
failedValidationRuleCount=0
attestationIntegrityFailureCount=0
```

定位为测试 helper 用动态 `nth` 遍历，而复核会改变卡片顺序，导致 K1-K3 未实际确认；改为冻结 finding IDs、按精确 ID 重定位并等待 `confirmed`。诊断代码随后删除，未改 production gate。

### 首轮隐私/故障/响应式

```text
Running 8 tests using 1 worker
5 passed
3 failed
```

三个失败均为测试边界：blocked OCR 在 intake 可进入“解析与OCR”但不能再进入分析；sessionStorage 保存的是包含 key 的 JSON 而非裸值；export 场景未完成 F1 必审。修正断言/编排后未修改生产逻辑。

### Vitest/E2E runner 隔离 RED

```text
Test Files 4 failed | 29 passed (33)
Tests 289 passed (289)
Playwright Test did not expect test() to be called here.
```

原因是新增 `tests/e2e/*.spec.ts` 被 Vitest 默认 glob 收集；在 `vitest.config.ts` 排除 `tests/e2e/**` 后全量 GREEN。

## GREEN / 最终门禁（raw）

### Focused evaluation

```text
✓ src/evaluation/evaluate-findings.test.ts (7 tests)
Test Files 1 passed (1)
Tests 7 passed (7)
```

### Full Vitest

Command:

```text
node_modules/.bin/vitest run
```

Output:

```text
Test Files 29 passed (29)
Tests 289 passed (289)
Duration 9.31s
exit_code: 0
```

PDF.js 对既有 CFF 测试字体输出已知 warning，但测试及文本提取通过。

### Full Playwright

Command:

```text
node_modules/.bin/playwright test
```

Output:

```text
Running 17 tests using 1 worker
17 passed (22.1s)
exit_code: 0
```

覆盖既有同源 OCR worker/真实扫描 PDF，以及新 full-flow、privacy、CORS/网络/401/404/429/timeout/schema repair exhausted/OCR failure/export failure、1440x900/1024x768/768x1024。

### Passing benchmark CLI

```text
BENCHMARK: synthetic-regression-v1 @ 1.0.0
RELEASE GATE: PASS
声明: 合成回归基准，仅证明该测试语料/版本，不代表未知文件95%正确率
重大事项: precision=100.00%, recall=100.00%, TP=4, FP=0, FN=0
原子要求: precision=100.00%, recall=100.00%, TP=1, FP=0, FN=0
事实引用: 5/5 (100.00%)
OCR: errors=0, expectedCharacters=17, accuracy=100.00%
重大遗漏 IDs: none
未标记 AI 推导 IDs: none
人工检查页: none
失败规则: none
exit_code: 0
```

### Deliberate failing benchmark

```text
BENCHMARK: synthetic-regression-v1 @ 1.0.0
RELEASE GATE: FAIL
重大事项: precision=100.00%, recall=75.00%, TP=3, FP=0, FN=1
原子要求: precision=0.00%, recall=0.00%, TP=0, FP=1, FN=1
事实引用: 4/5 (80.00%)
OCR: errors=1, expectedCharacters=17, accuracy=94.12%
重大遗漏 IDs: EXP-TRANSITION
未标记 AI 推导 IDs: BAD-UNMARKED-IMPACT
人工检查页: SYNTH-REG-SCAN:p3
失败规则: critical_precision_below_95:transition_period,critical_recall_below_95:transition_period,atomic_precision_below_90,atomic_recall_below_85,citation_validity_below_100,unmarked_ai_inference,critical_omissions,ocr_accuracy_below_99
exit_code: 1
```

### Type/build

```text
node_modules/.bin/tsc --noEmit
exit_code: 0
```

```text
node_modules/.bin/vite build
✓ 749 modules transformed.
✓ built in 5.10s
exit_code: 0
```

Vite 仅报告既有大 chunk 建议，不阻断构建。

### Privacy / secrets / formatting scans

```text
git diff --check
exit_code: 0
```

```text
rg 'sk-...|AKIA...|PRIVATE KEY|password=...' .
no matches (rg exit 1)
```

```text
rg 'task11-secret-key-must-not-leak|synthetic-session-key|synthetic-failure-key|playwright-session-key|model.example|failure.example' dist artifacts
no matches (exit 0 due explicit `|| true`)
```

浏览器 privacy E2E 另验证：刷新后 key 只在允许的 `sessionStorage` credential JSON；IndexedDB、localStorage、项目备份、URL、DOM、console、pageerror 均不含 key。

## Coverage 声明

- 该 benchmark 是小型、合成、确定性的回归基准，覆盖声明由 manifest 严格校验；它不构成未知监管文件上的统计精度证明。
- E2E 使用生产 App 和浏览器真实解析/导出；唯一替代外部依赖的是 HTTPS 模型网络 route，与 MSW 风格边界兼容。
- full-flow 验证两个不同段落/条款的证据栏变化、不可变修改留痕、完整复核以及四个文件的文件头、DOCX 解包文本、PDF.js 可搜索文本与 full/quick 结构差异。
- failures 验证每项均保留可操作 UI、重试/返回路径，无白屏或假成功。

## 顾虑与环境说明

1. 内置 Browser runtime 初始化成功但 `browsers.list()` 返回空数组；按 browser skill 读取 bootstrap troubleshooting 后未切换到不相关浏览器工具。真实 Playwright Chromium 17/17 已覆盖可渲染行为。
2. 环境提供的 `pnpm` fallback 会尝试从 registry 获取 `@pnpm/exe`，网络受限后报 `GET https://registry.npmjs.org/@pnpm%2Fexe: fetch failed`；因此最终门禁使用项目已安装的直接 binaries。测试、E2E、benchmark、tsc、build 均为 fresh 实际执行。
3. benchmark perfect 分数只代表这组显式合成 fixture，不应对外表述为产品在未知文件上的 100% 或 95% 精度。
