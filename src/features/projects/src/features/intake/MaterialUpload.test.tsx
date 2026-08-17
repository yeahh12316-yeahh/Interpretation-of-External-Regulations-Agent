import "@testing-library/jest-dom/vitest";

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { MaterialUpload } from "./MaterialUpload";
import type { ParseResult } from "../parsing/parse-document";

const textFile = (name: string, content: string): File => {
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], name, { type: "text/plain" });
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bytes.buffer,
    });
  }
  return file;
};

test("marks the regulatory file required and official interpretation optional", () => {
  render(<MaterialUpload />);

  expect(screen.getByLabelText("选择监管文件")).toBeRequired();
  expect(screen.getByLabelText("选择官方解读")).not.toBeRequired();
  expect(screen.getByText("必填")).toBeVisible();
  expect(screen.getByText("选填")).toBeVisible();
});

test("accepts file selection, drag-and-drop, and clipboard paste without mixing sources", async () => {
  render(<MaterialUpload />);
  const user = userEvent.setup();
  const regulatoryInput = screen.getByLabelText("选择监管文件");
  const regulation = textFile(
    "regulation.txt",
    "第一条 商业银行应当审慎经营。",
  );

  await user.upload(regulatoryInput, regulation);
  const regulatoryRegion = screen.getByRole("region", { name: "监管文件上传" });
  await waitFor(() =>
    expect(within(regulatoryRegion).getByText("regulation.txt")).toBeVisible(),
  );
  expect(await within(regulatoryRegion).findByText(/SHA-256/)).toBeVisible();
  expect(
    within(regulatoryRegion).getByText("来源").nextElementSibling,
  ).toHaveTextContent("监管文件");

  const interpretationRegion = screen.getByRole("region", {
    name: "官方解读上传",
  });
  fireEvent.drop(within(interpretationRegion).getByTestId("drop-zone"), {
    dataTransfer: {
      files: [textFile("interpretation.txt", "本解读仅用于合成测试。")],
    },
  });
  await waitFor(() =>
    expect(
      within(interpretationRegion).getByText("interpretation.txt"),
    ).toBeVisible(),
  );
  expect(
    within(interpretationRegion).getByText("来源").nextElementSibling,
  ).toHaveTextContent("官方解读");

  fireEvent.paste(regulatoryRegion, {
    clipboardData: {
      files: [textFile("pasted.txt", "第二条 商业银行应当建立风险制度。")],
    },
  });
  await waitFor(() =>
    expect(within(regulatoryRegion).getByText("pasted.txt")).toBeVisible(),
  );
  expect(
    within(interpretationRegion).getByText("interpretation.txt"),
  ).toBeVisible();
});

test("uses a responsive two-zone grid that stays within a 1024px container", () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  render(<MaterialUpload />);

  const grid = screen.getByTestId("material-upload-grid");
  expect(grid).toHaveStyle({
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
    width: "100%",
  });
  for (const region of screen.getAllByRole("region")) {
    expect(region).toHaveStyle({ minWidth: "0", maxWidth: "100%" });
  }
});

test("exposes cancellation and reports it without leaking file content", async () => {
  render(<MaterialUpload />);
  const user = userEvent.setup();
  const file = textFile("slow.txt", "敏感正文不得出现在错误里");
  Object.defineProperty(file, "arrayBuffer", {
    value: () => new Promise<ArrayBuffer>(() => undefined),
  });

  await user.upload(screen.getByLabelText("选择监管文件"), file);
  await user.click(
    await screen.findByRole("button", { name: "取消解析 slow.txt" }),
  );

  expect(await screen.findByRole("status")).toHaveTextContent("已取消");
  expect(screen.queryByText(/敏感正文/)).not.toBeInTheDocument();
});

