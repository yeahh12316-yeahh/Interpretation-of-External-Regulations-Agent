import { z } from "zod";

import {
  CRITICAL_CATEGORIES,
  type EvaluationMetrics,
} from "./evaluate-findings";

const FileTypeSchema = z.enum(["pdf_text", "pdf_scan", "docx", "txt"]);
const ModalitySchema = z.enum([
  "text",
  "scanned",
  "table",
  "attachment",
  "long_document",
]);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const ArtifactSchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    size: z.number().int().positive(),
  })
  .strict();

const exactCoverage = (
  actual: readonly string[],
  required: readonly string[],
): boolean =>
  [...new Set(actual)].sort().join("\u0000") ===
  [...required].sort().join("\u0000");

export const BenchmarkManifestSchema = z
  .object({
    benchmarkId: z.string().min(1),
    benchmarkVersion: z.string().min(1),
    asOf: z.string().datetime(),
    description: z.string().min(1),
    disclaimer: z.string().min(1),
    expectedFile: z.string().min(1),
    actualFile: z.string().min(1),
    failingActualFile: z.string().min(1),
    coverage: z
      .object({
        fileTypes: z.array(FileTypeSchema),
        regulatorTypes: z.array(z.string().min(1)).min(1),
        modalities: z.array(ModalitySchema),
        officialInterpretation: z.array(z.enum(["with", "without"])),
        requiredCriticalCategories: z.array(z.enum(CRITICAL_CATEGORIES)),
        sampleCount: z.number().int().positive(),
      })
      .strict(),
    samples: z
      .array(
        z
          .object({
            sourceId: z.string().min(1),
            sourceType: z.enum(["regulatory_text", "official_interpretation"]),
            path: z.string().min(1),
            sha256: Sha256Schema,
            size: z.number().int().positive(),
            fileType: FileTypeSchema,
            regulatorType: z.string().min(1),
            modalities: z.array(ModalitySchema).min(1),
            officialInterpretation: z.enum(["with", "without"]),
            primarySourceId: z.string().min(1).optional(),
            attachments: z.array(ArtifactSchema).default([]),
            synthetic: z.literal(true),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const sampleFileTypes = manifest.samples.map(({ fileType }) => fileType);
    const sampleModalities = manifest.samples.flatMap(
      ({ modalities }) => modalities,
    );
    const sampleInterpretation = manifest.samples.map(
      ({ officialInterpretation }) => officialInterpretation,
    );
    const sampleRegulatorTypes = manifest.samples.map(
      ({ regulatorType }) => regulatorType,
    );
    if (
      !exactCoverage(manifest.coverage.fileTypes, FileTypeSchema.options) ||
      !exactCoverage(manifest.coverage.modalities, ModalitySchema.options) ||
      !exactCoverage(manifest.coverage.officialInterpretation, [
        "with",
        "without",
      ]) ||
      !exactCoverage(
        manifest.coverage.requiredCriticalCategories,
        CRITICAL_CATEGORIES,
      ) ||
      manifest.coverage.sampleCount !== manifest.samples.length ||
      !exactCoverage(sampleFileTypes, manifest.coverage.fileTypes) ||
      !exactCoverage(sampleModalities, manifest.coverage.modalities) ||
      !exactCoverage(
        sampleInterpretation,
        manifest.coverage.officialInterpretation,
      ) ||
      !exactCoverage(sampleRegulatorTypes, manifest.coverage.regulatorTypes) ||
      new Set(manifest.samples.map(({ sourceId }) => sourceId)).size !==
        manifest.samples.length
    )
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "benchmark manifest 未完整声明必需文件、模态、解读和类别覆盖",
      });
    const sampleById = new Map(
      manifest.samples.map((sample) => [sample.sourceId, sample]),
    );
    manifest.samples.forEach((sample, index) => {
      if (
        sample.modalities.includes("attachment") !==
        sample.attachments.length > 0
      )
        context.addIssue({
          code: "custom",
          path: ["samples", index, "attachments"],
          message: "attachment 模态必须绑定实际附件文件",
        });
      if (sample.sourceType === "official_interpretation") {
        const primary = sample.primarySourceId
          ? sampleById.get(sample.primarySourceId)
          : undefined;
        if (!primary || primary.sourceType !== "regulatory_text")
          context.addIssue({
            code: "custom",
            path: ["samples", index, "primarySourceId"],
            message: "官方解读必须配对 manifest 中的监管原文",
          });
      } else if (sample.primarySourceId) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "primarySourceId"],
          message: "监管原文不得声明 primarySourceId",
        });
      }
    });
  });

export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;

export interface EvaluationSummaryInput {
  readonly benchmarkId: string;
  readonly benchmarkVersion: string;
  readonly disclaimer: string;
  readonly metrics: EvaluationMetrics;
}

const ratio = (value: number | null): string =>
  value === null ? "not_evaluable" : `${(value * 100).toFixed(2)}%`;

export const renderEvaluationSummary = (
  input: EvaluationSummaryInput,
): string => {
  const lines = [
    `BENCHMARK: ${input.benchmarkId} @ ${input.benchmarkVersion}`,
    `RELEASE GATE: ${input.metrics.releaseGate.passed ? "PASS" : "FAIL"}`,
    `声明: ${input.disclaimer}`,
    "门槛: 重大类别 precision/recall >= 95%",
    "门槛: 原子要求 precision >= 90%, recall >= 85%",
    "门槛: 事实引用有效率 = 100%",
    "门槛: 未标记 AI 推导 = 0；重大事项遗漏 = 0",
    "门槛: OCR 关键字段字符准确率 >= 99%",
    `重大事项: precision=${ratio(input.metrics.critical.precision)}, recall=${ratio(input.metrics.critical.recall)}, TP=${input.metrics.critical.tp}, FP=${input.metrics.critical.fp}, FN=${input.metrics.critical.fn}`,
    `原子要求: precision=${ratio(input.metrics.atomic.precision)}, recall=${ratio(input.metrics.atomic.recall)}, TP=${input.metrics.atomic.tp}, FP=${input.metrics.atomic.fp}, FN=${input.metrics.atomic.fn}`,
    `事实引用: ${input.metrics.citationValidity.valid}/${input.metrics.citationValidity.total} (${ratio(input.metrics.citationValidity.rate)})`,
    `OCR: errors=${input.metrics.ocr.errors}, expectedCharacters=${input.metrics.ocr.expectedCharacters}, accuracy=${ratio(input.metrics.ocr.accuracy)}`,
    `重大遗漏 IDs: ${input.metrics.criticalOmissions.join(",") || "none"}`,
    `未标记 AI 推导 IDs: ${input.metrics.unmarkedAiInferenceIds.join(",") || "none"}`,
    `人工检查页: ${input.metrics.ocr.manualReviewPages.map(({ sourceId, page }) => `${sourceId}:p${page}`).join(",") || "none"}`,
    `待人工检查页: ${input.metrics.ocr.pendingManualReviewPages.map(({ sourceId, page }) => `${sourceId}:p${page}`).join(",") || "none"}`,
    `失败规则: ${input.metrics.releaseGate.failures.join(",") || "none"}`,
  ];
  return `${lines.join("\n")}\n`;
};
