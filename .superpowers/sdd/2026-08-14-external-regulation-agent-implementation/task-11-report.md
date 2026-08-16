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
rg '<synthetic privacy key and endpoint needles>' dist artifacts
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

---

# Task 11 fix round 1（2026-08-16）

Base: `1e4e4d41354cffc204f8a984c0fa19c22b0f61a5`

## 修复结论

- OCR 门禁同时计算总体 CER 与逐页准确率。任何低于 99% 或空 expected 页进入 `manualReviewPages`；只有严格绑定当前 `sourceId/page/expectedTextDigest/actualTextDigest` 的结构化人工检查记录才可从 `pendingManualReviewPages` 移除。错页、空复核人、非法时间、重复/冲突记录、陈旧 digest 均由 strict schema 或门禁拒绝。
- manifest 由声明性 coverage 升级为 fixture-bound corpus：5 个 sourceId 分别绑定真实合成 text PDF、scan PDF、含 `w:tbl` 的 DOCX、超过 24,000 字的 TXT、官方解读 TXT；DOCX 样本另绑定真实附件。loader 校验 benchmark 根目录约束、存在性、SHA-256、size、magic、PDF text layer/scan layer、OOXML table、长文长度、附件，以及官方解读到监管原文的配对。expected 与 actual 各自都必须覆盖全部 manifest sourceId，且所有 anchor/OCR sourceId 都必须已声明。
- 机器 JSON 的 `generatedAt` 默认使用 manifest `asOf`；可由 `--generated-at` 或 `SOURCE_DATE_EPOCH` 明确注入。同输入两次输出 byte-equal。
- full-flow 对四份下载逐一验证：DOCX 的 Heading1 严格为 full 11 章或 quick 8 章；PDF 标题唯一且同序；quick `top_changes` 为 3–5 项；evidence appendix 仅存在于 full。
- privacy E2E 刷新恢复后真实完成复核并下载 full/quick DOCX/PDF，扫描 DOCX 全部 XML/rels/coreProps 与 PDF raw bytes/PDF.js 文本；API key 与 endpoint 仅允许存在于 sessionStorage 配置，不进入 IDB/localStorage/backup/URL/DOM/log/error/report/dist/export。
- responsive 每个 1440x900、1024x768、768x1024 都覆盖 intake upload/nav/buttons 与 review evidence/actions/keyboard/overflow；1440 为右栏，1024/768 为下置证据。
- 所有 Playwright 测试使用统一 `console.error`/`pageerror` 捕获；仅 OCR 测试中的 Tesseract 已知旧参数 warning、failure-only 测试主动 abort/401/404/429 产生的浏览器资源错误采用逐文件注释白名单。其他错误一律失败。
- 生产 PDF.js 路径和测试 PDF 提取 helper 均在 `finally` 等待 loading task destroy 完成。
- `scan:secrets` 成为可复用 package script；支持 `--root` 和重复 `--needle`，供 Task 12 CI 使用。

生成器固定系统时钟并规范 ZIP 时间字段；连续两次生成的 table DOCX：

```text
e8df30e18f71ade8c5284c91cc26922effa55992862a44e63a35f3e069b2e959  regulatory-table.docx
e8df30e18f71ade8c5284c91cc26922effa55992862a44e63a35f3e069b2e959  regulatory-table.docx
```

## RED evidence

OCR gate RED:

```text
Command: node_modules/.bin/vitest run src/evaluation/evaluate-findings.test.ts
Test Files 1 failed (1)
Tests 3 failed | 8 passed (11)
Failure: expected pendingManualReviewPages, received undefined
```

Manifest boundary RED:

```text
Command: node_modules/.bin/vitest run src/evaluation/benchmark-input.test.ts
FAIL src/evaluation/benchmark-input.test.ts
Error: Failed to resolve import "./benchmark-input"
Test Files 1 failed (1)
exit_code: 1
```

Export structure RED:

```text
Command: node_modules/.bin/playwright test tests/e2e/full-flow.spec.ts --list
SyntaxError: './support/production-flow' does not provide an export named 'assertReportStructure'
exit_code: 1
```

