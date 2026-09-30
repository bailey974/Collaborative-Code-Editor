/// <reference lib="webworker" />

/*
 * Runs a single JavaScript file in a dedicated worker with console output
 * forwarded to the page. No DOM, no imports/require; top-level await works.
 * The worker stays alive after the script returns so timers can still fire,
 * until the page stops it (next run, Stop, or timeout).
 */

type RunMessage = { id: string; code: string };

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

function emit(stream: "stdout" | "stderr", args: unknown[]) {
  post({ id: currentId, type: "output", stream, text: args.map(format).join(" ") + "\n" });
}

console.log = (...a: unknown[]) => emit("stdout", a);
console.info = (...a: unknown[]) => emit("stdout", a);
console.debug = (...a: unknown[]) => emit("stdout", a);
console.warn = (...a: unknown[]) => emit("stderr", a);
console.error = (...a: unknown[]) => emit("stderr", a);

self.addEventListener("unhandledrejection", (e) => emit("stderr", ["Uncaught (in promise)", e.reason]));
self.addEventListener("error", (e) => emit("stderr", [e.error ?? e.message]));

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  code: string
) => () => Promise<unknown>;

self.onmessage = async (e: MessageEvent<RunMessage>) => {
  currentId = e.data.id;
  try {
    await new AsyncFunction(e.data.code)();
    post({ id: currentId, type: "done", ok: true });
  } catch (err) {
    emit("stderr", [err]);
    post({ id: currentId, type: "done", ok: false });
  }
};
