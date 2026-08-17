import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { WorkflowSession } from "../../app/workflow-store";
import { buildFullReport } from "./build-full-report";
import { buildQuickCommentary } from "./build-quick-commentary";
import {
  reportExportBlockReason,
  type ReportModel,
  type ReportType,
} from "./report-model";
import { ReportPreview } from "./ReportPreview";

type ExportFormat = "docx" | "pdf";

export interface ReportExporters {
  readonly docx: (report: ReportModel) => Promise<Blob>;
  readonly pdf: (report: ReportModel) => Promise<Blob>;
}

export type ReportDownload = (blob: Blob, fileName: string) => void;

const defaultExporters: ReportExporters = {
  docx: async (report) => (await import("./export-docx")).exportDocx(report),
  pdf: async (report) => (await import("./export-pdf")).exportPdf(report),
};

export const browserDownload: ReportDownload = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

const safeFileStem = (value: string): string =>
  value.replace(/[\\/:*?"<>|]+/gu, "-").trim() || "外规解读成果";

export const ReportPage = ({
  session,
  exporters = defaultExporters,
  download = browserDownload,
  generatedAt,
}: {
  session: WorkflowSession;
  exporters?: ReportExporters;
  download?: ReportDownload;
  generatedAt?: string;
}) => {
  const [reportType, setReportType] = useState<ReportType>("full_report");
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [failedFormat, setFailedFormat] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stableGeneratedAt = useRef(
    generatedAt ?? new Date().toISOString(),
  ).current;
  const fullTabRef = useRef<HTMLButtonElement>(null);
  const quickTabRef = useRef<HTMLButtonElement>(null);
  const reports = useMemo(
    () => ({
      full_report: buildFullReport(session, { generatedAt: stableGeneratedAt }),
      quick_commentary: buildQuickCommentary(session, {
        generatedAt: stableGeneratedAt,
      }),
    }),
    [session, stableGeneratedAt],
  );
  const report = reports[reportType];
  const exportBlockReason = reportExportBlockReason(report);
  const canExport = exportBlockReason === null;

  const selectType = (next: ReportType): void => {
    if (exporting) return;
    setReportType(next);
    setError(null);
    setFailedFormat(null);
  };

  const runExport = async (format: ExportFormat): Promise<void> => {
    if (!canExport || exporting) return;
    setExporting(format);
    setError(null);
    setFailedFormat(null);
    try {
      const blob = await exporters[format](report);
      if (!(blob instanceof Blob) || blob.size === 0)
        throw new Error("empty_export");
      download(
        blob,
        `${safeFileStem(report.projectName)}-${report.title}.${format}`,
      );
    } catch {
      setError("导出失败。预览已保留，请重试当前格式。");
      setFailedFormat(format);
    } finally {
      setExporting(null);
    }
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next =
      reportType === "full_report" ? "quick_commentary" : "full_report";
    selectType(next);
    (next === "full_report" ? fullTabRef : quickTabRef).current?.focus();
  };

  return (
    <section className="report-page" aria-labelledby="report-page-title">
      <div className="page-heading">
        <div>
          <h1 id="report-page-title">报告导出</h1>
          <p>两类成果共享同一已验证 ReportModel，结构与篇幅分别生成。</p>
        </div>
      </div>
      <div className="report-toolbar">
        <div role="tablist" aria-label="成果类型">
          <button
            className={
              reportType === "full_report" ? "btn btn-primary" : "btn btn-secondary"
            }
            ref={fullTabRef}
            type="button"
            role="tab"
            aria-selected={reportType === "full_report"}
            tabIndex={reportType === "full_report" ? 0 : -1}
            onClick={() => selectType("full_report")}
            onKeyDown={moveTab}
          >
            外规解读报告
          </button>
          <button
            className={
              reportType === "quick_commentary"
                ? "btn btn-primary"
                : "btn btn-secondary"
            }
            ref={quickTabRef}
            type="button"
            role="tab"
            aria-selected={reportType === "quick_commentary"}
            tabIndex={reportType === "quick_commentary" ? 0 : -1}
            onClick={() => selectType("quick_commentary")}
            onKeyDown={moveTab}
          >
            新规快评
          </button>
        </div>
        <div className="report-download-actions">
          {(["docx", "pdf"] as const).map((format) => (
            <button
              className={
                failedFormat === format
                  ? "btn btn-danger"
                  : format === "pdf"
                    ? "btn btn-primary"
                    : "btn btn-secondary"
              }
              key={format}
              type="button"
              disabled={!canExport || exporting !== null}
              onClick={() => void runExport(format)}
            >
              {exporting === format
                ? `正在生成 ${format.toUpperCase()}…`
                : failedFormat === format
                  ? `重试导出 ${format.toUpperCase()}`
                  : `下载 ${format.toUpperCase()}`}
            </button>
          ))}
        </div>
      </div>
      {!report.authoritativeParsing ? (
        <p role="alert">权威解析或 OCR 质量未通过，导出已禁用。</p>
      ) : null}
      {report.authoritativeParsing && exportBlockReason ? (
        <p role="status">{exportBlockReason}</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <ReportPreview report={report} />
    </section>
  );
};
