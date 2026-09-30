import React, { useEffect, useMemo, useState } from "react";
import { useCollab } from "../collab/CollabProvider";
import {
  Folder,
  FolderOpen,
  FileCode,
  FileJson,
  FileImage,
  FileText,
  File,
  Terminal,
  RefreshCw,
  CornerLeftUp,
  Settings,
  ShieldAlert,
} from "lucide-react";
type AnyEntry = any;

type NormalEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
};

type ListResponse = {
  path: string;
  entries: AnyEntry[];
};

type ReadResponse =
  | { content: string } // expected
  | { data: string } // fallback
  | string; // fallback

export type RequestJson = <T = any>(path: string, opts?: RequestInit) => Promise<T>;

type Props = {
  requestJson: RequestJson;
  initialPath?: string;
  activePath?: string;
  onOpenFile?: (path: string, content?: string) => void;
};

function normalizeEntry(e: AnyEntry): NormalEntry {
  const rawPath: string =
    e.path ?? e.full_path ?? e.file_path ?? e.filePath ?? e.abs_path ?? "";
  const rawName: string =
    e.name ?? e.filename ?? e.base ?? e.basename ?? rawPath.split(/[\\/]/).pop() ?? "";

  const isDir =
    e.type === "dir" ||
    e.kind === "dir" ||
    e.is_dir === true ||
    e.isDir === true ||
    e.directory === true;

  return {
    name: rawName,
    path: rawPath,
    type: isDir ? "dir" : "file",
  };
}

function normalizePath(p: string) {
  return (p ?? "").replace(/\\/g, "/").replace(/\/+/g, "/");
}

function accessMessage(reason: string) {
  switch (reason) {
    case "tree_not_shared":
      return "Host has not shared the file tree.";
    case "outside_shared_roots":
      return "This path is outside the shared roots.";
    case "hidden":
      return "This path is hidden by the host.";
    case "excluded":
      return "This path is excluded by the host (cannot be opened).";
    default:
      return "Access denied.";
  }
}