test("shows a blocked state and affected OCR pages instead of complete", async () => {
  const blocked: ParseResult = {
    fileHash: "abc",
    source: {
      sourceId: "SRC-regulatory_text-abc",
      sourceType: "regulatory_text",
      title: "blocked.pdf",
      content: "",
    },
    pageCount: 3,
    successfulPages: [1],
    failedPages: [
      { page: 2, error: "页面 OCR 识别失败" },
      { page: 3, error: "页面文本提取失败" },
    ],
    units: [],
    ocrReviews: [],
    anchors: [],
    quality: {
      totalCharacters: 0,
      parsedUnitCount: 0,
      failedPageCount: 2,
      lowTextPages: [2],
      extractionCoverage: 1 / 3,
      ocrFailedPages: [2],
      finalizationBlocked: true,
    },
  };
  const parseFile = vi.fn().mockResolvedValue(blocked);
  render(<MaterialUpload parseFile={parseFile} />);

  await userEvent
    .setup()
    .upload(
      screen.getByLabelText("选择监管文件"),
      new File(["%PDF-1.7"], "blocked.pdf", { type: "application/pdf" }),
    );

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("解析质量未通过，禁止进入定稿");
  expect(alert).toHaveTextContent("OCR 失败页：2");
  expect(alert).toHaveTextContent("全部失败页：2、3");
  expect(screen.getByTestId("regulatory_text-upload-state")).toHaveAttribute(
    "data-finalization-ready",
    "false",
  );
  expect(screen.queryByText("解析完成")).not.toBeInTheDocument();
});

test("aborts in-flight parsing when the component unmounts", async () => {
  let observedSignal: AbortSignal | undefined;
  const parseFile = vi.fn(
    (_file: File, _sourceType: unknown, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<ParseResult>(() => undefined);
    },
  );
  const view = render(<MaterialUpload parseFile={parseFile} />);
  await userEvent
    .setup()
    .upload(
      screen.getByLabelText("选择监管文件"),
      textFile("pending.txt", "合成测试"),
    );

  await waitFor(() => expect(observedSignal).toBeDefined());
  expect(observedSignal?.aborted).toBe(false);
  view.unmount();
  expect(observedSignal?.aborted).toBe(true);
});

const minimalResult = (): ParseResult => {
  const source = {
    sourceId: "SRC-regulatory_text-synth",
    sourceType: "regulatory_text" as const,
    title: "synthetic.txt",
    content: "合成内容",
  };
  return {
    fileHash: "b".repeat(64),
    source,
    pageCount: null,
    successfulPages: [],
    failedPages: [],
    units: [],
    ocrReviews: [],
    anchors: [],
    quality: {
      totalCharacters: 4,
      parsedUnitCount: 0,
      failedPageCount: 0,
      lowTextPages: [],
      extractionCoverage: 1,
      ocrFailedPages: [],
      finalizationBlocked: false,
    },
  };
};

test("passes the uploaded File alongside the parse result to onParsed", async () => {
  const parseFile = vi.fn().mockResolvedValue(minimalResult());
  const onParsed = vi.fn();
  render(<MaterialUpload parseFile={parseFile} onParsed={onParsed} />);

  const file = textFile("synthetic.txt", "合成内容");
  await userEvent
    .setup()
    .upload(screen.getByLabelText("选择监管文件"), file);

  await waitFor(() => expect(onParsed).toHaveBeenCalled());
  const [result, forwardedFile] = onParsed.mock.calls[0];
  expect(result.fileHash).toBe("b".repeat(64));
  expect(forwardedFile).toBe(file);
});

test("renders the retention switch only when it can be toggled", async () => {
  const readOnly = render(<MaterialUpload />);
  expect(
    readOnly.queryByTestId("raw-file-retention-control"),
  ).not.toBeInTheDocument();
  readOnly.unmount();

  const parseFile = vi.fn().mockResolvedValue(minimalResult());
  const onRetentionChange = vi.fn();
  const user = userEvent.setup();
  render(
    <MaterialUpload
      parseFile={parseFile}
      retentionEnabled={false}
      onRetentionChange={onRetentionChange}
    />,
  );

  const checkbox = screen.getByLabelText("保留原始文件副本");
  expect(checkbox).not.toBeChecked();
  await user.click(checkbox);
  expect(onRetentionChange).toHaveBeenLastCalledWith(true);
});