Focused E2E first run correctly exposed that DOCX does not export findingId labels; the test was corrected to count the four fixture-bound statements, without changing production output:

```text
Running 5 tests using 1 worker
1 failed, 4 passed
Expected top_changes >= 3; received 0
```

## GREEN / focused outputs

```text
Command: node_modules/.bin/vitest run scripts/scan-secrets.test.ts src/evaluation/evaluate-findings.test.ts src/evaluation/benchmark-input.test.ts
Test Files 3 passed (3)
Tests 15 passed (15)
exit_code: 0
```

```text
Command: node_modules/.bin/playwright test tests/e2e/full-flow.spec.ts tests/e2e/privacy.spec.ts tests/e2e/responsive.spec.ts
Running 5 tests using 1 worker
5 passed (11.6s)
exit_code: 0
```

全局错误捕获首次 full run 报出 4 个预期非致命 console 类别（2 个 OCR、2 个 deliberate failure）；业务断言 13/17 已通过。初版 option-array whitelist 在 failure file 被 Playwright 解包成单值，随后改为逐文件 `test.extend` fixture。最终 focused：

```text
Command: node_modules/.bin/playwright test src/features/parsing/ocr/OcrWorker.e2e.ts tests/e2e/failures.spec.ts
Running 7 tests using 1 worker
7 passed (12.7s)
exit_code: 0
```

## Fresh benchmark gates

Passing fixture:

```text
BENCHMARK: synthetic-regression-v1 @ 1.1.0
RELEASE GATE: PASS
重大事项: precision=100.00%, recall=100.00%, TP=4, FP=0, FN=0
原子要求: precision=100.00%, recall=100.00%, TP=1, FP=0, FN=0
事实引用: 5/5 (100.00%)
OCR: errors=0, expectedCharacters=17, accuracy=100.00%
人工检查页: none
待人工检查页: none
失败规则: none
exit_code: 0
```

同一 pass 输入写入两个目录后：

```text
cmp /private/tmp/task11-fix-pass-a/benchmark-report.json /private/tmp/task11-fix-pass-b/benchmark-report.json
exit_code: 0
```

Deliberate failing fixture（loader 验证通过后由 threshold 产生 exit 1）：

```text
BENCHMARK: synthetic-regression-v1 @ 1.1.0
RELEASE GATE: FAIL
重大事项: precision=100.00%, recall=75.00%, TP=3, FP=0, FN=1
原子要求: precision=0.00%, recall=0.00%, TP=0, FP=1, FN=1
事实引用: 4/5 (80.00%)
OCR: errors=1, expectedCharacters=17, accuracy=94.12%
重大遗漏 IDs: EXP-TRANSITION
未标记 AI 推导 IDs: BAD-UNMARKED-IMPACT
人工检查页: SYNTH-REG-SCAN:p3
待人工检查页: SYNTH-REG-SCAN:p3
失败规则: critical_precision_below_95:transition_period,critical_recall_below_95:transition_period,atomic_precision_below_90,atomic_recall_below_85,citation_validity_below_100,unmarked_ai_inference,critical_omissions,ocr_accuracy_below_99,ocr_manual_review_pending
exit_code: 1
```

## Fresh full gates

```text
Command: node_modules/.bin/vitest run
Test Files 31 passed (31)
Tests 297 passed (297)
Duration 10.89s
exit_code: 0
```

Vitest 仍仅输出既有合成 CFF 字体 warning；PDF 导出和文本提取测试通过。

```text
Command: node_modules/.bin/playwright test
Running 17 tests using 1 worker
17 passed (33.0s)
exit_code: 0
```

```text
Command: node_modules/.bin/tsc --noEmit
exit_code: 0
```

```text
Command: node_modules/.bin/vite build
✓ 749 modules transformed.
✓ built in 7.03s
exit_code: 0
```

Vite 只报告既有大 chunk 建议。

## Privacy / scans

```text
Command: node --import tsx scripts/scan-secrets.ts --needle <synthetic-key-needle> --needle <synthetic-endpoint-needle>
SECRET SCAN PASS
exit_code: 0
```

```text
Command: git diff --check
exit_code: 0
```

