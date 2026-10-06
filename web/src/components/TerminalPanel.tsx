import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as Y from "yjs";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useCollab } from "../collab/CollabProvider";
import { getDirsMap, getFilesMap } from "../collab/yFiles";
import { RUN_EVENT, isRunnable } from "../runner/runEvents";
import { runInBrowser, type OutputStream, type RunHandle } from "../runner/runCode";
import { HELP_TEXT, commandFor, listDir, parseCommand } from "../runner/shell";

/*
 * Shared terminal. Commands run in the browser of whoever types them (see
 * src/runner). A program's command line, output and anything typed into it
 * are appended to a shared Y.Text so everyone in the room sees the same
 * session; ls, cat, help and clear only affect your own screen.
 *
 * The line being typed is drawn locally after the shared log. When the log
 * grows, that line is erased, the new output written, and the line redrawn.
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
};

// Lets backspace move up across soft-wrapped lines, so a long typed line can be erased.
const REVERSE_WRAPAROUND = "\x1b[?45h";

const toolbarBtn = (enabled: boolean): CSSProperties => ({
  padding: "4px 10px",
  border: "1px solid #374151",
  borderRadius: 4,
  background: enabled ? "#111827" : "#0b0f14",
  color: enabled ? "#e5e7eb" : "#6b7280",
  cursor: enabled ? "pointer" : "not-allowed",
  fontSize: 12,
});

/** What's being typed, kept across renders. */
type LineState = {
  input: string;
  history: string[];
  historyIndex: number;
  /** True while this browser runs a program: typed lines go to its input(). */
  running: boolean;
};

