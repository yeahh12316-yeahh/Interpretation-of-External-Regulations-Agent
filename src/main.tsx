import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/tokens.css";
import "./styles/global.css";

createRoot(document.getElementById("root")!, {
  // React development diagnostics can include component inputs. The product
  // surfaces a redacted ErrorBoundary message and never logs workflow data.
  onCaughtError: () => undefined,
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