```text
Command: rg '(BEGIN ... PRIVATE KEY|AKIA...|sk-...)' src scripts tests/fixtures/benchmark task-11-report.md
scripts/scan-secrets.test.ts: synthetic deliberate scanner-positive fixture only
exit_code: 0
```

隐私说明：测试 credential 仅为明确合成字符串；fixtures 均为合成/脱敏条款，不包含真实客户、个人、项目数据或密钥。browser privacy 深扫和构建后 secret scan 均通过。

## 自查与局限

1. 本基准仍是 **fixture-bound static regression corpus**：静态 actual 与本组版本化合成语料绑定，只证明该语料/该版本回归行为，不代表未知监管文件上达到 95% 或任何统计精度。
2. SHA-256、size 和有序 fixture 内容校验用于检测测试输入漂移，不是发布者身份认证或数字签名。
3. Playwright whitelist 仅限已验证的 Tesseract 旧参数 warning 和 failure-only 测试主动制造的浏览器网络资源错误；不存在通配 pageerror 白名单。
4. `dist/` 为 build 输出且未纳入 commit；构建后的 secret scan 已实际执行。

---

# Task 11 fix round 2/5（2026-08-16）

Base：`1cdd9bb2c0b29f6781b4f79b16473a9514a43b20`

## 结构性修复

- benchmark loader 现在对 manifest、source、attachment、scan ground-truth 做 `lstat` symlink 拒绝、逐段路径检查、`realpath` containment 和 canonical path 唯一性校验。
- TXT、DOCX、text PDF 均从真实 fixture 建立页/段/条解析单元，并逐个反查 expected/actual Finding 与 AtomicRequirement anchor；扫描 PDF 必须零 text layer、至少一个真实 image paint op，并绑定含 SHA-256、复核人、复核时间的专家 ground-truth。
- corpus 新增闭合 `officialPrimarySourceIds`，loader 同时核验 manifest 配对、官方解读 finding parent 及其监管原文 anchor。raw `evaluateFindings` 永远包含 `fixture_evidence_not_validated`，只有 loader 返回的 bundle 能进入 fixture-validated evaluator。
- 合成 fixture 已重建为真实两页 text PDF、三页含 Image XObject 的 scan PDF、含段落和 OOXML table 的 DOCX、超过 24k 字符的 long TXT、official TXT 与附件；无真实监管、客户、个人或密钥数据。
- quick report E2E verifier 改为 DOCX Heading1 边界内的 `w:numPr` 条目计数，以及 PDF Heading 边界内独立 `•` marker 行计数；两项/无 marker 必须失败，四项通过。
- secret scanner 不再跳过 NUL 文件；DOCX 扫描 raw bytes 及全部可解压 ZIP entry（包含 XML/rels/coreProps），PDF 扫描 raw bytes 和 PDF.js 提取文本且 finally destroy，缺少任何 required root 立即失败。
- Playwright console contract 改为每个测试显式 message + URL + count，所有期望必须恰好消费；额外同类错误和未消费期望均失败，pageerror 永不允许。Tesseract 仅允许已知 8 个旧参数 warning，各 1 次且绑定 exact same-origin wasm.js URL。
- privacy E2E 走真实“记住接口地址和模型”路径：endpoint/model 可进入 IndexedDB；API key 不可进入 IndexedDB。API key/endpoint 均不得进入 localStorage、backup、URL、DOM、console/error、四个导出文件或 dist。
- `.gitattributes` 增加递归 synthetic PDF/DOCX binary 标记。

## RED evidence

Anchor/fixture boundary 首轮：

```text
Command: vitest --run src/evaluation/benchmark-input.test.ts src/evaluation/evaluate-findings.test.ts
benchmark-input.test.ts: 8 tests | 6 failed, 2 passed
Observed failures: validatedAnchorCount missing; symlink followed; fabricated quote/wrong locator not rejected; blank scan accepted; raw evaluator lacked fixture_evidence_not_validated.
evaluate-findings.test.ts: 11 passed
exit_code: 1
```

Format-aware secret scan RED：

