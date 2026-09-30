import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as Y from "yjs";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useCollab } from "../collab/CollabProvider";
import { getFilesMap, normalizePath } from "../collab/yFiles";
import { RUN_EVENT, isRunnable } from "../runner/runEvents";
import { runInBrowser, type OutputStream, type RunHandle } from "../runner/runCode";

/*
 * Shared output console. Code runs in the browser of whoever presses Run
 * (see src/runner); their output is appended to a shared Y.Text so everyone
 * in the room sees the same console.
 */

type Props = { activePath?: string };

const Y_TERM_LOG = "terminal:log"; // Y.Text
const MAX_SHARED_LOG_CHARS = 200_000;
const FLUSH_MS = 80;

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const toolbarBtn = (enabled: boolean): CSSProperties => ({
  padding: "4px 10px",
  border: "1px solid #374151",
  borderRadius: 4,
  background: enabled ? "#111827" : "#0b0f14",
  color: enabled ? "#e5e7eb" : "#6b7280",
  cursor: enabled ? "pointer" : "not-allowed",
  fontSize: 12,
});

export default function TerminalPanel({ activePath }: Props) {
  const {
    doc,
    isHost,
    me,
    status,
    terminalPolicy,
    setTerminalPolicy,
    requestTerminalControl,
    terminalRequests,
    canEditDoc,
    canViewDoc,
  } = useCollab();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const runRef = useRef<RunHandle | null>(null);

  const yLog = useMemo(() => doc.getText(Y_TERM_LOG), [doc]);

  const [running, setRunning] = useState<string | null>(null);

  // Editors may run code unless the host turns it off; viewers never can
  // (the server rejects their writes to the shared log).
  const mayRun = (path: string) =>
    status === "connected" && (isHost || (terminalPolicy.allowGuestInput && canEditDoc(path)));

  const mayRunRef = useRef(mayRun);
  mayRunRef.current = mayRun;

  // Batched appends to the shared log (one Yjs update per flush, not per line).
  const pendingRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);

  function flushLog() {
    flushTimerRef.current = null;
    const chunk = pendingRef.current;
    pendingRef.current = "";
    if (!chunk) return;
    doc.transact(() => {
      yLog.insert(yLog.length, chunk);
      const overflow = yLog.length - MAX_SHARED_LOG_CHARS;
      if (overflow > 0) yLog.delete(0, overflow);
    });
  }

  function appendLog(text: string) {
    pendingRef.current += text;
    if (flushTimerRef.current == null) flushTimerRef.current = window.setTimeout(flushLog, FLUSH_MS);
  }

  function collectFiles() {
    const out: Record<string, string> = {};
    getFilesMap(doc).forEach((text, path) => {
      if (canViewDoc(path)) out[path] = text.toString();
    });
    return out;
  }

  async function run(path: string) {
    const p = normalizePath(path);
    if (!p || !isRunnable(p) || !mayRunRef.current(p) || runRef.current) return;

    const files = collectFiles();
    if (!(p in files)) return;

    const started = performance.now();
    setRunning(p);
    appendLog(`${ANSI.cyan}▶ ${me.name} ran ${p}${ANSI.reset}\n`);

    const colour = (stream: OutputStream) =>
      stream === "stderr" ? ANSI.red : stream === "info" ? ANSI.dim : "";

    const handle = runInBrowser({
      path: p,
      files,
      onOutput: (text, stream) => {
        const c = colour(stream);
        appendLog(c ? `${c}${text}${ANSI.reset}` : text);
      },
    });
    runRef.current = handle;

    const ok = await handle.done;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    appendLog(
      ok
        ? `${ANSI.green}✔ finished in ${secs}s${ANSI.reset}\n\n`
        : `${ANSI.yellow}✖ ended with an error after ${secs}s${ANSI.reset}\n\n`
    );
    runRef.current = null;
    setRunning(null);
  }

  // Run requests from the editor (Run button / Ctrl+Enter).
  useEffect(() => {
    const onRun = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (path) void run(path);
    };
    window.addEventListener(RUN_EVENT, onRun);
    return () => window.removeEventListener(RUN_EVENT, onRun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Stop any in-flight run when leaving the room.
  useEffect(() => {
    return () => {
      runRef.current?.stop();
      if (flushTimerRef.current != null) window.clearTimeout(flushTimerRef.current);
    };
  }, [doc]);

  // xterm mirrors the shared log.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      fontSize: 13,
      scrollback: 8000,
      cursorBlink: false,
      theme: { background: "#0b0f14", foreground: "#e5e7eb" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    requestAnimationFrame(() => fit.fit());

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    let renderedLen = 0;
    let showingHint = false;
    const renderAll = () => {
      term.reset();
      const txt = yLog.toString();
      if (txt) term.write(txt);
      else term.writeln(`${ANSI.dim}Output from Run appears here for everyone in the room.${ANSI.reset}`);
      renderedLen = txt.length;
      showingHint = !txt;
    };
    renderAll();

    // Plain appends are streamed; anything else (clear, trimming) re-renders.
    const onLogChange = (ev: Y.YTextEvent) => {
      const d = ev.delta;
      const retain = d[0]?.retain ?? 0;
      const ins = d.find((x) => x.insert !== undefined);
      const isAppend =
        !showingHint &&
        !!ins &&
        d.every((x) => x.delete === undefined) &&
        d.length === (retain ? 2 : 1) &&
        retain === renderedLen;
      if (isAppend) {
        term.write(String(ins!.insert));
        renderedLen = yLog.length;
      } else {
        renderAll();
      }
    };
    yLog.observe(onLogChange);

    // Copy with Ctrl+Shift+C
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && (ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      return true;
    });

    return () => {
      yLog.unobserve(onLogChange);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [yLog]);

  function clearShared() {
    if (!isHost) return;
    doc.transact(() => yLog.delete(0, yLog.length));
  }

  function allowRequests() {
    setTerminalPolicy({ allowGuestInput: true });
    const arr = doc.getArray("terminal:requests");
    doc.transact(() => arr.delete(0, arr.length));
  }

  const activeRunnable = !!activePath && isRunnable(activePath);
  const canRunActive = activeRunnable && mayRun(activePath!);
  const blockedByPolicy =
    !isHost && activeRunnable && !terminalPolicy.allowGuestInput && canEditDoc(activePath!);
  const alreadyRequested = terminalRequests.some((r) => r.userId === me.userId);

  const statusText = running
    ? `running ${running}…`
    : !activePath
      ? "open a .py, .js or .html file to run it"
      : !activeRunnable
        ? "this file type can't be run in the browser"
        : canRunActive
          ? "ready"
          : blockedByPolicy
            ? "the host has turned off running code for guests"
            : "you need edit access to run this file";

  return (
    <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "6px 8px",
          borderBottom: "1px solid #1f2937",
          background: "#0b0f14",
          color: "#e5e7eb",
          flex: "0 0 auto",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: 600 }}>Output</div>
        <div style={{ fontSize: 12, opacity: 0.75, flex: "1 1 160px", minWidth: 0 }}>{statusText}</div>

        {running ? (
          <button onClick={() => runRef.current?.stop()} style={toolbarBtn(true)}>
            ■ Stop
          </button>
        ) : (
          <button
            disabled={!canRunActive}
            onClick={() => activePath && void run(activePath)}
            style={toolbarBtn(canRunActive)}
            title="Run the open file (Ctrl+Enter in the editor)"
          >
            ▶ Run
          </button>
        )}

        {blockedByPolicy && (
          <button
            disabled={alreadyRequested}
            onClick={requestTerminalControl}
            style={toolbarBtn(!alreadyRequested)}
          >
            {alreadyRequested ? "Requested" : "Ask to run"}
          </button>
        )}

        {isHost && terminalRequests.length > 0 && !terminalPolicy.allowGuestInput && (
          <button onClick={allowRequests} style={toolbarBtn(true)}>
            Allow guests to run ({terminalRequests.length} asked)
          </button>
        )}

        {isHost && (
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={terminalPolicy.allowGuestInput}
              onChange={(e) => setTerminalPolicy({ allowGuestInput: e.target.checked })}
            />
            Editors can run code
          </label>
        )}

        {isHost && (
          <button onClick={clearShared} style={toolbarBtn(true)}>
            Clear
          </button>
        )}
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0, background: "#0b0f14", padding: "4px 0 0 6px" }}>
        <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
      </div>
    </div>
  );
}
