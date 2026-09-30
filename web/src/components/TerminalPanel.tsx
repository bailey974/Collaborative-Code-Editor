import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCollab } from "../collab/CollabProvider";

type TerminalDataPayload = { id: string; data: string };
type TerminalExitPayload = { id: string };

type Task = { label: string; cmd: string };
type Props = { cwd?: string };

// Shared Yjs keys
const Y_TERM_LOG = "terminal:log"; // Y.Text
const Y_TERM_INPUT = "terminal:input"; // Y.Array<{id,userId,data,createdAt}>
const Y_TERM_POLICY = "terminal:policy"; // Y.Map (already managed by CollabProvider)
const Y_TERM_REQUESTS = "terminal:requests"; // Y.Array<{id,userId,name,createdAt}>

const MAX_SHARED_LOG_CHARS = 200_000;

function setTerminalOption(term: any, key: string, value: any) {
  // xterm.js legacy API had setOption(); newer @xterm/xterm uses terminal.options
  if (term && typeof term.setOption === "function") {
    term.setOption(key, value);
    return;
  }
  if (term && term.options) {
    term.options[key] = value;
  }
}

function makeId(prefix: string) {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${(crypto as any).randomUUID()}`
    : `${prefix}-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function isTauriRuntime() {
  return isTauri();
}

export default function TerminalPanel({ cwd }: Props) {
  const {
    doc,
    isHost,
    me,
    members,
    terminalPolicy,
    setTerminalPolicy,
    requestTerminalControl,
    terminalRequests,
  } = useCollab();

  const containerRef = useRef<HTMLDivElement | null>(null);

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Host-only PTY id (lives only in the host desktop app)
  const termIdRef = useRef<string | null>(null);

  // Buffer any output that arrives before we know which id is “ours”
  const pendingByIdRef = useRef<Record<string, string>>({});
  const exitedIdsRef = useRef<Record<string, true>>({});

  // Track which guest-input items have been processed (host only)
  const processedInputIdsRef = useRef<Record<string, true>>({});

  // Capture the initial cwd (don’t restart the PTY on every file click)
  const initialCwdRef = useRef<string | undefined>(cwd);

  // Shared state references
  const yLog = useMemo(() => doc.getText(Y_TERM_LOG), [doc]);
  const yInput = useMemo(() => doc.getArray<any>(Y_TERM_INPUT), [doc]);
  const yPolicy = useMemo(() => doc.getMap<any>(Y_TERM_POLICY), [doc]);
  const yRequests = useMemo(() => doc.getArray<any>(Y_TERM_REQUESTS), [doc]);

  const [ready, setReady] = useState(false);
  const [selectedTask, setSelectedTask] = useState<string>("");
  const [statusText, setStatusText] = useState<string>("starting…");

  const tasks: Task[] = useMemo(
    () => [
      // JS/TS
      { label: "pnpm install", cmd: "pnpm install" },
      { label: "pnpm dev", cmd: "pnpm dev" },
      { label: "pnpm test", cmd: "pnpm test" },
      { label: "pnpm lint", cmd: "pnpm lint" },
      { label: "npm install", cmd: "npm install" },
      { label: "npm test", cmd: "npm test" },

      // Rust/Tauri
      { label: "cargo test", cmd: "cargo test" },
      { label: "cargo fmt", cmd: "cargo fmt" },
      { label: "cargo clippy", cmd: "cargo clippy" },

      // Git
      { label: "git status", cmd: "git status" },
      { label: "git diff", cmd: "git diff" },
      { label: "git log --oneline -n 10", cmd: "git log --oneline -n 10" },
    ],
    []
  );

  // Keep latest policy + ids in refs so observers don’t need to re-register
  const policyRef = useRef(terminalPolicy);
  const meRef = useRef(me);
  useEffect(() => {
    policyRef.current = terminalPolicy;
    meRef.current = me;
  }, [terminalPolicy, me]);

  const shared = terminalPolicy.shared;
  const controller = terminalPolicy.controllerUserId; // null | "*" | userId
  const canGuestSend =
    terminalPolicy.allowGuestInput &&
    (controller === "*" || controller === me.userId);

  // Only the host *desktop* app can spawn a PTY.
  const hasLocalPty = isHost && isTauriRuntime();
  const allowLocalInput = hasLocalPty || canGuestSend;

  function appendSharedLog(data: string) {
    if (!policyRef.current.shared) return;
    if (!data) return;

    doc.transact(() => {
      const before = yLog.length;
      yLog.insert(before, data);

      // Keep bounded size
      const overflow = yLog.length - MAX_SHARED_LOG_CHARS;
      if (overflow > 0) yLog.delete(0, overflow);
    });
  }

  function writeRawToPty(data: string) {
    const id = termIdRef.current;
    if (!id) return;

    invoke("terminal_write", { id, data }).catch((e) => {
      termRef.current?.writeln(`\r\n[write error] ${String(e)}`);
    });
  }

  function sendLine(line: string) {
    if (hasLocalPty) {
      writeRawToPty(line + "\r\n");
      termRef.current?.focus();
      return;
    }

    // Guest with control: queue input for host
    if (canGuestSend) {
      const item = { id: makeId("in"), userId: me.userId, data: line + "\r\n", createdAt: Date.now() };
      doc.transact(() => yInput.push([item]));
      termRef.current?.focus();
    }
  }

  // Listen for "Run Code" custom events from CodeEditor
  useEffect(() => {
    const handleRunCmd = (e: Event) => {
      const customEvent = e as CustomEvent<{ command: string }>;
      if (customEvent.detail?.command) {
        const line = customEvent.detail.command;
        if (hasLocalPty) {
          writeRawToPty(line + "\r\n");
          termRef.current?.focus();
        } else if (canGuestSend) {
          const item = { id: makeId("in"), userId: me.userId, data: line + "\r\n", createdAt: Date.now() };
          doc.transact(() => yInput.push([item]));
          termRef.current?.focus();
        }
      }
    };
    window.addEventListener("terminal-run-command", handleRunCmd);
    return () => window.removeEventListener("terminal-run-command", handleRunCmd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLocalPty, canGuestSend, me.userId, doc, yInput]);

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;

      if (hasLocalPty) {
        writeRawToPty(text);
      } else if (canGuestSend) {
        const item = { id: makeId("in"), userId: me.userId, data: text, createdAt: Date.now() };
        doc.transact(() => yInput.push([item]));
      }
    } catch (e) {
      termRef.current?.writeln(`\r\n[paste error] ${String(e)}`);
    }
  }

  async function copySelection() {
    const term = termRef.current;
    if (!term) return;

    const selection = term.getSelection();
    if (!selection) return;

    try {
      await navigator.clipboard.writeText(selection);
      term.clearSelection();
    } catch (e) {
      term.writeln(`\r\n[copy error] ${String(e)}`);
    }
  }

  function clearLocal() {
    const term = termRef.current;
    if (!term) return;
    term.reset();

    if (hasLocalPty) {
      writeRawToPty("\r");
      term.focus();
    }
  }

  function clearShared() {
    if (!isHost) return;
    doc.transact(() => {
      yLog.delete(0, yLog.length);
    });
  }

  // Keep xterm stdin enabled/disabled as control changes (without recreating PTY)
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    setTerminalOption(t, "disableStdin", !allowLocalInput);
  }, [allowLocalInput]);

  // Create xterm for everyone; create PTY only for host desktop app.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create terminal
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
      scrollback: 8000,
      disableStdin: !allowLocalInput,
      allowTransparency: true,
      windowsMode: true,
      theme: {
        background: "#0b0f14",
        foreground: "#e5e7eb",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    // VS Code-like keybindings:
    // - Ctrl+Shift+C: Copy selection
    // - Ctrl+V / Ctrl+Shift+V: Paste
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      const isCtrl = ev.ctrlKey || ev.metaKey;
      const isShift = ev.shiftKey;

      if (isCtrl && isShift && ev.code === "KeyC") {
        void copySelection();
        return false;
      }

      if (isCtrl && (ev.code === "KeyV" || (isShift && ev.code === "KeyV"))) {
        void pasteFromClipboard();
        return false;
      }

      return true;
    });

    term.open(container);

    requestAnimationFrame(() => {
      fit.fit();
      term.focus();
    });

    termRef.current = term;
    fitRef.current = fit;

    // Focus management (Monaco often steals focus)
    const focusTerminal = () => term.focus();
    container.addEventListener("mousedown", focusTerminal);

    // Keep PTY size in sync with panel size (not only window resize)
    const ro = new ResizeObserver(() => {
      const id = termIdRef.current;
      if (!id) return;

      fit.fit();
      invoke("terminal_resize", { id, cols: term.cols, rows: term.rows }).catch(() => { });
    });
    ro.observe(container);

    // If we're not the host desktop app, stream shared log into xterm
    let logLastLen = 0;
    const renderLogDelta = () => {
      const txt = yLog.toString();
      if (txt.length > logLastLen) {
        term.write(txt.slice(logLastLen));
        logLastLen = txt.length;
      }
    };

    let unobserveLog: null | (() => void) = null;
    if (!hasLocalPty) {
      renderLogDelta();
      const obs = () => renderLogDelta();
      yLog.observe(obs);
      unobserveLog = () => yLog.unobserve(obs);

      if (!isTauriRuntime()) {
        term.writeln("\r\n[terminal disabled in web mode]");
        term.writeln("Open the desktop app (Tauri) as the host to run a real shell.");
        setStatusText("viewer (web)");
      } else {
        term.writeln("\r\n[terminal viewer]");
        term.writeln(shared ? "Waiting for host output…" : "Host has not enabled sharing.");
        setStatusText(shared ? "viewer" : "not shared");
      }

      setReady(false);
    }

    // Host: drain guest input queue into PTY (when allowed)
    let unobserveInput: null | (() => void) = null;
    const drainGuestInput = () => {
      if (!hasLocalPty) return;
      const p = policyRef.current;
      if (!p.allowGuestInput) return;

      const controllerUserId = p.controllerUserId;

      const toSend: string[] = [];
      const toDelete: number[] = [];

      for (let i = 0; i < yInput.length; i++) {
        const item = yInput.get(i);
        if (!item?.id || !item?.userId || typeof item?.data !== "string") continue;

        if (processedInputIdsRef.current[item.id]) {
          toDelete.push(i);
          continue;
        }

        const allowed =
          controllerUserId === "*" || controllerUserId === item.userId;

        if (!allowed) continue;

        processedInputIdsRef.current[item.id] = true;
        toSend.push(item.data);
        toDelete.push(i);
      }

      if (toDelete.length) {
        doc.transact(() => {
          for (let j = toDelete.length - 1; j >= 0; j--) {
            yInput.delete(toDelete[j], 1);
          }
        });
      }

      for (const chunk of toSend) writeRawToPty(chunk);
    };

    if (hasLocalPty) {
      const obs = () => drainGuestInput();
      yInput.observe(obs);
      unobserveInput = () => yInput.unobserve(obs);
    }

    let unlistenData: null | (() => void) = null;
    let unlistenExit: null | (() => void) = null;

    let disposeOnData: null | (() => void) = null;
    let removeContextMenu: null | (() => void) = null;

    const startHostPty = async () => {
      term.writeln("[starting shell…]");
      setStatusText("starting…");

      // 1) Start listening BEFORE creating the PTY (prevents missing the first prompt)
      unlistenData = await listen<TerminalDataPayload>("terminal:data", (event) => {
        const { id, data } = event.payload;

        // Intercept custom code command output
        if (data.includes("__TAURI_OPEN_FILE__|")) {
          const match = data.match(/__TAURI_OPEN_FILE__\|([^\r\n]+)/);
          if (match && match[1]) {
            const rawPath = match[1].trim();
            // Fire custom event for App.tsx to catch
            window.dispatchEvent(
              new CustomEvent("code-open-file", { detail: { path: rawPath } })
            );
          }
          // Don't print the marker
          return;
        }

        const activeId = termIdRef.current;

        if (activeId && id === activeId) {
          term.write(data);
          appendSharedLog(data);
          return;
        }

        // Buffer until we know the activeId
        pendingByIdRef.current[id] = (pendingByIdRef.current[id] ?? "") + data;
      });

      unlistenExit = await listen<TerminalExitPayload>("terminal:exit", (event) => {
        exitedIdsRef.current[event.payload.id] = true;

        const activeId = termIdRef.current;
        if (activeId && event.payload.id === activeId) {
          term.writeln("\r\n[process exited]");
          setReady(false);
          setStatusText("exited");
        }
      });

      // 2) Create PTY (retry without cwd if it fails)
      const cols = Math.max(10, term.cols || 80);
      const rows = Math.max(5, term.rows || 24);

      let id: string;
      try {
        id = await invoke<string>("terminal_create", {
          cols,
          rows,
          cwd: initialCwdRef.current ?? undefined,
        });
      } catch (e) {
        term.writeln(`\r\n[terminal_create failed with cwd] ${String(e)}`);
        term.writeln("[retrying without cwd…]");
        id = await invoke<string>("terminal_create", { cols, rows });
      }

      termIdRef.current = id;

      // Context menu: VS Code terminal behavior
      // - If there's a selection -> copy
      // - Else -> paste
      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        const t = termRef.current;
        if (t?.hasSelection()) {
          void copySelection();
        } else {
          void pasteFromClipboard();
        }
      };
      container.addEventListener("contextmenu", onContextMenu);
      removeContextMenu = () => container.removeEventListener("contextmenu", onContextMenu);

      // 3) Flush any buffered output (including the first prompt)
      const buffered = pendingByIdRef.current[id];
      if (buffered) {
        term.write(buffered);
        appendSharedLog(buffered);
        delete pendingByIdRef.current[id];
      }

      if (exitedIdsRef.current[id]) {
        term.writeln("\r\n[process exited]");
        setReady(false);
        setStatusText("exited");
        return;
      }

      // 4) Wire input AFTER id is set (host local keystrokes)
      const d = term.onData((data) => {
        invoke("terminal_write", { id, data }).catch(() => { });
      });
      disposeOnData = () => d.dispose();

      // 5) Force a prompt in case the first one was missed
      await invoke("terminal_write", { id, data: "\r" }).catch(() => { });

      // 6) Sync size once more
      fit.fit();
      await invoke("terminal_resize", { id, cols: term.cols, rows: term.rows }).catch(() => { });

      // Start draining any queued guest input
      drainGuestInput();

      term.writeln("\r\n[terminal ready]");
      setReady(true);
      setStatusText("ready");
      requestAnimationFrame(() => term.focus());
    };

    if (hasLocalPty) {
      startHostPty().catch((e) => {
        term.writeln(`\r\n[terminal init error] ${String(e)}`);
        term.writeln(
          "\r\nIf this is a CWD/path error, the terminal will still work without CWD.\r\n" +
          "If you’re running in a browser, run `pnpm tauri dev` instead."
        );
        setReady(false);
        setStatusText("error");
      });
    }

    return () => {
      container.removeEventListener("mousedown", focusTerminal);
      ro.disconnect();

      if (disposeOnData) disposeOnData();
      if (removeContextMenu) removeContextMenu();

      if (unobserveLog) unobserveLog();
      if (unobserveInput) unobserveInput();

      // These are functions returned by `listen`, they should be called directly
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();

      const id = termIdRef.current;
      termIdRef.current = null;
      if (id) invoke("terminal_kill", { id }).catch(() => { });

      term.dispose();
      setReady(false);
    };
    // NOTE: we intentionally do NOT depend on `cwd` so the PTY doesn't restart on file clicks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, hasLocalPty, shared]);

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
        }}
      >
        <div style={{ fontWeight: 600 }}>Terminal</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{statusText}</div>

        <select
          value={selectedTask}
          onChange={(e) => setSelectedTask(e.target.value)}
          style={{ marginLeft: 8, padding: "4px 6px" }}
        >
          <option value="">Run task…</option>
          {tasks.map((t) => (
            <option key={t.label} value={t.cmd}>
              {t.label}
            </option>
          ))}
        </select>

        <button
          disabled={!allowLocalInput || !selectedTask}
          onClick={() => sendLine(selectedTask)}
          style={{
            padding: "4px 10px",
            border: "1px solid #374151",
            background: allowLocalInput && selectedTask ? "#111827" : "#0b0f14",
            color: "#e5e7eb",
            cursor: allowLocalInput && selectedTask ? "pointer" : "not-allowed",
          }}
        >
          Run
        </button>

        <button
          disabled={!ready}
          onClick={clearLocal}
          style={{
            marginLeft: "auto",
            padding: "4px 10px",
            border: "1px solid #374151",
            background: ready ? "#111827" : "#0b0f14",
            color: "#e5e7eb",
            cursor: ready ? "pointer" : "not-allowed",
          }}
        >
          Clear
        </button>

        {isHost && shared && (
          <button
            onClick={clearShared}
            style={{
              padding: "4px 10px",
              border: "1px solid #374151",
              background: "#111827",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            Clear shared
          </button>
        )}
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0, background: "#0b0f14" }}>
        <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
      </div>
    </div>
  );
}
