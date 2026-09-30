/*
 * Code runs in the browser of whoever presses Run (no server shell).
 * CodeEditor asks to run a file by dispatching RUN_EVENT; TerminalPanel runs
 * it and writes the output into the shared "terminal:log" Y.Text.
 */

export type Runtime = "python" | "javascript" | "html";

const RUNTIMES: Record<string, Runtime> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  html: "html",
  htm: "html",
};

export const RUN_EVENT = "collab:run-file";

export function runtimeFor(path: string): Runtime | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return RUNTIMES[ext] ?? null;
}

export function isRunnable(path: string) {
  return runtimeFor(path) !== null;
}

export function requestRun(path: string) {
  window.dispatchEvent(new CustomEvent(RUN_EVENT, { detail: { path } }));
}
