/// <reference lib="webworker" />

/*
 * Runs a single JavaScript file in a dedicated worker with console output
 * forwarded to the page. No DOM, no imports/require; top-level await works.
 * `await input("prompt")` reads a line typed in the terminal.
 * The worker stays alive after the script returns so timers can still fire,
 * until the page stops it (next run, Stop, or timeout).
 */

type RunMessage = { type: "run"; id: string; code: string };
type StdinMessage = { type: "stdin"; id: string; line: string };

function post(msg: Record<string, unknown>) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

function format(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === "function") return `[Function ${arg.name || "anonymous"}]`;
  if (typeof arg === "undefined") return "undefined";
  try {
    return JSON.stringify(arg, null, 2) ?? String(arg);
  } catch {
    return String(arg);
  }
}

let currentId = "";

function write(stream: "stdout" | "stderr", text: string) {
  post({ id: currentId, type: "output", stream, text });
}

function emit(stream: "stdout" | "stderr", args: unknown[]) {
  write(stream, args.map(format).join(" ") + "\n");
}

console.log = (...a: unknown[]) => emit("stdout", a);
console.info = (...a: unknown[]) => emit("stdout", a);
console.debug = (...a: unknown[]) => emit("stdout", a);
console.warn = (...a: unknown[]) => emit("stderr", a);
console.error = (...a: unknown[]) => emit("stderr", a);

self.addEventListener("unhandledrejection", (e) => emit("stderr", ["Uncaught (in promise)", e.reason]));
self.addEventListener("error", (e) => emit("stderr", [e.error ?? e.message]));

/* ---------- stdin: lines typed in the terminal ---------- */

const lines: string[] = [];
let waiting: ((line: string) => void) | null = null;

function input(prompt: unknown = ""): Promise<string> {
  const p = String(prompt);
  if (p) write("stdout", p);
  const next = lines.shift();
  if (next !== undefined) return Promise.resolve(next);
  return new Promise((resolve) => (waiting = resolve));
}

(self as unknown as { input: typeof input }).input = input;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  code: string
) => () => Promise<unknown>;

self.onmessage = async (e: MessageEvent<RunMessage | StdinMessage>) => {
  const m = e.data;
  if (m.type === "stdin") {
    if (m.id !== currentId) return;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(m.line);
    } else {
      lines.push(m.line);
    }
    return;
  }

  currentId = m.id;
  try {
    await new AsyncFunction(m.code)();
    post({ id: currentId, type: "done", ok: true });
  } catch (err) {
    emit("stderr", [err]);
    post({ id: currentId, type: "done", ok: false });
  }
};