type Screen = {
  /** Erases and redraws the line being typed. */
  redraw: () => void;
  /** Writes output that only this user sees, above the line being typed. */
  print: (text: string) => void;
  /** Clears this user's screen (the shared log is untouched). */
  clear: () => void;
  focus: () => void;
};

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
  const runRef = useRef<RunHandle | null>(null);
  const screenRef = useRef<Screen | null>(null);
  const lineRef = useRef<LineState>({ input: "", history: [], historyIndex: 0, running: false });

  const yLog = useMemo(() => doc.getText(Y_TERM_LOG), [doc]);

  const [running, setRunning] = useState<string | null>(null);

  // Editors may run code unless the host turns it off; viewers never can
  // (the server rejects their writes to the shared log).
  const mayRun = (path: string) =>
    status === "connected" && (isHost || (terminalPolicy.allowGuestInput && canEditDoc(path)));

  const name = me.name.replace(/[\x00-\x1f\x7f]/g, "");
  const prompt = { text: `${ANSI.green}${name}${ANSI.reset}$ `, width: name.length + 2 };

  // Batched appends to the shared log (one Yjs update per flush, not per line).
  const pendingRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);

  function flushLog() {
    if (flushTimerRef.current != null) window.clearTimeout(flushTimerRef.current);
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

  async function runProgram(path: string, commandLine: string) {
    const line = lineRef.current;
    const screen = screenRef.current;
    const files = collectFiles();
    if (!(path in files)) {
      screen?.print(`${ANSI.red}${commandLine.split(" ")[0]}: ${path}: No such file${ANSI.reset}\n`);
      return;
    }

    // From here the typed line belongs to the program, and the command line
    // is shared so everyone sees who ran what.
    line.running = true;
    screen?.redraw();
    appendLog(`${prompt.text}${commandLine}\n`);
    flushLog();
    setRunning(path);

    const colour = (stream: OutputStream) => (stream === "stderr" ? ANSI.red : stream === "info" ? ANSI.dim : "");
    const handle = runInBrowser({
      path,
      files,
      onOutput: (text, stream) => {
        const c = colour(stream);
        appendLog(c ? `${c}${text}${ANSI.reset}` : text);
      },
    });
    runRef.current = handle;
    await handle.done;

    // Start the next prompt on a fresh line, like a shell.
    // (Coloured output ends with a reset code after its newline.)
    const tail = (pendingRef.current || yLog.toString().slice(-16)).replace(/(\x1b\[[0-9;]*m)+$/, "");
    if (tail && !tail.endsWith("\n")) appendLog("\n");
    flushLog();

    runRef.current = null;
    line.running = false;
    line.input = "";
    setRunning(null);
    screen?.redraw();
  }

  function execute(commandLine: string) {
    const screen = screenRef.current;
    if (!screen) return;
    const echo = `${prompt.text}${commandLine}\n`;
    const cmd = parseCommand(commandLine);

    switch (cmd.kind) {
      case "none":
        screen.print(echo);
        return;
      case "error":
        screen.print(`${echo}${cmd.message}\n`);
        return;
      case "help":
        screen.print(`${echo}${HELP_TEXT}\n`);
        return;
      case "clear":
        screen.clear();
        return;
      case "ls": {
        const files = [...getFilesMap(doc).keys()].filter((p) => canViewDoc(p));
        const dirs = [...getDirsMap(doc).keys()].filter((p) => canViewDoc(p));
        const names = listDir(files, dirs, cmd.path);
        screen.print(
          echo +
            (names === null
              ? `ls: ${cmd.path}: No such file or directory\n`
              : names.length
                ? names.join("  ") + "\n"
                : "")
        );
        return;
      }
      case "cat": {
        const text = canViewDoc(cmd.path) ? getFilesMap(doc).get(cmd.path)?.toString() : undefined;
        if (text === undefined) {
          screen.print(`${echo}cat: ${cmd.path}: No such file\n`);
        } else {
          screen.print(echo + text + (text && !text.endsWith("\n") ? "\n" : ""));
        }
        return;
      }
      case "run": {
        if (!mayRun(cmd.path)) {
          const why =
            status !== "connected"
              ? "not connected to the room"
              : !isHost && !terminalPolicy.allowGuestInput
                ? "the host has turned off running code for guests"
                : "you need edit access to run this file";
          screen.print(`${echo}${ANSI.red}permission denied: ${why}${ANSI.reset}\n`);
          return;
        }
        void runProgram(cmd.path, commandLine);
      }
    }
  }

  function onEnter() {
    const line = lineRef.current;
    const text = line.input;
    line.input = "";

    if (line.running) {
      // Typed input for the program: share the echo, then hand it over.
      screenRef.current?.redraw();
      appendLog(text + "\n");
      flushLog();
      runRef.current?.sendInput(text);
      return;
    }

    if (text.trim() && line.history[line.history.length - 1] !== text) line.history.push(text);
    line.historyIndex = line.history.length;
    execute(text.trim());
  }

  function onCtrlC() {
    const line = lineRef.current;
    if (line.running) {
      line.input = "";
      runRef.current?.stop();
      return;
    }
    const typed = line.input;
    line.input = "";
    screenRef.current?.print(`${prompt.text}${typed}^C\n`);
  }

  function onHistory(step: number) {
    const line = lineRef.current;
    if (line.running || !line.history.length) return;
    line.historyIndex = Math.max(0, Math.min(line.history.length, line.historyIndex + step));
    line.input = line.history[line.historyIndex] ?? "";
    screenRef.current?.redraw();
  }

  /** Runs a file as if its command had been typed (Run button / Ctrl+Enter). */
  function runFile(path: string) {
    const line = lineRef.current;
    if (line.running || !isRunnable(path)) return;
    line.input = "";
    execute(commandFor(path));
    screenRef.current?.focus();
  }

  // Handlers registered once (xterm, window events) call the latest versions,
  // so they see current permissions and files, not those from the first render.
  const actionsRef = useRef({ onEnter, onCtrlC, onHistory, runFile, prompt });
  actionsRef.current = { onEnter, onCtrlC, onHistory, runFile, prompt };

  // Run requests from the editor (Run button / Ctrl+Enter).
  useEffect(() => {
    const onRun = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (path) actionsRef.current.runFile(path);
    };
    window.addEventListener(RUN_EVENT, onRun);
    return () => window.removeEventListener(RUN_EVENT, onRun);
  }, [doc]);

  // Stop any in-flight run when leaving the room.
  useEffect(() => {
    return () => {
      runRef.current?.stop();
      if (flushTimerRef.current != null) window.clearTimeout(flushTimerRef.current);
    };
  }, [doc]);

  // xterm shows the shared log, then the line being typed.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      scrollback: 8000,
      cursorBlink: true,
      theme: { background: "#0b0f14", foreground: "#e5e7eb" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    requestAnimationFrame(() => fit.fit());

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    // Where this user's screen starts in the log (moved by `clear`).
    let viewStart: Y.RelativePosition | null = null;
    let renderedLen = 0;
    let showingHint = false;
    // Columns taken by the typed line currently on screen.
    let drawnWidth = 0;

    const line = lineRef.current;
    const erase = () => {
      const seq = drawnWidth ? "\b".repeat(drawnWidth) + "\x1b[J" : "";
      drawnWidth = 0;
      return seq;
    };
    const draw = () => {
      const { prompt } = actionsRef.current;
      const chars = Array.from(line.input).length;
      if (line.running) {
        drawnWidth = chars;
        return line.input;
      }
      drawnWidth = prompt.width + chars;
      return prompt.text + line.input;
    };

    const renderAll = () => {
      term.reset();
      term.write(REVERSE_WRAPAROUND);
      const start = viewStart ? (Y.createAbsolutePositionFromRelativePosition(viewStart, doc)?.index ?? 0) : 0;
      const txt = yLog.toString().slice(start);
      if (txt) term.write(txt);
      else term.writeln(`${ANSI.dim}Shared terminal. Type help for commands.${ANSI.reset}`);
      renderedLen = yLog.length;
      showingHint = !txt;
      drawnWidth = 0;
      term.write(draw());
    };
    renderAll();

    screenRef.current = {
      redraw: () => term.write(erase() + draw()),
      print: (text) => term.write(erase() + text + draw()),
      clear: () => {
        viewStart = Y.createRelativePositionFromTypeIndex(yLog, yLog.length);
        renderAll();
      },
      focus: () => term.focus(),
    };

    // Plain appends are streamed; anything else (host clear, trimming) re-renders.
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
        term.write(erase() + String(ins!.insert) + draw());
        renderedLen = yLog.length;
      } else {
        renderAll();
      }
    };
    yLog.observe(onLogChange);

    const onData = term.onData((data) => {
      const actions = actionsRef.current;
      if (data === "\x1b[A") return actions.onHistory(-1);
      if (data === "\x1b[B") return actions.onHistory(1);
      if (data.startsWith("\x1b")) return; // other keys (arrows, F-keys) aren't supported

      let typed = "";
      const flushTyped = () => {
        if (!typed) return;
        line.input += typed;
        typed = "";
        screenRef.current?.redraw();
      };
      for (const ch of data) {
        if (ch >= " " && ch !== "\x7f") {
          typed += ch;
          continue;
        }
        flushTyped();
        if (ch === "\r") actions.onEnter();
        else if (ch === "\x7f" || ch === "\b") {
          line.input = Array.from(line.input).slice(0, -1).join("");
          screenRef.current?.redraw();
        } else if (ch === "\x03") actions.onCtrlC();
        else if (ch === "\x0c") screenRef.current?.clear();
        else if (ch === "\t") typed += "    ";
      }
      flushTyped();
    });

    // Copy with Ctrl+Shift+C (Ctrl+C stops the program).
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
      onData.dispose();
      ro.disconnect();
      screenRef.current = null;
      term.dispose();
    };
  }, [yLog, doc]);

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
    ? `running ${running} (Ctrl+C to stop)`
    : !activePath || !activeRunnable || canRunActive
      ? "type help for commands"
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
        <div style={{ fontWeight: 600 }}>Terminal</div>
        <div style={{ fontSize: 12, opacity: 0.75, flex: "1 1 160px", minWidth: 0 }}>{statusText}</div>

        {running ? (
          <button onClick={() => actionsRef.current.onCtrlC()} style={toolbarBtn(true)}>
            ■ Stop
          </button>
        ) : (
          <button
            disabled={!canRunActive}
            onClick={() => activePath && runFile(activePath)}
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
          <button onClick={clearShared} style={toolbarBtn(true)} title="Clear the terminal for everyone">
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
