/// <reference lib="webworker" />
import type { PyodideAPI } from "pyodide";

/*
 * Runs Python with Pyodide (CPython compiled to WebAssembly). Pyodide is
 * loaded from the jsDelivr CDN on first use (~10 MB, cached by the browser)
 * and kept warm between runs. Keep PYODIDE_VERSION in sync with the
 * "pyodide" devDependency, which is only used for types.
 */

const PYODIDE_VERSION = "314.0.7";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PROJECT_ROOT = "/home/pyodide/project";

type RunMessage = { id: string; entry: string; files: Record<string, string> };

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

self.onmessage = async (e: MessageEvent<RunMessage>) => {
  const { id, entry, files } = e.data;
  const write = (stream: "stdout" | "stderr" | "info") => (text: string) =>
    post({ id, type: "output", stream, text: text + "\n" });

  try {
    const py = await getPyodide(id);

    py.setStdout({ batched: write("stdout") });
    py.setStderr({ batched: write("stderr") });
    // No interactive stdin: input() raises instead of hanging.
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
      messageCallback: write("info"),
      errorCallback: write("stderr"),
    });

    py.globals.set("__collab_root", PROJECT_ROOT);
    py.globals.set("__collab_entry", `${PROJECT_ROOT}/${entry}`);
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
runpy.run_path(__collab_entry, run_name="__main__")
`);
    post({ id, type: "done", ok: true });
  } catch (err: any) {
    const text = String(err?.message ?? err);
    // A clean sys.exit() isn't an error.
    const cleanExit = /SystemExit: (0|None)?\s*$/.test(text.trim());
    if (!cleanExit) post({ id, type: "output", stream: "stderr", text: text.endsWith("\n") ? text : text + "\n" });
    post({ id, type: "done", ok: cleanExit });
  }
};
