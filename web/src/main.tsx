import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Show *something* immediately
document.body.style.margin = "0";
document.body.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const el = document.getElementById("root");

if (!el) {
  document.body.innerHTML =
    `<pre style="padding:16px;white-space:pre-wrap">` +
    `❌ Root element #root not found.\n` +
    `Fix: ensure your loaded HTML contains: <div id="root"></div>\n` +
    `Search: Get-ChildItem . -Recurse -Filter *.html | Select-String -Pattern 'id="root"'\n` +
    `</pre>`;
  throw new Error("Root element #root not found");
}

try {
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
} catch (e: any) {
  el.innerHTML =
    `<pre style="padding:16px;white-space:pre-wrap">` +
    `❌ Fatal render error before React mounted:\n\n` +
    `${String(e?.stack ?? e)}` +
    `</pre>`;
  throw e;
}
