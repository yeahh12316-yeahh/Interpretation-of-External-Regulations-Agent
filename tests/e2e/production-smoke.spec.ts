import { test } from "../../playwright-fixtures";

import {
  ocrConsoleExpectations,
  runProductionSmokeFlow,
} from "./support/production-smoke-flow";

const productionBaseUrl = new URL(process.env.PRODUCTION_BASE_URL!);

test.use({
  expectedConsoleErrors: {
    specs: ocrConsoleExpectations(productionBaseUrl.origin),
  },
});

test("deployed production App completes PDF/OCR BYOK analysis and all exports", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await runProductionSmokeFlow(page, productionBaseUrl);
});
