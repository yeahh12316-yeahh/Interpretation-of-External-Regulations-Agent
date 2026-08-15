# Task 10 implementation report

Date: 2026-08-16 (Asia/Shanghai)

Base HEAD: `d6884fa`

## Outcome

Implemented the production report step with two materially different report structures that share one allow-listed `ReportModel` source:

- Full `外规解读报告`: exactly 11 ordered sections, including evidence and review-history appendix.
- `新规快评`: exactly the required 8 keys, with a 3–5 item top-changes list when the authoritative finding set supplies enough changes (the representative fixture supplies 3).
- Browser-local editable DOCX and searchable PDF exports.
- Production `WorkflowShell` integration, two report tabs, four download combinations, loading/error/retry/disabled states, keyboard tab switching, and 1024 px responsive verification.
- Draft export remains allowed only with authoritative parsing evidence and eligible verified content, and is visibly watermarked `AI草稿，未经人工复核`. Human-final status remains controlled solely by Task 8 `canFinalizeSession`.

The builder does not call a model and does not synthesize prose. It consumes the complete Task 9 `WorkflowSession`, including authoritative parse results, official-to-primary pairing, review audits/actions, and current rule attestations.

## TDD evidence

### Builder RED

Command:

```text
pnpm vitest run src/features/reports/report-builders.test.ts
```

Raw result:

```text
FAIL  src/features/reports/report-builders.test.ts
Error: Failed to resolve import "./build-full-report"
```

After the minimum builders were added, the first fixture run exposed an authoritative-source mismatch: the fixture joined parsed paragraphs with `\n`, while Task 8 authoritatively reconstructs plain-text units with `\n\n`. Only the fixture was corrected; production validation was not relaxed.

Builder GREEN:

```text
Test Files  1 passed (1)
Tests       3 passed (3)
```

### Export/UI RED

Command:

```text
pnpm vitest run src/features/reports
```

Raw result before exporters/UI existed:

```text
FAIL  src/features/reports/ReportPage.test.tsx
FAIL  src/features/reports/export-docx.test.ts
FAIL  src/features/reports/export-pdf.test.tsx
Error: Failed to resolve import "./ReportPage" / "./export-docx" / "./export-pdf"
```

The first real PDF test then failed on the Node test path for the local OTF. Production continues to use a Vite same-origin asset URL; the test-only branch resolves the repository file. The first DOCX visual render exposed missing CJK fallback in the bundled LibreOffice runtime. A RED regression assertion was added for explicit OOXML `w:eastAsia="Source Han Sans"`; production validation was not weakened.

Focused GREEN after implementation and the visual fix:

```text
Test Files  5 passed (5)
Tests       19 passed (19)
```

The PDF.js extraction test emits CFF parser warnings for this old CFF OTF, but its searchable Chinese-text assertions pass. Independent Poppler extraction and rendering below also pass.

## Safety and data-boundary implementation

- `createReportContext` first requires Task 8 authoritative parsing evidence.
- Each candidate finding is revalidated through the Task 8 source index with `officialPrimarySourceIds`, `atomicRequirements`, and current `RuleReviewAttestation` resolution.
- Deleted, `pending_confirmation`, failed, stale/uncontrolled reviewed findings, and credential-looking material are excluded.
- Human findings require a current `add_human` action hash/snapshot; modified findings require the latest matching `ReviewAudit`; confirmed findings require a matching append-only action.
- Evidence keeps source ID/type, page, article, paragraph, exact quote, and distinct `监管原文` / `官方解读` labels.
- AI inference and human judgment retain `AI推导` / `人工判断` labels.
- The same built `ReportModel` instance drives preview and export.
- No report builder or exporter invokes the model gateway.
- DOCX/PDF modules are dynamic imports. The 16.5 MB font and 1.35 MB minified PDF renderer chunk are not in the initial application chunk.
- Object URLs are revoked after a 60-second download grace period, avoiding a cross-browser download race while still releasing the Blob URL.
- `generatedAt` is injectable and held in a stable component ref; deterministic tests use `2026-08-16T03:00:00.000Z`.

## DOCX structure and extraction QA

The documents artifact-operation marker was run once before saving the two representative DOCX outputs:

```text
node .../documents/container_tools/mark_artifact_operation_started.mjs \
  --operation-kind create --expected-output-count 2 --output-format docx
exit 0 (no stdout)
```

Representative files were downloaded through the actual `ReportPage` browser handlers:

