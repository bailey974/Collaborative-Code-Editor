import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Editor from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { MonacoBinding } from "y-monaco";

import { useCollab } from "../collab/CollabProvider";
import { getOrCreateYText, normalizePath } from "../collab/yFiles";

type Props = {
  filePath?: string | null;

  // content coming from your backend (/fs/read)
  // used to seed shared Y.Text when it's empty, so you do NOT rely on Tauri local FS permissions.
  initialContent?: string;
};

function inferLanguage(filePath?: string | null): string {
  if (!filePath) return "plaintext";
  const lower = filePath.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "html":
      return "html";
    case "css":
      return "css";
    case "md":
      return "markdown";
    case "py":
      return "python";
    case "java":
      return "java";
    case "c":
      return "c";
    case "cpp":
      return "cpp";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

function toMonacoUri(monacoApi: typeof monaco, filePath: string) {
  const norm = filePath.replace(/\\/g, "/");

  // Windows: C:/...
  if (/^[a-zA-Z]:\//.test(norm)) {
    return monacoApi.Uri.parse(`file:///${encodeURI(norm)}`);
  }

  // Posix: /...
  if (norm.startsWith("/")) {
    return monacoApi.Uri.parse(`file://${encodeURI(norm)}`);
  }

  return monacoApi.Uri.parse(`file:///${encodeURI(norm)}`);
}

function accessMessage(reason: string) {
  switch (reason) {
    case "tree_not_shared":
      return "Host has not shared the file tree.";
    case "outside_shared_roots":
      return "This file is outside the shared roots.";
    case "hidden":
      return "This file is hidden by the host.";
    case "excluded":
      return "This file is excluded by the host (cannot be opened).";
    default:
      return "Access denied.";
  }
}

function basename(p: string) {
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/");
  return parts[parts.length - 1] || "file";
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // best-effort fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

type MenuKey = "File" | "Edit" | "Selection" | "View" | "Go" | "Help";

function MenuBar(props: {
  disabled: boolean;
  openMenu: MenuKey | null;
  setOpenMenu: (m: MenuKey | null) => void;
  run: (actionId: string) => void;
  onDownload: () => void;
  onCopyPath: () => void;
  onToggleWordWrap: () => void;
  onToggleMinimap: () => void;
  onToggleLineNumbers: () => void;
  wordWrapOn: boolean;
  minimapOn: boolean;
  lineNumbersOn: boolean;
}) {
  const {
    disabled,
    openMenu,
    setOpenMenu,
    run,
    onDownload,
    onCopyPath,
    onToggleWordWrap,
    onToggleMinimap,
    onToggleLineNumbers,
    wordWrapOn,
    minimapOn,
    lineNumbersOn,
  } = props;

  const menuBtn = (k: MenuKey) => {
    const active = openMenu === k;
    return (
      <button
        type="button"
        onClick={() => setOpenMenu(active ? null : k)}
        disabled={disabled && k !== "Help"}
        style={{
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid transparent",
          background: active ? "rgba(0,0,0,0.06)" : "transparent",
          cursor: disabled && k !== "Help" ? "not-allowed" : "pointer",
          fontSize: 13,
          opacity: disabled && k !== "Help" ? 0.5 : 1,
          userSelect: "none",
        }}
      >
        {k}
      </button>
    );
  };

  const item = (
    label: string,
    onClick: () => void,
    opts?: { disabled?: boolean; hint?: string; checked?: boolean }
  ) => {
    const isDisabled = !!opts?.disabled;
    return (
      <button
        type="button"
        onClick={() => {
          if (!isDisabled) onClick();
          setOpenMenu(null);
        }}
        disabled={isDisabled}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "8px 10px",
          border: "none",
          background: "transparent",
          cursor: isDisabled ? "not-allowed" : "pointer",
          fontSize: 13,
          opacity: isDisabled ? 0.5 : 1,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ width: 16, display: "inline-flex", justifyContent: "center" }}>
          {opts?.checked ? "✓" : ""}
        </span>
        <span style={{ flex: 1 }}>{label}</span>
        {opts?.hint && <span style={{ opacity: 0.6, fontSize: 12 }}>{opts.hint}</span>}
      </button>
    );
  };

  const menu = (k: MenuKey, children: ReactNode) => {
    if (openMenu !== k) return null;
    return (
      <div
        role="menu"
        style={{
          position: "absolute",
          top: 34,
          left: 0,
          minWidth: 240,
          background: "#fff",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 12,
          boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
          padding: 6,
          zIndex: 50,
        }}
      >
        {children}
      </div>
    );
  };

  const menuWrap = (k: MenuKey, children: ReactNode) => (
    <div style={{ position: "relative" }}>
      {menuBtn(k)}
      {menu(k, children)}
    </div>
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      {menuWrap(
        "File",
        <>
          {item("Download (Ctrl+S)", onDownload, { disabled })}
          {item("Copy file path", onCopyPath, { disabled })}
          <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "6px 6px" }} />
          {item("Command Palette (Ctrl+Shift+P)", () => run("editor.action.quickCommand"), {
            disabled,
          })}
        </>
      )}

      {menuWrap(
        "Edit",
        <>
          {item("Undo", () => run("undo"), { disabled, hint: "Ctrl+Z" })}
          {item("Redo", () => run("redo"), { disabled, hint: "Ctrl+Y" })}
          <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "6px 6px" }} />
          {item("Cut", () => run("editor.action.clipboardCutAction"), { disabled, hint: "Ctrl+X" })}
          {item("Copy", () => run("editor.action.clipboardCopyAction"), { disabled: false, hint: "Ctrl+C" })}
          {item("Paste", () => run("editor.action.clipboardPasteAction"), { disabled, hint: "Ctrl+V" })}
          <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "6px 6px" }} />
          {item("Find", () => run("actions.find"), { disabled: false, hint: "Ctrl+F" })}
          {item("Replace", () => run("editor.action.startFindReplaceAction"), { disabled: false, hint: "Ctrl+H" })}
          <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "6px 6px" }} />
          {item("Format Document", () => run("editor.action.formatDocument"), { disabled })}
          {item("Toggle Line Comment", () => run("editor.action.commentLine"), { disabled })}
          {item("Toggle Block Comment", () => run("editor.action.blockComment"), { disabled })}
        </>
      )}

      {menuWrap(
        "Selection",
        <>
          {item("Select All", () => run("editor.action.selectAll"), { disabled: false, hint: "Ctrl+A" })}
          <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "6px 6px" }} />
          {item("Expand Selection", () => run("editor.action.smartSelect.expand"), { disabled })}
          {item("Shrink Selection", () => run("editor.action.smartSelect.shrink"), { disabled })}
          <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "6px 6px" }} />
          {item("Add Cursor Above", () => run("editor.action.insertCursorAbove"), { disabled })}
          {item("Add Cursor Below", () => run("editor.action.insertCursorBelow"), { disabled })}
          {item("Add Next Occurrence", () => run("editor.action.addSelectionToNextFindMatch"), { disabled })}
          {item("Add Previous Occurrence", () => run("editor.action.addSelectionToPreviousFindMatch"), { disabled })}
        </>
      )}

      {menuWrap(
        "View",
        <>
          {item("Toggle Word Wrap", onToggleWordWrap, { disabled: false, checked: wordWrapOn })}
          {item("Toggle Minimap", onToggleMinimap, { disabled: false, checked: minimapOn })}
          {item("Toggle Line Numbers", onToggleLineNumbers, { disabled: false, checked: lineNumbersOn })}
        </>
      )}

      {menuWrap(
        "Go",
        <>
          {item("Go to Line…", () => run("editor.action.gotoLine"), { disabled: false, hint: "Ctrl+G" })}
          {item("Go to Definition", () => run("editor.action.revealDefinition"), { disabled })}
          {item("Peek Definition", () => run("editor.action.peekDefinition"), { disabled })}
          {item("Find References", () => run("editor.action.referenceSearch.trigger"), { disabled })}
          {item("Rename Symbol", () => run("editor.action.rename"), { disabled })}
        </>
      )}

      {menuWrap(
        "Help",
        <>
          {item("Shortcuts: Ctrl+S (download), Ctrl+Shift+P, Ctrl+F, Ctrl+G", () => { }, { disabled: false })}
          {item("Tip: Editing is CRDT-synced; presence is ephemeral.", () => { }, { disabled: false })}
        </>
      )}
    </div>
  );
}

