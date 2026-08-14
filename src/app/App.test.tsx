import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the product identity and five workflow steps", () => {
  render(<App />);

  expect(screen.getByRole("heading", { name: "外规解读agent" })).toBeVisible();
  for (const name of [
    "材料上传",
    "解析与OCR",
    "监管分析",
    "人工复核与修正",
    "报告导出",
  ]) {
    expect(
      screen.getByRole("button", { name: new RegExp(name) }),
    ).toBeVisible();
  }
  expect(screen.getByRole("button", { name: "模型接口设置" })).toBeEnabled();
  expect(screen.getByLabelText("选择监管文件")).toBeVisible();
});