```text
外规报告 QA 项目-外规解读报告.docx
外规报告 QA 项目-新规快评.docx
```

Both passed `unzip -t` with `No errors detected`. Package inspection confirmed:

```text
word/document.xml
word/styles.xml
word/header1.xml
word/footer1.xml
word/footnotes.xml
word/numbering.xml
word/fontTable.xml
```

`word/document.xml` extraction contains the full 11-section report and separate 8-section quick commentary, including Chinese titles, project version, generated time, review state, source list, claim labels, and evidence locators. OOXML assertions also confirm:

```text
style: standard_business_brief
masthead: memo_masthead pattern
table layout: fixed
table width: 9360 DXA
font mapping: w:eastAsia="Source Han Sans"
real footnote references and editable text/runs
```

### DOCX visual QA

Both files were rendered with the bundled `render_docx.py` and LibreOffice. The bundled LibreOffice Fontconfig initially did not enumerate any CJK font directories and produced missing glyphs. Final QA therefore used an explicit Fontconfig containing the repository Source Han Sans directory; no font was installed and no system setting was changed.

Pages inspected individually:

```text
Full DOCX: 4 / 4 pages
Quick DOCX: 2 / 2 pages
```

Final result: PASS. Chinese glyphs, headings, bullets, headers, repeated draft watermark, footnotes, the fixed-width evidence table in its independent final section, and footer page numbers are visible. No clipping, overlap, or blank page was observed.

## PDF structure, extraction, and visual QA

The PDF artifact-operation marker was run once before saving the two representative PDFs:

```text
node .../pdf/container_tools/mark_artifact_operation_started.mjs \
  --operation-kind create --expected-output-count 2 --output-format pdf
exit 0 (no stdout)
```

Representative browser downloads:

```text
外规报告 QA 项目-外规解读报告.pdf
外规报告 QA 项目-新规快评.pdf
```

Poppler results:

```text
Full PDF: 4 pages, US Letter 612 x 792 pt, 108731 bytes
Quick PDF: 2 pages, US Letter 612 x 792 pt, 102499 bytes
Font: ZQCUPH+SourceHanSans-Normal, CID Type 0C, embedded=yes, subset=yes, Unicode=yes
```

`pdftotext` extracted searchable Chinese text for both files, including titles, all section headings, watermark, source list, labels, dates, anchors, and revision trail.

All 6 PDF pages were rendered with Poppler `pdftoppm` and inspected individually. Result: PASS. The restrained white/black/`#86BC25` system is consistent, text is legible, page breaks are sound, repeated watermark/header/footer is visible, and there is no clipping or unauthorized logo.

## Font provenance and license evidence

Bundled binary:

```text
src/assets/SourceHanSans-Normal.otf
Source metadata version: 1.000;ADBE;SourceHanSans-Normal;ADOBE
SHA-256: f9f54f68326c517fc17138dd79a7f140ed7f084acff1b6a56052d2ae717b446b
Exact local source:
/Users/yeahh/Documents/Blackmagic Design/入门篇_配套素材礼包/
13集_免费商用字体/syht/SourceHanSans-Normal.otf
```

The source and repository copy have identical SHA-256 values. This specific v1.000 binary’s embedded metadata states Apache License 2.0 and names `http://www.apache.org/licenses/LICENSE-2.0.html`. The repository includes the matching full license at `src/assets/LICENSE-SourceHanSans.txt`. This statement is specific to the checked binary and does not claim that later Source Han Sans releases use the same license.

## Browser and production integration QA

Focused browser command:

```text
TASK10_QA_OUTPUT_DIR=.../work/task10-qa \
  node_modules/.bin/playwright test src/features/reports/ReportPage.e2e.ts
```

Raw result:

```text
1 passed (2.6s)
```

Verified at 1024 x 900:

- no document horizontal overflow;
- full report and quick report are visibly distinct;
- keyboard ArrowRight changes the selected tab;
- draft watermark is visible;
- full DOCX, full PDF, quick DOCX, and quick PDF all produce real browser downloads with valid ZIP/PDF magic bytes.

The production `WorkflowShell` E2E now reaches the real `ReportPage` after upload → parse → model analysis → review → persistence reload and verifies both report structures and enabled exports. No demo session was added to production.

## Fresh final gates

### TypeScript, unit/integration, and build

```text
node_modules/.bin/vitest run
Test Files  28 passed (28)
Tests       262 passed (262)

node_modules/.bin/tsc --noEmit
exit 0

node_modules/.bin/vite build
748 modules transformed
build completed successfully
```

