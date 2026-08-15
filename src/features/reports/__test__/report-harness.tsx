import { createRoot } from "react-dom/client";

import "../../../styles/tokens.css";
import "../../../styles/global.css";
import { ReportPage } from "../ReportPage";
import { reviewedReportSession } from "./report-fixture";

createRoot(document.getElementById("root")!).render(
  <main className="app-content">
    <ReportPage
      generatedAt="2026-08-16T03:00:00.000Z"
      session={reviewedReportSession()}
    />
  </main>,
);