function PolicyModal({
  open,
  onClose,
  cwd,
}: {
  open: boolean;
  onClose: () => void;
  cwd: string;
}) {
  const {
    visibility,
    setShareTreeEnabled,
    setShareRoots,
    setHidePatterns,
    setExcludePatterns,
  } = useCollab();

  const [shareTree, setShareTree] = useState(visibility.shareTreeEnabled);

  const [rootsText, setRootsText] = useState(visibility.shareRoots.join("\n"));
  const [hideText, setHideText] = useState(visibility.hidePatterns.join("\n"));
  const [excludeText, setExcludeText] = useState(visibility.excludePatterns.join("\n"));

  useEffect(() => {
    if (!open) return;
    setShareTree(visibility.shareTreeEnabled);
    setRootsText(visibility.shareRoots.join("\n"));
    setHideText(visibility.hidePatterns.join("\n"));
    setExcludeText(visibility.excludePatterns.join("\n"));
  }, [open, visibility]);

  if (!open) return null;

  const parseLines = (t: string) =>
    t
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(normalizePath);

  const apply = () => {
    setShareTreeEnabled(shareTree);
    setShareRoots(parseLines(rootsText));
    setHidePatterns(parseLines(hideText));
    setExcludePatterns(parseLines(excludeText));
    onClose();
  };

  const addCwdAsRoot = () => {
    const cwdNorm = normalizePath(cwd);
    const roots = new Set(parseLines(rootsText));
    if (cwdNorm) roots.add(cwdNorm);
    setRootsText(Array.from(roots).join("\n"));
  };

  const setOnlyCwdRoot = () => {
    const cwdNorm = normalizePath(cwd);
    setRootsText(cwdNorm ? cwdNorm : "");
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          width: 720,
          maxWidth: "92vw",
          background: "#fff",
          borderRadius: 12,
          padding: 14,
          border: "1px solid #e5e7eb",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Sharing policy</div>
          <div style={{ marginLeft: "auto" }}>
            <button onClick={onClose} style={btn}>
              ✕
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={shareTree}
              onChange={(e) => setShareTree(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>
              Share Tree <span style={{ opacity: 0.7 }}>(OFF by default is safer)</span>
            </span>
          </label>

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={addCwdAsRoot} style={btn}>
              Add cwd as root
            </button>
            <button onClick={setOnlyCwdRoot} style={btn}>
              Only cwd
            </button>
          </div>
        </div>

        <div
          style={{
            marginTop: 12,
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 10,
          }}
        >
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>
              Share roots (include-list). Empty = share everything.
            </span>
            <textarea
              value={rootsText}
              onChange={(e) => setRootsText(e.target.value)}
              rows={10}
              placeholder={"/src\n/docs"}
              style={ta}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>
              Hidden (not listed, and blocked)
            </span>
            <textarea
              value={hideText}
              onChange={(e) => setHideText(e.target.value)}
              rows={10}
              placeholder={"**/secrets/**\n.env"}
              style={ta}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>
              Excluded (strongest; blocked even via deep links)
            </span>
            <textarea
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              rows={10}
              placeholder={"**/node_modules/**\n**/.git/**"}
              style={ta}
            />
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={btn}>
            Cancel
          </button>
          <button
            onClick={apply}
            style={{
              ...btn,
              borderColor: "#111827",
              background: "#111827",
              color: "#fff",
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FileExplorer({
  requestJson,
  initialPath = "",
  activePath,
  onOpenFile,
}: Props) {
  const { isHost, visibility, getPathAccess } = useCollab();

  const [previewAsViewer, setPreviewAsViewer] = useState(false);

  const asGuest = !isHost || previewAsViewer;

  const [cwd, setCwd] = useState(initialPath);
  const [entries, setEntries] = useState<NormalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const [policyOpen, setPolicyOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((x) => {
      const hay = `${x.name} ${x.path}`.toLowerCase();
      return hay.includes(q);
    });
  }, [entries, filter]);

  const effectiveInitial = useMemo(() => {
    if (!asGuest) return initialPath;
    if (!visibility.shareTreeEnabled) return "";
    const roots = visibility.shareRoots.filter(Boolean);
    return roots.length > 0 ? roots[0] : initialPath;
  }, [asGuest, initialPath, visibility.shareRoots, visibility.shareTreeEnabled]);

  async function refresh(path = cwd) {
    const p = path ?? "";

    // enforce policy for guests
    if (asGuest) {
      const access = getPathAccess(p, { asGuest: true });
      if (!access.ok) {
        setEntries([]);
        setCwd(p);
        setErr(accessMessage(access.reason));
        return;
      }
    }

    setLoading(true);
    setErr(null);

    try {
      const res = await requestJson<ListResponse>(`/fs/list?path=${encodeURIComponent(p)}`);
      const normalized = (res.entries ?? []).map(normalizeEntry);

      // client-side filtering by visibility policy (server should enforce in production)
      const filteredByPolicy = asGuest
        ? normalized.filter((x) => getPathAccess(x.path, { asGuest: true }).ok)
        : normalized;

      filteredByPolicy.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      setCwd(res.path ?? p);
      setEntries(filteredByPolicy);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load directory");
    } finally {
      setLoading(false);
    }
  }

  function goUp() {
    const p = (cwd ?? "").replace(/[\\\/]+$/, "");
    if (!p) return;

    const sep = p.includes("\\") ? "\\" : "/";
    const idx = p.lastIndexOf(sep);

    let next = idx <= 0 ? sep : p.slice(0, idx);

    // Don't allow guests to leave the shared roots.
    if (asGuest && visibility.shareRoots.length > 0) {
      const roots = visibility.shareRoots.map(normalizePath).filter(Boolean);

      // If next is not under any root, clamp to the first matching root for current cwd.
      const currentNorm = normalizePath(cwd);
      const currentRoot = roots.find((r) => currentNorm.startsWith(r.endsWith("/") ? r : r + "/")) ?? roots[0];
      if (currentRoot && !normalizePath(next).startsWith(normalizePath(currentRoot))) {
        next = currentRoot;
      }
    }

    void refresh(next);
  }

  async function openEntry(e: NormalEntry) {
    if (asGuest) {
      const access = getPathAccess(e.path, { asGuest: true });
      if (!access.ok) {
        setErr(accessMessage(access.reason));
        return;
      }
    }

    if (e.type === "dir") {
      await refresh(e.path);
      return;
    }

    // Always notify selection immediately so editor can react.
    onOpenFile?.(e.path);

    // Optional: try to read content from backend; but don't block opening on it.
    try {
      const readRes = await requestJson<ReadResponse>(`/fs/read?path=${encodeURIComponent(e.path)}`);
      const content =
        typeof readRes === "string" ? readRes : (readRes as any)?.content ?? (readRes as any)?.data ?? "";

      if (typeof content === "string") onOpenFile?.(e.path, content);
    } catch {
      // ignore read failure; file is still "opened" by path selection
    }
  }

  useEffect(() => {
    setCwd(effectiveInitial || "");
    setEntries([]);
    setErr(null);

    if (asGuest && !visibility.shareTreeEnabled) {
      setErr("Host has not shared the file tree.");
      return;
    }

    void refresh(effectiveInitial || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveInitial, asGuest, visibility.shareTreeEnabled, previewAsViewer]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "8px 10px", display: "flex", gap: 6, alignItems: "center" }}>
        <div style={{ fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "#4B5563", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
          Explorer
        </div>

        {isHost && (
          <>
            <button onClick={() => setPolicyOpen(true)} style={iconBtnStyle} title="Sharing Policy">
              <Settings size={14} color="#4B5563" />
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.85, marginRight: 8 }}>
              <input
                type="checkbox"
                checked={previewAsViewer}
                onChange={(e) => setPreviewAsViewer(e.target.checked)}
              />
              Preview
            </label>
          </>
        )}

        <button onClick={goUp} disabled={loading} style={iconBtnStyle} title="Go Up (Parent Directory)">
          <CornerLeftUp size={14} color={loading ? "#9CA3AF" : "#4B5563"} />
        </button>
        <button onClick={() => refresh()} disabled={loading} style={iconBtnStyle} title="Refresh Explorer">
          <RefreshCw size={14} color={loading ? "#9CA3AF" : "#4B5563"} />
        </button>
      </div>

      <div
        title={cwd}
        style={{
          padding: "0 10px 8px 10px",
          fontSize: 12,
          color: "#6B7280",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          borderBottom: "1px solid #E5E7EB",
          marginBottom: 8
        }}
      >
        {cwd || "(root)"}{" "}
        {asGuest && (
          <span style={{ marginLeft: 6, opacity: 0.9 }}>
            • shared • roots:{visibility.shareRoots.length || "all"} • hidden:{visibility.hidePatterns.length} •
            excluded:{visibility.excludePatterns.length}
          </span>
        )}
      </div>

      <div style={{ padding: "0 10px 10px 10px" }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter..."
          style={{
            width: "100%",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            outline: "none",
          }}
        />
      </div>

      {err && (
        <div style={{ padding: "0 10px 10px 10px", color: "crimson", fontSize: 12 }}>{err}</div>
      )}

      <div style={{ flex: 1, overflow: "auto" }}>
        {loading && entries.length === 0 ? (
          <div style={{ padding: 10, opacity: 0.75 }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 10, opacity: 0.75 }}>
            {asGuest && !visibility.shareTreeEnabled ? "No shared files." : "No entries."}
          </div>
        ) : (
          filtered.map((e) => {
            const isActive = !!activePath && activePath === e.path;

            // Helper to determine the file icon
            const getFileIcon = (fileName: string) => {
              const lower = fileName.toLowerCase();
              if (lower.endsWith(".py")) return <FileCode size={16} color="#3572A5" />; // Blue
              if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return <FileCode size={16} color="#3178C6" />; // TS Blue
              if (lower.endsWith(".js") || lower.endsWith(".jsx")) return <FileCode size={16} color="#F7DF1E" />; // JS Yellow
              if (lower.endsWith(".json")) return <FileJson size={16} color="#CB3837" />; // Red
              if (lower.endsWith(".html")) return <FileCode size={16} color="#E34F26" />; // HTML Orange
              if (lower.endsWith(".css") || lower.endsWith(".scss")) return <FileCode size={16} color="#1572B6" />; // CSS Blue
              if (lower.endsWith(".md")) return <FileText size={16} color="#555555" />;
              if (lower.match(/\.(png|jpe?g|gif|svg|ico)$/)) return <FileImage size={16} color="#10B981" />; // Green
              if (lower.endsWith(".sh") || lower.endsWith(".bash")) return <Terminal size={16} color="#4ADE80" />;
              return <File size={16} color="#6B7280" />; // Gray fallback
            };

            return (
              <div
                key={e.path}
                onClick={() => void openEntry(e)}
                onDoubleClick={() => void openEntry(e)}
                title={e.path}
                style={{
                  padding: "6px 10px 6px 14px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: isActive ? "#000" : "#374151", // darker text for active
                  background: isActive ? "rgba(0, 0, 0, 0.08)" : "transparent",
                  transition: "background 0.1s ease",
                  userSelect: "none"
                }}
                onMouseEnter={(ev) => {
                  if (!isActive) ev.currentTarget.style.background = "rgba(0, 0, 0, 0.04)";
                }}
                onMouseLeave={(ev) => {
                  if (!isActive) ev.currentTarget.style.background = "transparent";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18 }}>
                  {e.type === "dir" ? (
                    <Folder size={16} color="#EAB308" fill="#FEF08A" />
                  ) : (
                    getFileIcon(e.name)
                  )}
                </div>
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
                  }}
                >
                  {e.name}
                </span>
              </div>
            );
          })
        )}
      </div>

      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} cwd={cwd} />
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  padding: "4px",
  borderRadius: 4,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const btn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid #d1d5db",
  background: "#fff",
  cursor: "pointer",
};

const ta: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid #d1d5db",
  outline: "none",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 12,
};