```text
Command: vitest --run scripts/scan-secrets.test.ts
Test Files 1 failed (1)
Tests 2 failed | 1 passed (3)
Failures: NUL PDF and compressed DOCX returned []; missing required root resolved [] instead of rejecting.
exit_code: 1
```

Console exact-source 首轮 full browser evidence：

```text
Command: playwright test
Running 18 tests using 1 worker
16 passed, 2 failed
Both failures were exact OCR warning source mismatches: actual URL was the same-origin
/ocr/tesseract-7.0.0-data-1.0.0/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js,
not an empty URL. No business assertion failed.
exit_code: 1
```

## GREEN evidence

Focused Vitest：

```text
Command: vitest --run src/evaluation/benchmark-input.test.ts src/evaluation/evaluate-findings.test.ts scripts/scan-secrets.test.ts playwright-fixtures.test.ts src/features/reports/export-pdf.test.tsx src/features/reports/report-builders.test.ts
Test Files 6 passed (6)
Tests 43 passed (43)
exit_code: 0
```

Full Vitest：

```text
Command: vitest --run
Test Files 32 passed (32)
Tests 305 passed (305)
Duration 10.93s
exit_code: 0
```

Fresh full Playwright after exact OCR URL correction：

```text
Command: playwright test --reporter=line
Running 18 tests using 1 worker
18 passed (27.7s)
exit_code: 0
```

该 full run 覆盖 production full-flow、真实四文件导出、privacy、CORS/network/401/404/429/timeout/schema/OCR/export failure、1440/1024/768 responsive，以及 quick structural adversarial verifier。

Benchmark pass：

```text
Command: node --import tsx scripts/run-benchmark.ts --output-dir /private/tmp/task11-benchmark-pass
RELEASE GATE: PASS
重大事项 precision=100.00%, recall=100.00%, TP=4, FP=0, FN=0
原子要求 precision=100.00%, recall=100.00%, TP=1, FP=0, FN=0
事实引用 5/5 (100.00%)
OCR accuracy=100.00%
exit_code: 0
```

Deliberate failing fixture：

```text
Command: node --import tsx scripts/run-benchmark.ts --actual actual-findings-failing.json
RELEASE GATE: FAIL
重大事项 recall=75.00%; 原子要求 precision=0.00%, recall=0.00%
事实引用 4/5 (80.00%); OCR accuracy=94.12%
重大遗漏 EXP-TRANSITION; 未标记推导 BAD-UNMARKED-IMPACT
exit_code: 1
```

Final static/build/privacy gates：

```text
Command: tsc --noEmit
exit_code: 0

Command: vite build
✓ 749 modules transformed.
✓ built in 4.72s
exit_code: 0

Command: node --import tsx scripts/scan-secrets.ts
SECRET SCAN PASS
exit_code: 0

Command: git diff --check
exit_code: 0
```

## Benchmark 声明与自查

本结果仍是 **fixture-bound static regression corpus**：actual 是与版本化合成 fixture 强绑定的静态回归结果，只证明本测试语料和本版本行为，不代表未知文件达到 95% 产品精度。fixture SHA-256/size/locator 绑定用于发现测试语料漂移，不是来源身份认证。PDF.js 在 benchmark/scanner/E2E 的 document loading task 均通过 `finally destroy()` 释放。代码与 fixture 自查未发现真实客户、个人、监管项目数据或真实凭据。

---

# Task 11 fix round 3/5（2026-08-16）

Base：`96fbfd723dfe01d908543551d3f916298c312376`

## 修复结果