Build output confirms on-demand chunks:

```text
dist/assets/export-docx-*.js     359.07 kB (104.09 kB gzip)
dist/assets/export-pdf-*.js    1354.26 kB (483.97 kB gzip)
dist/assets/SourceHanSans-*.otf 16504.82 kB
```

Vite reports its advisory >500 kB warning for the PDF exporter and existing parser/main chunks. The report exporter and font are nevertheless isolated behind dynamic imports rather than being loaded in the initial report-independent path.

### Full Playwright

```text
node_modules/.bin/playwright test
8 passed (11.0s)
```

This includes real local OCR, production workflow, persistence/reload, 1024 px evidence/upload layouts, and all four report downloads.

### Diff and privacy/static scans

```text
git diff --check
exit 0
```

Exact-value scans of `dist/` and the four saved representative files found none of:

```text
playwright-session-key
session-only-secret provider detail
https://model.example
sk-<token>
Bearer <token>
```

OOXML contains no report media/logo entries. Exported models and files contain no `apiKey`, endpoint, authorization, credential, or session-secret values. The public font asset contains only the recorded font/license metadata. No Deloitte logo asset was added.

## Self-review and remaining concerns

- The full and quick reports use separate section selection/ordering and are not title swaps.
- Draft export semantics follow the design: authoritative verified content may be exported only with the conspicuous watermark; final status still requires the Task 8 gate.
- Report data flow preserves official pairing, audit chains, and current attestations rather than flattening or bypassing them.
- The DOCX references Source Han Sans but does not embed the 16.5 MB font, keeping it editable and compact; Word/LibreOffice environments need that font or an available CJK fallback. Required QA explicitly loaded the repository copy through Fontconfig and passed. PDF embeds a Unicode subset and is self-contained.
- PDF.js prints non-fatal CFF diagnostics in the unit test for this v1.000 font. Independent Poppler text extraction, font inspection, and all-page rendering pass; no PDF defect was observed.

---

## Fix round 1/5 — reviewer findings

Fix base: `5f2f94ce63672a12ad95dfe3f88ac1e0061d8b14`

### RED evidence

The first focused reviewer-reproduction run covered the production workflow,
builders, report page, exporters, review actions, and Task 7 taxonomy:

```text
Test Files: focused reviewer batch
Tests: 84 total
Passed: 69
Failed: 15
```

Failures reproduced all six blocking findings: no production draft entry,
quick reports with fewer than three changes remained exportable,
`key_matter:implementation_arrangement` was absent from both date sections,
human recommended actions were trapped in the appendix, institutional impact
was not seven-dimensional, and keyboard tab movement did not move DOM focus.

The first visual-regression test for the reported DOCX clipping failed before
implementation:

```text
src/features/reports/export-docx.test.ts
1 failed, 2 passed
expected styles.xml to contain ReportFootnote
```

The structural section/position test also failed RED:

```text
src/features/reports/export-docx.test.ts
1 failed, 2 passed
expected 2 <w:sectPr> nodes but received 1
```

### Implemented fixes

1. Production draft path
   - `WorkflowShell` exposes `预览/导出 AI 草稿` from the review step only when
     Task 8 authoritative parse/OCR validation succeeds and at least one
     report-eligible verified finding exists.
   - Opening the draft does not mutate the persisted workflow step and does
     not weaken `canFinalizeSession`; final report navigation remains gated by
     the Task 8 human-finalization rules.
   - Both formats retain the conspicuous `AI草稿，未经人工复核` watermark.

2. Quick-report 3–5 gate
   - Preview retains the real 0/1/2 items and shows the exact insufficiency
     reason.
   - Quick DOCX/PDF export rejects fewer than 3 or more than 5 top changes at
     both UI and exporter boundaries. No filler facts are created.
   - Full-report exportability is independent of this quick-only cardinality.

3. Closed date routing
   - Both builders now route the exact category
     `key_matter:implementation_arrangement` into their date/implementation
     sections alongside the other explicit closed categories.
   - No free-text/substring classification was introduced.

4. Closed human-judgment purpose
   - The accessible add-human dialog requires a closed report purpose:
     `generic` or `recommended_action`.
   - Controlled action creation derives the audited Finding category:
     generic → `human_review`; action → `recommended_action:priority`.
   - Task 9 snapshot hashing/replay therefore persists and revalidates the
     purpose through the existing immutable action chain. Real actions reach
     full/quick action sections; generic judgments remain in the appendix.

