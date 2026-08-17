import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the product identity and five workflow steps", async () => {
  render(<App />);

  expect(screen.getByRole("heading", { name: "外规解读agent" })).toBeVisible();
  for (const name of [
    "材料上传",
    "解析与OCR",
    "监管分析",
    "人工复核",
    "报告导出",
  ]) {
    expect(
      screen.getByRole("button", { name: new RegExp(name) }),
    ).toBeVisible();
  }
  expect(await screen.findByLabelText("选择监管文件")).toBeVisible();
  expect(screen.getByRole("button", { name: "模型接口设置" })).toBeEnabled();
});
