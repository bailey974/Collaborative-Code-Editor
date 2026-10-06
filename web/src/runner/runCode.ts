import { runtimeFor } from "./runEvents";
import { dirname, joinPath, normalizePath } from "../collab/yFiles";

export type OutputStream = "stdout" | "stderr" | "info";

export type RunHandle = {
  /** Resolves true on success, false on error/timeout/stop. */
  done: Promise<boolean>;
  stop: () => void;
  /** Sends a line typed in the terminal to the program (input()). */
  sendInput: (line: string) => void;
};

type Options = {
  path: string;
  files: Record<string, string>;
  onOutput: (text: string, stream: OutputStream) => void;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

// The Python worker is kept between runs so Pyodide only loads once.
let pythonWorker: Worker | null = null;
// The JS worker is replaced on every run (fresh globals).
let jsWorker: Worker | null = null;

function newPythonWorker() {
  return new Worker(new URL("./pythonWorker.ts", import.meta.url), { type: "module" });
}

function newJsWorker() {
  return new Worker(new URL("./jsWorker.ts", import.meta.url), { type: "module" });
}

function runInWorker(
  getWorker: () => Worker,
  discard: () => void,
  payload: Record<string, unknown>,
  onOutput: Options["onOutput"],
  timeoutMs: number
): RunHandle {
  const id = crypto.randomUUID();
  const worker = getWorker();
  let settle: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => (settle = resolve));
  let finished = false;

  const finish = (ok: boolean) => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
    settle(ok);
  };

  const onMessage = (e: MessageEvent) => {
    const m = e.data;
    if (!m || m.id !== id) return;
    if (m.type === "output") onOutput(String(m.text ?? ""), m.stream);
    if (m.type === "done") finish(!!m.ok);
  };
  const onError = (e: ErrorEvent) => {
    onOutput(`Runner crashed: ${e.message}\n`, "stderr");
    discard();
    finish(false);
  };

  const kill = (why: string) => {
    if (finished) return;
    onOutput(why, "stderr");
    discard();
    finish(false);
  };

  const timer = window.setTimeout(() => kill(`\nStopped after ${timeoutMs / 1000}s (time limit).\n`), timeoutMs);

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.postMessage({ type: "run", id, ...payload });

  return {
    done,
    stop: () => kill("^C\n"),
    sendInput: (line) => {
      if (!finished) worker.postMessage({ type: "stdin", id, line });
    },
  };
}

/**
 * Inlines local <script src> and <link rel="stylesheet"> references so a
 * multi-file page can be previewed from a single document.
 */
function inlineHtml(path: string, files: Record<string, string>) {
  const base = dirname(path);
  const resolve = (ref: string) => {
    if (/^(https?:)?\/\//i.test(ref) || ref.startsWith("data:")) return null;
    const p = ref.startsWith("/") ? normalizePath(ref) : joinPath(base, ref);
    return files[p] ?? null;
  };

  let html = files[path] ?? "";
  html = html.replace(
    /<script([^>]*?)\ssrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    (m, pre, src, post) => {
      const code = resolve(src);
      return code == null ? m : `<script${pre}${post}>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
    }
  );
  html = html.replace(/<link([^>]*?)\shref=["']([^"']+)["']([^>]*)>/gi, (m, pre, href, post) => {
    if (!/rel=["']?stylesheet/i.test(pre + post)) return m;
    const css = resolve(href);
    return css == null ? m : `<style>${css}</style>`;
  });
  return html;
}

/**
 * Opens an HTML preview in a new tab. The page runs in a sandboxed iframe
 * with an opaque origin, so it can't read this app's storage (auth token).
 */
function previewHtml(path: string, files: Record<string, string>, onOutput: Options["onOutput"]): RunHandle {
  const tab = window.open("", "_blank");
  if (!tab) {
    onOutput("Pop-up blocked: allow pop-ups for this site to open HTML previews.\n", "stderr");
    return { done: Promise.resolve(false), stop: () => {}, sendInput: () => {} };
  }
  tab.opener = null;
  const srcdoc = inlineHtml(path, files).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  tab.document.open();
  tab.document.write(
    `<!doctype html><title>Preview: ${path.replace(/</g, "&lt;")}</title>` +
      `<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>` +
      `<iframe sandbox="allow-scripts allow-forms allow-modals" srcdoc="${srcdoc}"></iframe>`
  );
  tab.document.close();
  onOutput(`Opened preview of ${path} in a new tab.\n`, "info");
  return { done: Promise.resolve(true), stop: () => {}, sendInput: () => {} };
}

export function runInBrowser({ path, files, onOutput, timeoutMs = DEFAULT_TIMEOUT_MS }: Options): RunHandle {
  const entry = normalizePath(path);
  const runtime = runtimeFor(entry);

  if (runtime === "python") {
    return runInWorker(
      () => (pythonWorker ??= newPythonWorker()),
      () => {
        pythonWorker?.terminate();
        pythonWorker = null;
      },
      { entry, files },
      onOutput,
      // First run also downloads Pyodide and any packages.
      pythonWorker ? timeoutMs : timeoutMs + 60_000
    );
  }

  if (runtime === "javascript") {
    jsWorker?.terminate();
    jsWorker = newJsWorker();
    return runInWorker(
      () => jsWorker!,
      () => {
        jsWorker?.terminate();
        jsWorker = null;
      },
      { code: files[entry] ?? "" },
      onOutput,
      timeoutMs
    );
  }

  if (runtime === "html") return previewHtml(entry, files, onOutput);

  onOutput(`Don't know how to run ${entry}. Supported: .py, .js, .mjs, .html\n`, "stderr");
  return { done: Promise.resolve(false), stop: () => {}, sendInput: () => {} };
}