5. Seven-dimensional institutional impact
   - Report items preserve closed category and dimension metadata.
   - Full reports always render governance, institution, process, system,
     data, people, and reporting groups, using explicit empty states instead
     of invented content.
   - Quick affected scope retains concise dimension labels.
   - Task 7's closed live-response taxonomy and prompt now include
     `institution`; historical validation keeps the exact old
     `institution_impact` compatibility value but rejects unknown dimensions.

6. Keyboard and download lifecycle
   - ArrowLeft/ArrowRight call `preventDefault`, switch the selected report,
     update roving `tabindex`, and focus the active tab.
   - Browser Blob URLs are revoked after a 60-second grace period; the test
     verifies that they are not revoked synchronously and are eventually
     released.

### Native DOCX footnote compatibility — failed attempts and structural fix

Two visual attempts were deliberately recorded rather than hidden:

```text
Attempt 1: compact native ReportFootnote style
Result: quick 2/2 pages passed; full final footnote still clipped.

Attempt 2: page-break-before evidence appendix
Result: appendix table moved, but the preceding page's last footnote still
clipped. Work stopped under the same-root-cause-twice rule.
```

The authorized structural fix retained Word-native footnotes and clickable
references. The evidence appendix is now a true independent final DOCX section.
Both section-property nodes explicitly contain:

```xml
<w:footnotePr><w:pos w:val="beneathText"/></w:footnotePr>
```

The table remains fixed-width DXA and rows keep natural height/page flow. One
actual-app export/regeneration was then performed. Final LibreOffice render:

```text
Full DOCX: 4 / 4 pages inspected — PASS
Quick DOCX: 2 / 2 pages inspected — PASS
```

All Chinese text, native footnotes 1–13, headers, watermark, footers, the full
evidence table, and revision trail are visible with no clipping, overlap,
missing glyphs, or blank page. `unzip -t` passed for both files. OOXML checks
confirm two full-report `sectPr` nodes, two `footnotePr` nodes, native
`word/footnotes.xml`, `FootnoteReference` runs, `ReportFootnote` styling, and
the independent final section.

### Final representative files and extraction

All four files came from the actual `ReportPage` browser download handlers in
`work/task10-fix1-qa-structural`:

```text
Full DOCX   14934 bytes  SHA-256 ab7ee4ad5a81e116895bc734d0b231913e8c25fc24f65c304db1a4112b9527dc
Quick DOCX  12355 bytes  SHA-256 76ee87cccfb36ec4f5a9706cb3d0182e532f27e9ade8133fa2fb12b16ec663a3
Full PDF   108731 bytes  SHA-256 9e4004f60f35518094f78d3f60553def0aef43a7138d890b1b52806e01260f72
Quick PDF  102499 bytes  SHA-256 2fb60b20a210e50507893aea83dc41509947799ef2000950dbdd091428321e25
```

Poppler reported full PDF 4 pages and quick PDF 2 pages, both US Letter. Both
contain an embedded/subsetted Unicode `SourceHanSans-Normal` CID font.
`pdftotext -layout` recovered titles, watermark, report sections, closed
dimension labels, implementation arrangements, evidence locators, and human
revision text. All six browser-PDF pages were rendered with `pdftoppm` and
inspected: PASS, with no clipping, overlap, unauthorized logo, or missing
Chinese glyph.

### Fresh GREEN gates

Focused Vitest:

```text
Test Files  8 passed (8)
Tests       92 passed (92)
```

Full Vitest:

```text
Test Files  28 passed (28)
Tests       262 passed (262)
```

Full Playwright, including production App draft path, production analysis and
review flow, report focus behavior, four downloads, OCR, and 1024 px layout:

```text
8 passed (11.5s)
```

Type/build:

```text
tsc --noEmit: exit 0
vite build: 748 modules transformed; completed successfully
```

The advisory >500 kB warning remains for existing parser/main and PDF chunks.
The DOCX exporter (359.07 kB), PDF exporter (1354.26 kB), and 16.5 MB CJK font
remain separate on-demand assets rather than entering the initial bundle.

Final hygiene:

```text
git diff --check: exit 0
unzip -t full/quick DOCX: No errors detected
exact-value credential scan over dist/ and all four exports: no matches
generated-file scan for apiKey, authorization, endpoint, or session-secret
values: no matches
```

No report/media/logo assets were added. Builders still do not call the model,
and no API key, endpoint, credential, session secret, unsafe HTML, or model log
was introduced into report models, exports, or the production build.
