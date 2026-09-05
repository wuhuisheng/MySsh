import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Monaco is NOT imported here: it is pulled in on demand (dynamic import)
// by the preview/editor modals, keeping the startup bundle small.

// Surface any uncaught frontend error visibly (a blank dark window otherwise)
function showFatal(kind: string, detail: unknown) {
  const el = document.createElement("pre");
  el.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:#2a1418;color:#ffb3ba;padding:16px;white-space:pre-wrap;overflow:auto;font:12px Menlo,monospace";
  el.textContent = `${kind}\n${String(detail)}`;
  document.body.appendChild(el);
}
window.addEventListener("error", (e) =>
  showFatal("JS Error", e.error?.stack ?? e.message),
);
window.addEventListener("unhandledrejection", (e) =>
  showFatal("Unhandled Rejection", e.reason),
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
