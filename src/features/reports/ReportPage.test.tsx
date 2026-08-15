import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { browserDownload, ReportPage } from "./ReportPage";
import {
  draftReportSession,
  reviewedReportSession,
} from "./__test__/report-fixture";

it("switches real report structures and downloads all four type/format combinations", async () => {
  const user = userEvent.setup();
  const exportDocx = vi.fn(async () => new Blob(["docx"]));
  const exportPdf = vi.fn(async () => new Blob(["pdf"]));
  const download = vi.fn();
  render(
    <ReportPage
      session={reviewedReportSession()}
      exporters={{ docx: exportDocx, pdf: exportPdf }}
      download={download}
      generatedAt="2026-08-16T03:00:00.000Z"
    />,
  );

  expect(screen.getByRole("heading", { name: "外规解读报告" })).toBeVisible();
  expect(
    screen.getByRole("heading", {
      name: /原文证据索引与人工修订留痕/u,
    }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "下载 DOCX" }));
  await user.click(screen.getByRole("button", { name: "下载 PDF" }));
  await user.click(screen.getByRole("tab", { name: "新规快评" }));
  expect(screen.getByRole("heading", { name: "新规快评" })).toBeVisible();
  expect(screen.getByRole("heading", { name: /一句话结论/u })).toBeVisible();
  expect(
    screen.queryByRole("heading", {
      name: /原文证据索引与人工修订留痕/u,
    }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "下载 DOCX" }));
  await user.click(screen.getByRole("button", { name: "下载 PDF" }));

  expect(exportDocx).toHaveBeenCalledTimes(2);
  expect(exportPdf).toHaveBeenCalledTimes(2);
  expect(download).toHaveBeenCalledTimes(4);
  expect(download.mock.calls.map(([, name]) => name)).toEqual([
    expect.stringContaining("外规解读报告.docx"),
    expect.stringContaining("外规解读报告.pdf"),
    expect.stringContaining("新规快评.docx"),
    expect.stringContaining("新规快评.pdf"),
  ]);
});

it("keeps the preview on export error, exposes retry, and retains keyboard focus", async () => {
  const user = userEvent.setup();
  const exportDocx = vi
    .fn<() => Promise<Blob>>()
    .mockRejectedValueOnce(new Error("session-only-secret provider detail"))
    .mockResolvedValueOnce(new Blob(["ok"]));
  render(
    <ReportPage
      session={draftReportSession()}
      exporters={{ docx: exportDocx, pdf: vi.fn(async () => new Blob()) }}
      download={vi.fn()}
    />,
  );

  expect(screen.getAllByText("AI草稿，未经人工复核").length).toBeGreaterThan(0);
  const button = screen.getByRole("button", { name: "下载 DOCX" });
  button.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("导出失败");
  expect(document.body.textContent).not.toContain("session-only-secret");
  expect(screen.getByRole("heading", { name: "外规解读报告" })).toBeVisible();
  const retry = screen.getByRole("button", { name: "重试导出 DOCX" });
  retry.focus();
  await user.keyboard("{Enter}");
  expect(exportDocx).toHaveBeenCalledTimes(2);
});

it("disables export when authoritative parsing is unavailable", () => {
  const session = reviewedReportSession();
  session.parseResults = [];
  render(<ReportPage session={session} />);
  expect(screen.getByRole("button", { name: "下载 DOCX" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "下载 PDF" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("权威解析");
});

it("keeps insufficient quick content visible but fails quick export closed", async () => {
  const user = userEvent.setup();
  const session = reviewedReportSession();
  session.project.findings = session.project.findings.filter(
    ({ category }) =>
      !category.startsWith("key_matter:") && category !== "atomic_requirement",
  );
  render(<ReportPage session={session} />);
  expect(screen.getByRole("button", { name: "下载 DOCX" })).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "新规快评" }));
  expect(screen.getByText(/至少需要 3 项已验证变化/)).toBeVisible();
  expect(screen.getByRole("button", { name: "下载 DOCX" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "下载 PDF" })).toBeDisabled();
});

it("moves DOM focus with roving tabs and prevents browser arrow defaults", () => {
  render(<ReportPage session={reviewedReportSession()} />);
  const full = screen.getByRole("tab", { name: "外规解读报告" });
  const quick = screen.getByRole("tab", { name: "新规快评" });
  full.focus();
  const prevented = !fireEvent.keyDown(full, { key: "ArrowRight" });
  expect(prevented).toBe(true);
  expect(quick).toHaveFocus();
  expect(quick).toHaveAttribute("tabindex", "0");
  expect(full).toHaveAttribute("tabindex", "-1");
  expect(!fireEvent.keyDown(quick, { key: "ArrowLeft" })).toBe(true);
  expect(full).toHaveFocus();
});

it("keeps the Blob URL alive through download startup and revokes it after a safe delay", () => {
  vi.useFakeTimers();
  const create = vi.fn(() => "blob:report");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: create,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revoke,
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  browserDownload(new Blob(["report"]), "report.docx");
  expect(create).toHaveBeenCalled();
  expect(click).toHaveBeenCalled();
  expect(revoke).not.toHaveBeenCalled();
  vi.advanceTimersByTime(59_999);
  expect(revoke).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(revoke).toHaveBeenCalledWith("blob:report");
  vi.useRealTimers();
});
