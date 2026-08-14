import "@testing-library/jest-dom/vitest";

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { MaterialUpload } from "./MaterialUpload";

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
