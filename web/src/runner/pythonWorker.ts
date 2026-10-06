/// <reference lib="webworker" />
import type { PyodideAPI } from "pyodide";

/*
 * Runs Python with Pyodide (CPython compiled to WebAssembly). Pyodide is
 * loaded from the jsDelivr CDN on first use (~10 MB, cached by the browser)
 * and kept warm between runs. Keep PYODIDE_VERSION in sync with the
 * "pyodide" devDependency, which is only used for types.
 *
 * input() waits for a line typed in the terminal. That needs JavaScript
 * Promise Integration (run_sync), which Chrome and Edge support; elsewhere
 * input() raises a clear error instead of hanging.
 */

const PYODIDE_VERSION = "314.0.7";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PROJECT_ROOT = "/home/pyodide/project";

type RunMessage = { type: "run"; id: string; entry: string; files: Record<string, string> };
type StdinMessage = { type: "stdin"; id: string; line: string };

let pyodidePromise: Promise<PyodideAPI> | null = null;

function post(msg: Record<string, unknown>) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

function getPyodide(id: string) {
  if (!pyodidePromise) {
    post({ id, type: "output", stream: "info", text: "Loading Python runtime (first run only)…\n" });
    pyodidePromise = import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`).then(
      (mod: { loadPyodide: (opts: { indexURL: string }) => Promise<PyodideAPI> }) =>
        mod.loadPyodide({ indexURL: INDEX_URL })
    );
    pyodidePromise.catch(() => {
      pyodidePromise = null;
    });
  }
  return pyodidePromise;
}

function mkdirs(py: PyodideAPI, dir: string) {
  let acc = "";
  for (const part of dir.split("/").filter(Boolean)) {
    acc += "/" + part;
    try {
      py.FS.mkdir(acc);
    } catch {
      // exists
    }
  }
}

/* ---------- stdin: lines typed in the terminal ---------- */

let runId = "";
let lines: string[] = [];
let waiting: ((line: string) => void) | null = null;

function readLine(): Promise<string> {
  const next = lines.shift();
  if (next !== undefined) return Promise.resolve(next);
  return new Promise((resolve) => (waiting = resolve));
}

function onStdin(m: StdinMessage) {
  if (m.id !== runId) return;
  if (waiting) {
    const w = waiting;
    waiting = null;
    w(m.line);
  } else {
    lines.push(m.line);
  }
}

// Replaces builtins.input; prompts go to stdout without a newline, like a terminal.
const PRELUDE = `
import builtins, sys
from pyodide.ffi import run_sync, can_run_sync
def __collab_input(prompt=""):
    sys.stdout.write(str(prompt))
    sys.stdout.flush()
    if not can_run_sync():
        raise RuntimeError("input() needs a browser that supports JavaScript Promise Integration (Chrome or Edge).")
    return run_sync(__collab_read_line())
builtins.input = __collab_input
`;

async function run({ id, entry, files }: RunMessage) {
  runId = id;
  lines = [];
  waiting = null;

  // Output is passed through exactly as written (stdout is a tty, so it is
  // line-buffered and input() prompts are flushed before waiting).
  const writer = (stream: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    return {
      isatty: true,
      write: (buf: Uint8Array) => {
        const text = decoder.decode(buf, { stream: true });
        if (text) post({ id, type: "output", stream, text });
        return buf.length;
      },
    };
  };
  const info = (text: string) => post({ id, type: "output", stream: "info", text: text + "\n" });

  try {
    const py = await getPyodide(id);

    py.setStdout(writer("stdout"));
    py.setStderr(writer("stderr"));
    // sys.stdin isn't connected; input() reads from the terminal instead.
    py.setStdin({ error: true });

    // Fresh copy of the project each run.
    py.runPython(`import shutil; shutil.rmtree(${JSON.stringify(PROJECT_ROOT)}, ignore_errors=True)`);
    mkdirs(py, PROJECT_ROOT);
    for (const [path, content] of Object.entries(files)) {
      const full = `${PROJECT_ROOT}/${path}`;
      mkdirs(py, full.slice(0, full.lastIndexOf("/")));
      py.FS.writeFile(full, content);
    }

    // Install any packages Pyodide ships (numpy, pandas, …) that the entry imports.
    await py.loadPackagesFromImports(files[entry] ?? "", {
      messageCallback: info,
      errorCallback: (text: string) => post({ id, type: "output", stream: "stderr", text: text + "\n" }),
    });

    py.globals.set("__collab_root", PROJECT_ROOT);
    py.globals.set("__collab_entry", `${PROJECT_ROOT}/${entry}`);
    py.globals.set("__collab_read_line", readLine);
    py.runPython(PRELUDE);
    await py.runPythonAsync(`
import os, sys, runpy
os.chdir(__collab_root)
if __collab_root not in sys.path:
    sys.path.insert(0, __collab_root)
# Drop modules imported from the project on a previous run so edits apply.
for _name, _mod in list(sys.modules.items()):
    if (getattr(_mod, "__file__", None) or "").startswith(__collab_root):
        del sys.modules[_name]
_entry_dir = os.path.dirname(__collab_entry)
if _entry_dir not in sys.path:
    sys.path.insert(0, _entry_dir)
os.chdir(_entry_dir)
try:
    runpy.run_path(__collab_entry, run_name="__main__")
finally:
    sys.stdout.flush()
    sys.stderr.flush()
`);
    post({ id, type: "done", ok: true });
  } catch (err: any) {
    const text = String(err?.message ?? err);
    // A clean sys.exit() isn't an error.
    const cleanExit = /SystemExit: (0|None)?\s*$/.test(text.trim());
    if (!cleanExit) post({ id, type: "output", stream: "stderr", text: text.endsWith("\n") ? text : text + "\n" });
    post({ id, type: "done", ok: cleanExit });
  }
}

self.onmessage = (e: MessageEvent<RunMessage | StdinMessage>) => {
  if (e.data.type === "stdin") onStdin(e.data);
  else void run(e.data);
};