- manifest、expected、actual、sources、attachments、scan GT 全部进入同一 canonical uniqueness 集；expected/actual canonical path 相同时，在读取 corpus 前拒绝。
- scan GT 每页新增完整 `expectedText`。expected OCR page 必须与 GT 在 NFKC/换行空白规范化后 exact 相等，actual 必须保持相同 source/page 完整覆盖但允许文字差异用于 CER；既有 review digest 仍严格绑定 GT-authorized expected page 和当前 actual page。
- raw `evaluateFindings` 无条件输出 `fixture_evidence_not_validated`。删除公开 validated evaluator 后门；loader 返回递归 frozen bundle，并在模块私有 `WeakSet` 登记对象身份。`evaluateValidatedBenchmark(unknown)` 只接受该精确对象，structured clone、spread clone、手造对象和修改均拒绝。
- benchmark scan fixture 改为确定性复用仓内 Task5 合成 OCR fixture：真实 1200×700 中文像素图、0 text layer、真实 image paint。人工渲染确认可视内容为“合成扫描监管文件 / 第一条 银行业金融机构不得泄露客户信息 / 仅用于脱敏测试，不代表任何真实机构或项目”。loader 要求至少 300×200、像素数据足够且非纯色；blank/1×1 均拒绝。
- DOCX scanner 新增 256 entries、32 MiB 单 entry、128 MiB total、200:1 ratio 限额；inflate 前检查 local header，使用 `maxOutputLength`，后验核对 declared/actual size，并逐 entry 对比 central-directory method/compressed/uncompressed metadata。data descriptor、重复 entry、越界和不支持压缩均受控失败，不落盘解压。

## RED

```text
Command: vitest --run src/evaluation/benchmark-input.test.ts scripts/scan-secrets.test.ts
benchmark-input.test.ts: 9 tests | 8 failed, 1 passed
Reason: GT expectedText was unrecognized; expected-as-actual, forged OCR and forged capability were not yet protected.
scan-secrets.test.ts: 4 tests | 1 failed
Reason: declared oversize / high-ratio / 300-entry archives resolved [] instead of rejecting.
exit_code: 1
```

## Focused GREEN

```text
Command: vitest --run src/evaluation/benchmark-input.test.ts scripts/scan-secrets.test.ts src/evaluation/evaluate-findings.test.ts
Test Files 3 passed (3)
Tests 24 passed (24)
exit_code: 0
```

额外 1×1 image adversarial 加入后：

```text
Command: vitest --run src/evaluation/benchmark-input.test.ts
Test Files 1 passed (1)
Tests 9 passed (9)
exit_code: 0
```

## Benchmark gates

```text
Command: node --import tsx scripts/run-benchmark.ts --output-dir /private/tmp/task11-fix3-pass
RELEASE GATE: PASS
重大事项 precision=100.00%, recall=100.00%
原子要求 precision=100.00%, recall=100.00%
事实引用 5/5 (100.00%)
OCR errors=0, expectedCharacters=51, accuracy=100.00%
exit_code: 0
```

```text
Command: node --import tsx scripts/run-benchmark.ts --actual actual-findings-failing.json --output-dir /private/tmp/task11-fix3-fail
RELEASE GATE: FAIL
重大事项 recall=75.00%
原子要求 precision=0.00%, recall=0.00%
事实引用 4/5 (80.00%)
OCR errors=1, expectedCharacters=51, accuracy=98.04%
重大遗漏 EXP-TRANSITION；未标记推导 BAD-UNMARKED-IMPACT
exit_code: 1
```

## Fresh full gates

```text
Command: vitest --run
Test Files 32 passed (32)
Tests 307 passed (307)
Duration 9.76s
exit_code: 0
```

```text
Command: playwright test --reporter=line
Running 18 tests using 1 worker
18 passed (25.6s)
exit_code: 0
```

```text
Command: tsc --noEmit
exit_code: 0

Command: vite build
✓ 749 modules transformed.
✓ built in 4.61s
exit_code: 0

Command: node --import tsx scripts/scan-secrets.ts --needle <synthetic-key> --needle <synthetic-endpoint>
SECRET SCAN PASS
exit_code: 0

Command: git diff --check
exit_code: 0
```

## Reproducibility / privacy note

Generator 重跑后的 scan PDF SHA-256 为 `4b69b710ce0b8602aa2b4e01f2e93c074ef946848fbc0ef3f36cc12997f392c1`，GT SHA-256 为 `3bf30ba7de0c9490be70b065b7dab63579dc41c2a68be657e7c3e51413ac3d43`，均与 manifest 一致。本轮仍仅使用合成/脱敏条款，不含真实监管项目、客户、个人或密钥数据。该基准仍是 fixture-bound static regression corpus，不构成未知文件产品精度承诺。
