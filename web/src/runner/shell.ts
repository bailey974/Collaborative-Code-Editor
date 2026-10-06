import { runtimeFor, type Runtime } from "./runEvents";
import { basename, normalizePath } from "../collab/yFiles";

/*
 * The terminal's tiny shell: parses a typed line into a command. Programs
 * run in the browser (see runCode.ts); nothing here touches a real shell.
 */

export type Command =
  | { kind: "none" }
  | { kind: "run"; path: string }
  | { kind: "ls"; path: string }
  | { kind: "cat"; path: string }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const HELP_TEXT = [
  "Commands:",
  "  python <file>   run a .py file (also python3, py)",
  "  node <file>     run a .js or .mjs file",
  "  run <file>      run any supported file; .html opens a preview",
  "  ls [folder]     list files",
  "  cat <file>      print a file",
  "  clear           clear your screen (Ctrl+L)",
  "Ctrl+C stops the running program. Up/Down recall earlier commands.",
  "Programs can read what you type: input() in Python, await input() in JavaScript.",
].join("\n");

const INTERPRETERS: Record<string, { runtime: Runtime; ext: string }> = {
  python: { runtime: "python", ext: ".py" },
  python3: { runtime: "python", ext: ".py" },
  py: { runtime: "python", ext: ".py" },
  node: { runtime: "javascript", ext: ".js" },
};

/** Splits a command line on whitespace, keeping "quoted" or 'quoted' parts together. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function parseCommand(line: string): Command {
  const [cmd, arg] = splitArgs(line);
  if (!cmd) return { kind: "none" };

  const needArg = (): Command | null => (arg ? null : { kind: "error", message: `usage: ${cmd} <file>` });

  const interp = INTERPRETERS[cmd];
  if (interp) {
    const missing = needArg();
    if (missing) return missing;
    const path = normalizePath(arg);
    if (runtimeFor(path) !== interp.runtime) {
      return { kind: "error", message: `${cmd}: ${path} is not a ${interp.ext} file` };
    }
    return { kind: "run", path };
  }

  switch (cmd) {
    case "run": {
      const missing = needArg();
      if (missing) return missing;
      const path = normalizePath(arg);
      if (!runtimeFor(path)) {
        return { kind: "error", message: `run: can't run ${path} (supported: .py, .js, .mjs, .html)` };
      }
      return { kind: "run", path };
    }
    case "ls":
      return { kind: "ls", path: normalizePath(arg) };
    case "cat":
      return needArg() ?? { kind: "cat", path: normalizePath(arg) };
    case "clear":
      return { kind: "clear" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "error", message: `${cmd}: command not found (type help for commands)` };
  }
}

/** The command the Run button types for a file. */
export function commandFor(path: string): string {
  const p = normalizePath(path);
  const runtime = runtimeFor(p);
  const cmd = runtime === "python" ? "python" : runtime === "javascript" ? "node" : "run";
  return `${cmd} ${/\s/.test(p) ? `"${p}"` : p}`;
}

/**
 * Names directly inside `dir` (folders end in "/"), sorted case-insensitively.
 * A file path lists just that file; a missing path gives null.
 */
export function listDir(files: string[], dirs: string[], dir: string): string[] | null {
  const d = normalizePath(dir);
  if (d && files.includes(d)) return [basename(d)];

  const prefix = d ? d + "/" : "";
  const names = new Set<string>();
  let exists = !d || dirs.includes(d);

  for (const p of [...files, ...dirs.map((x) => x + "/")]) {
    if (!p.startsWith(prefix)) continue;
    exists = true;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    names.add(slash === -1 ? rest : rest.slice(0, slash + 1));
  }

  if (!exists) return null;
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