export default function CodeEditor({ filePath, initialContent }: Props) {
  const {
    doc,
    awareness,
    canViewDoc,
    canEditDoc,
    effectiveDocLevel,
    getPathAccess,
    requestEdit,
    role,
    isHost,
  } = useCollab();

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Guard against out-of-order async work
  const loadSeq = useRef(0);

  // Monaco refs
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);

  const bindingRef = useRef<MonacoBinding | null>(null);

  useEffect(() => {
    return () => {
      const ed = editorRef.current as any;
      try {
        ed?.__cursorDisp?.dispose?.();
      } catch {
        // ignore
      }
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  // UI state
  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null);
  const [wordWrapOn, setWordWrapOn] = useState(true);
  const [minimapOn, setMinimapOn] = useState(false);
  const [lineNumbersOn, setLineNumbersOn] = useState(true);

  const language = useMemo(() => inferLanguage(filePath), [filePath]);

  const canView = useMemo(() => (filePath ? canViewDoc(filePath) : true), [filePath, canViewDoc]);
  const canEdit = useMemo(() => (filePath ? canEditDoc(filePath) : false), [filePath, canEditDoc]);
  const level = useMemo(() => (filePath ? effectiveDocLevel(filePath) : "none"), [filePath, effectiveDocLevel]);

  const accessReason = useMemo(() => {
    if (!filePath) return null;
    const acc = getPathAccess(filePath, { asGuest: !isHost });
    return acc.ok ? null : acc.reason;
  }, [filePath, getPathAccess, isHost]);

  // Close menus on outside click / Escape
  useEffect(() => {
    if (!openMenu) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // if click is inside any menu button/dropdown, don't close
      if (t.closest?.("[data-menubar-root='1']")) return;
      setOpenMenu(null);
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [openMenu]);

  const run = (actionId: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const action = ed.getAction(actionId);
    if (!action) return;
    void action.run();
  };

  const getCurrentValue = () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    return model?.getValue() ?? "";
  };

  const onDownload = () => {
    if (!filePath) return;
    const content = getCurrentValue();
    downloadTextFile(basename(filePath), content);
  };

  const onCopyPath = () => {
    if (!filePath) return;
    void copyToClipboard(filePath);
  };

  const onRunCode = () => {
    if (!filePath) return;
    const lower = filePath.toLowerCase();
    const ext = lower.split(".").pop() ?? "";

    let cmd = "";
    switch (ext) {
      case "py":
        cmd = `python "${filePath}"`;
        break;
      case "js":
        cmd = `node "${filePath}"`;
        break;
      case "ts":
      case "tsx":
        cmd = `npx tsx "${filePath}"`;
        break;
      case "java":
        cmd = `java "${filePath}"`;
        break;
      case "c":
      case "cpp":
        // Windows fallback style basic compilation
        cmd = `gcc "${filePath}" -o out && ./out`;
        break;
      case "go":
        cmd = `go run "${filePath}"`;
        break;
      case "rs":
        cmd = `cargo run`;
        break;
      default:
        alert(`No default run command configured for .${ext} files.`);
        return;
    }

    // Dispatch an event to send to TerminalPanel
    window.dispatchEvent(
      new CustomEvent("terminal-run-command", { detail: { command: cmd } })
    );
  };

  const applyViewOptions = () => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.updateOptions({
      wordWrap: wordWrapOn ? "on" : "off",
      minimap: { enabled: minimapOn },
      lineNumbers: lineNumbersOn ? "on" : "off",
    });
  };

  useEffect(() => {
    applyViewOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordWrapOn, minimapOn, lineNumbersOn]);

  // Ensure the editor is ALWAYS showing the correct model for the clicked file
  useEffect(() => {
    const editor = editorRef.current;
    const monacoApi = monacoRef.current;
    if (!editor || !monacoApi) return;

    // cleanup binding whenever model changes
    bindingRef.current?.destroy();
    bindingRef.current = null;

    if (!filePath || !canView) {
      editor.setModel(null as any);
      return;
    }

    const uri = toMonacoUri(monacoApi, filePath);

    let model = monacoApi.editor.getModel(uri);
    if (!model) {
      model = monacoApi.editor.createModel("", language, uri);
    } else {
      const currentLang = model.getLanguageId();
      if (currentLang !== language) {
        monacoApi.editor.setModelLanguage(model, language);
      }
    }

    if (editor.getModel() !== model) {
      editor.setModel(model);
    }

    editor.updateOptions({ readOnly: !canEdit });
  }, [filePath, language, canView, canEdit]);

  // Seed the shared Y.Text from initialContent (ONLY if it’s empty)
  useEffect(() => {
    const seq = ++loadSeq.current;

    async function seedFromInitialContent() {
      if (!filePath) {
        setErr(null);
        setLoading(false);
        return;
      }

      if (!canView) {
        setErr(accessReason ? accessMessage(accessReason) : "No permission to view this file.");
        setLoading(false);
        return;
      }

      const yText = getOrCreateYText(doc, filePath);

      // If room already has content, do NOT overwrite it.
      if (yText.length > 0) {
        setErr(null);
        setLoading(false);
        return;
      }

      const seed = (initialContent ?? "").toString();
      if (!seed) {
        setErr(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErr(null);

      try {
        if (loadSeq.current !== seq) return;

        if (yText.length === 0) {
          doc.transact(() => {
            yText.insert(0, seed);
          });
        }
      } catch (e: any) {
        if (loadSeq.current === seq) {
          setErr(e?.message ?? String(e));
        }
      } finally {
        if (loadSeq.current === seq) setLoading(false);
      }
    }

    void seedFromInitialContent();
  }, [doc, filePath, initialContent, canView, accessReason]);

  // Bind Monaco model <-> Y.Text and re-bind when Monaco swaps models
  useEffect(() => {
    const editor = editorRef.current;

    // cleanup any prior binding
    bindingRef.current?.destroy();
    bindingRef.current = null;

    if (!editor || !filePath || !canView) return;

    const bind = () => {
      bindingRef.current?.destroy();
      bindingRef.current = null;

      const model = editor.getModel();
      if (!model) return;

      // presence: show what file I'm on
      (awareness as any).setLocalStateField("activeFile", normalizePath(filePath));

      const yText = getOrCreateYText(doc, filePath);

      // MonacoBinding still applies remote updates even if editor is readOnly.
      editor.updateOptions({ readOnly: !canEdit });

      bindingRef.current = new MonacoBinding(yText, model, new Set([editor]), awareness);
    };

    // bind now
    bind();

    // bind again whenever Monaco swaps model internally
    const disp = editor.onDidChangeModel(() => bind());

    return () => {
      disp.dispose();
      bindingRef.current?.destroy();
      bindingRef.current = null;
    };
  }, [doc, awareness, filePath, canView, canEdit]);

  const headerRight = (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {filePath && canEdit && (
        <button
          onClick={onRunCode}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "none",
            background: "#10b981",
            color: "#fff",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
          title="Run active file in terminal"
        >
          <span style={{ fontSize: 10 }}>▶</span> Run
        </button>
      )}

      {filePath && (
        <span
          style={{
            fontSize: 12,
            padding: "3px 8px",
            borderRadius: 999,
            border: "1px solid rgba(0,0,0,0.15)",
            background: "rgba(0,0,0,0.03)",
            opacity: 0.9,
          }}
          title={`Role: ${role} • Permission: ${level}`}
        >
          {canEdit ? "Editable" : level === "view" ? "Read-only" : "No access"}
        </span>
      )}

      {filePath && canView && !canEdit && role !== "host" && (
        <button
          onClick={() => requestEdit(filePath)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            background: "#fff",
            cursor: "pointer",
            fontSize: 12,
          }}
          title="Ask the host to grant edit permission for this file"
        >
          Request edit
        </button>
      )}
    </div>
  );

  const menuDisabled = !filePath || !canView;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Menubar */}
      <div
        data-menubar-root="1"
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <MenuBar
          disabled={menuDisabled}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          run={run}
          onDownload={onDownload}
          onCopyPath={onCopyPath}
          onToggleWordWrap={() => setWordWrapOn((v) => !v)}
          onToggleMinimap={() => setMinimapOn((v) => !v)}
          onToggleLineNumbers={() => setLineNumbersOn((v) => !v)}
          wordWrapOn={wordWrapOn}
          minimapOn={minimapOn}
          lineNumbersOn={lineNumbersOn}
        />

        <div style={{ flex: "1 1 auto" }} />

        {cursorPos && (
          <div style={{ fontSize: 12, opacity: 0.65, userSelect: "none" }}>
            Ln {cursorPos.line}, Col {cursorPos.col}
          </div>
        )}
      </div>

      {/* File header */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: "#6b7280",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={filePath ?? ""}
        >
          {filePath ?? "No file selected"}
        </div>

        {loading && <div style={{ fontSize: 12, color: "#6b7280" }}>Loading…</div>}
        {err && (
          <div
            style={{
              fontSize: 12,
              color: "crimson",
              maxWidth: 520,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={err}
          >
            {err}
          </div>
        )}

        {headerRight}
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        {!filePath ? (
          <div style={{ padding: 18, opacity: 0.7 }}>Select a file to start.</div>
        ) : !canView ? (
          <div style={{ padding: 18, color: "crimson" }}>
            {accessReason ? accessMessage(accessReason) : "You don't have permission to view this file."}
          </div>
        ) : (
          <Editor
            // model identity is handled explicitly via monaco.editor + setModel
            path={"inmemory://editor"}
            language={language}
            theme="vs"
            onMount={(editor, monacoApi) => {
              editorRef.current = editor;
              monacoRef.current = monacoApi as unknown as typeof monaco;

              // initial view options
              editor.updateOptions({
                readOnly: !canEdit,
                wordWrap: wordWrapOn ? "on" : "off",
                minimap: { enabled: minimapOn },
                lineNumbers: lineNumbersOn ? "on" : "off",
              });

              // Track cursor for status
              const disp = editor.onDidChangeCursorPosition(() => {
                const pos = editor.getPosition();
                if (!pos) return;
                setCursorPos({ line: pos.lineNumber, col: pos.column });
              });

              // Commands (save/download + command palette)
              try {
                const m = monacoApi as unknown as typeof monaco;
                editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
                  // download is allowed even when read-only
                  onDownload();
                });
                editor.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.KeyP, () => {
                  run("editor.action.quickCommand");
                });
              } catch {
                // ignore if monaco keycodes change
              }

              // cleanup cursor tracker on unmount
              (editorRef.current as any).__cursorDisp = disp;
            }}
            options={{
              automaticLayout: true,
              minimap: { enabled: minimapOn },
              fontSize: 14,
              tabSize: 2,
              insertSpaces: true,
              wordWrap: wordWrapOn ? "on" : "off",
              scrollBeyondLastLine: false,
              readOnly: !canEdit,
              domReadOnly: !canEdit,
              lineNumbers: lineNumbersOn ? "on" : "off",
              // keep editing UX close to mainstream editors
              bracketPairColorization: { enabled: true } as any,
              guides: { bracketPairs: true } as any,
              padding: { top: 8, bottom: 8 } as any,
              smoothScrolling: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
