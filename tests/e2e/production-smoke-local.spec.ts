import { test } from "../../playwright-fixtures";

import {
  ocrConsoleExpectations,
  runProductionSmokeFlow,
} from "./support/production-smoke-flow";

const localBaseUrl = new URL("http://127.0.0.1:4173/");

test.use({
  expectedConsoleErrors: {
    specs: ocrConsoleExpectations(localBaseUrl.origin),
  },
});

test("shared production smoke flow handles text PDF, scanned PDF, OCR, and exports", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await runProductionSmokeFlow(page, localBaseUrl);
});
