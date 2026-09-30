import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCollab } from "../collab/CollabProvider";
import {
  buildTree,
  createDir,
  createFile,
  deletePath,
  dirname,
  getDirsMap,
  getFilesMap,
  joinPath,
  looksBinary,
  MAX_FILE_BYTES,
  normalizePath,
  renamePath,
  writeFiles,
  type TreeNode,
} from "../collab/yFiles";
import {
  ChevronDown,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  Download,
  File,
  FileCode,
  FileImage,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Pencil,
  Settings,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import {
  importFolder,
  isDriveConfigured,
  pickFolder,
  pushFiles,
  type ImportEntry,
} from "../drive/googleDrive";

type Props = {
  activePath?: string;
  onOpenFile?: (path: string) => void;
};

// Skipped when uploading a folder: large, generated, or private.
const IGNORED_UPLOAD_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
]);

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

        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={shareTree}
              onChange={(e) => setShareTree(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>
              Share files with guests <span style={{ opacity: 0.7 }}>(off by default)</span>
            </span>
          </label>

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={addCwdAsRoot} style={btn} disabled={!cwd}>
              Add selected folder
            </button>
            <button onClick={setOnlyCwdRoot} style={btn} disabled={!cwd}>
              Only selected folder
            </button>
          </div>
        </div>

        <div
          style={{
            marginTop: 12,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
          }}
        >
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>
              Shared folders. Empty = share everything.
            </span>
            <textarea
              value={rootsText}
              onChange={(e) => setRootsText(e.target.value)}
              rows={10}
              placeholder={"src\ndocs"}
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
              placeholder={"*secrets*\n.env"}
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
              placeholder={"*.key\nprivate/*"}
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

function getFileIcon(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".py")) return <FileCode size={16} color="#3572A5" />;
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return <FileCode size={16} color="#3178C6" />;
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs"))
    return <FileCode size={16} color="#CA8A04" />;
  if (lower.endsWith(".json")) return <FileJson size={16} color="#CB3837" />;
  if (lower.endsWith(".html")) return <FileCode size={16} color="#E34F26" />;
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return <FileCode size={16} color="#1572B6" />;
  if (lower.endsWith(".md")) return <FileText size={16} color="#555555" />;
  if (lower.match(/\.(png|jpe?g|gif|svg|ico)$/)) return <FileImage size={16} color="#10B981" />;
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return <Terminal size={16} color="#16A34A" />;
  return <File size={16} color="#6B7280" />;
}

async function readUploads(files: FileList | File[]) {
  const entries: Array<{ path: string; content: string }> = [];
  const skipped: string[] = [];

  for (const f of Array.from(files)) {
    const rel = normalizePath((f as any).webkitRelativePath || f.name);
    if (!rel) continue;
    if (rel.split("/").some((seg) => IGNORED_UPLOAD_SEGMENTS.has(seg))) continue;

    if (f.size > MAX_FILE_BYTES) {
      skipped.push(`${rel} (over 1 MB)`);
      continue;
    }
    const content = await f.text();
    if (looksBinary(content)) {
      skipped.push(`${rel} (binary)`);
      continue;
    }
    entries.push({ path: rel, content });
  }
  return { entries, skipped };
}

function downloadBlob(filename: string, blob: Blob) {
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

export default function FileExplorer({ activePath, onOpenFile }: Props) {
  const { doc, isHost, role, room, visibility, getPathAccess, driveFolder, setDriveFolder } =
    useCollab();

  const [previewAsViewer, setPreviewAsViewer] = useState(false);
  const asGuest = !isHost || previewAsViewer;
  const canModifyTree = role === "host" || role === "editor";
  const driveOn = isDriveConfigured();

  const [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedDir, setSelectedDir] = useState("");
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [driveBusy, setDriveBusy] = useState<null | "import" | "push" | "link">(null);
  // Offer a one-click import when opening a room already linked to Drive.
  const [importOffer, setImportOffer] = useState(false);
  const offeredRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Re-render when files or folders are added/removed (not on text edits).
  useEffect(() => {
    const files = getFilesMap(doc);
    const dirs = getDirsMap(doc);
    const bump = () => setVersion((v) => v + 1);
    files.observe(bump);
    dirs.observe(bump);
    return () => {
      files.unobserve(bump);
      dirs.unobserve(bump);
    };
  }, [doc]);

  const tree = useMemo(() => {
    const include = (p: string) => !asGuest || getPathAccess(p, { asGuest: true }).ok;
    return buildTree(doc, include);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, version, asGuest, getPathAccess]);

  const q = filter.trim().toLowerCase();

  const visibleTree = useMemo(() => {
    if (!q) return tree;
    const prune = (nodes: TreeNode[]): TreeNode[] =>
      nodes.flatMap((n) => {
        if (n.type === "file") return n.path.toLowerCase().includes(q) ? [n] : [];
        const kids = prune(n.children);
        return kids.length || n.name.toLowerCase().includes(q) ? [{ ...n, children: kids }] : [];
      });
    return prune(tree);
  }, [tree, q]);

  // Reveal the active file's folders.
  useEffect(() => {
    if (!activePath) return;
    const parts = normalizePath(activePath).split("/");
    parts.pop();
    if (!parts.length) return;
    setExpanded((prev) => {
      const next = { ...prev };
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        next[acc] = true;
      }
      return next;
    });
  }, [activePath]);

  // On opening a room that's already linked to Drive, offer a one-click import.
  useEffect(() => {
    if (driveOn && driveFolder && !offeredRef.current) {
      offeredRef.current = true;
      setImportOffer(true);
    }
  }, [driveOn, driveFolder]);

  function flash(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice((m) => (m === msg ? null : m)), 5000);
  }

  function run(action: () => void) {
    setErr(null);
    try {
      action();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  function onNewFile() {
    const name = window.prompt(`New file in ${selectedDir || "(root)"}`, "main.py");
    if (!name) return;
    run(() => {
      const p = createFile(doc, joinPath(selectedDir, name));
      onOpenFile?.(p);
    });
  }

  function onNewFolder() {
    const name = window.prompt(`New folder in ${selectedDir || "(root)"}`);
    if (!name) return;
    run(() => {
      const p = createDir(doc, joinPath(selectedDir, name));
      setExpanded((e) => ({ ...e, [p]: true }));
      setSelectedDir(p);
    });
  }

  function onRename(node: TreeNode) {
    const next = window.prompt("Rename / move to", node.path);
    if (!next || normalizePath(next) === node.path) return;
    run(() => {
      const dst = renamePath(doc, node.path, next, { movePerms: isHost });
      if (!dst) return;
      if (activePath && (activePath === node.path || activePath.startsWith(node.path + "/"))) {
        onOpenFile?.(dst + activePath.slice(node.path.length));
      }
    });
  }

  function onDelete(node: TreeNode) {
    const what = node.type === "dir" ? `folder "${node.path}" and everything in it` : `"${node.path}"`;
    if (!window.confirm(`Delete ${what}? This deletes it for everyone in the room.`)) return;
    run(() => deletePath(doc, node.path));
  }

  async function onUpload(list: FileList | null, prefix: string) {
    if (!list || list.length === 0) return;
    setErr(null);
    const { entries, skipped } = await readUploads(list);
    const withPrefix = entries.map((e) => ({ ...e, path: joinPath(prefix, e.path) }));
    const overwriting = withPrefix.filter((e) => getFilesMap(doc).has(e.path)).length;
    if (overwriting > 0 && !window.confirm(`Overwrite ${overwriting} existing file(s)?`)) return;

    writeFiles(doc, withPrefix);
    flash(
      `Uploaded ${withPrefix.length} file(s)` +
        (skipped.length ? `; skipped ${skipped.length}: ${skipped.slice(0, 3).join(", ")}` : "")
    );
    if (withPrefix.length === 1) onOpenFile?.(withPrefix[0].path);
  }

  async function onDownloadZip() {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    let count = 0;
    getFilesMap(doc).forEach((text, path) => {
      if (asGuest && !getPathAccess(path, { asGuest: true }).ok) return;
      zip.file(path, text.toString());
      count++;
    });
    if (count === 0) {
      flash("No files to download.");
      return;
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const safeName = room.name.replace(/[^\w.-]+/g, "_") || "project";
    downloadBlob(`${safeName}.zip`, blob);
  }

  async function applyDriveImport(entries: ImportEntry[], skipped: string[]) {
    if (entries.length === 0) {
      flash(skipped.length ? `Nothing imported; skipped ${skipped.length}.` : "That folder has no importable files.");
      return;
    }
    const files = getFilesMap(doc);
    const overwriting = entries.filter((e) => files.has(normalizePath(e.path))).length;
    if (overwriting > 0 && !window.confirm(`Import will overwrite ${overwriting} existing file(s). Continue?`))
      return;
    writeFiles(doc, entries);
    flash(
      `Imported ${entries.length} file(s) from Drive` +
        (skipped.length ? `; skipped ${skipped.length}: ${skipped.slice(0, 3).join(", ")}` : "")
    );
    if (entries.length === 1) onOpenFile?.(normalizePath(entries[0].path));
  }

  // Import from Drive. If no folder is linked yet, the host picks one first.
  async function onDriveImport() {
    setErr(null);
    try {
      let folder = driveFolder;
      if (!folder) {
        if (!isHost) {
          setErr("Ask the host to link a Google Drive folder first.");
          return;
        }
        setDriveBusy("link");
        const picked = await pickFolder();
        if (!picked) return;
        setDriveFolder(picked);
        folder = picked;
      }
      setDriveBusy("import");
      const { entries, skipped } = await importFolder(folder.id);
      await applyDriveImport(entries, skipped);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setDriveBusy(null);
      setImportOffer(false);
    }
  }

  // Push every file in the room back into the linked Drive folder.
  async function onDrivePush() {
    setErr(null);
    if (!driveFolder) {
      setErr("Link a Google Drive folder first (Import from Drive).");
      return;
    }
    try {
      setDriveBusy("push");
      const entries: ImportEntry[] = [];
      getFilesMap(doc).forEach((text, path) => entries.push({ path, content: text.toString() }));
      if (entries.length === 0) {
        flash("No files to save.");
        return;
      }
      const res = await pushFiles(driveFolder.id, entries);
      flash(
        `Saved to Drive: ${res.created} new, ${res.updated} updated` +
          (res.skipped.length ? `, ${res.skipped.length} skipped` : "")
      );
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setDriveBusy(null);
    }
  }

  // Host: link a different Drive folder.
  async function onDriveRelink() {
    if (!isHost) return;
    setErr(null);
    try {
      setDriveBusy("link");
      const picked = await pickFolder();
      if (picked) setDriveFolder(picked);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setDriveBusy(null);
    }
  }

  function toggleDir(path: string) {
    setExpanded((e) => ({ ...e, [path]: !e[path] }));
    setSelectedDir(path);
  }

  function renderNodes(nodes: TreeNode[], depth: number): React.ReactNode {
    return nodes.map((n) => {
      const isDir = n.type === "dir";
      const open = !!q || !!expanded[n.path];
      const isActive = !isDir && activePath === n.path;
      const isSelectedDir = isDir && selectedDir === n.path;

      return (
        <React.Fragment key={n.path}>
          <div
            className="fx-row"
            onClick={() => {
              if (isDir) toggleDir(n.path);
              else {
                setSelectedDir(dirname(n.path));
                onOpenFile?.(n.path);
              }
            }}
            title={n.path}
            style={{
              padding: `5px 8px 5px ${10 + depth * 14}px`,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: isActive ? "#000" : "#374151",
              background: isActive ? "rgba(0,0,0,0.08)" : isSelectedDir ? "rgba(0,0,0,0.04)" : undefined,
              userSelect: "none",
            }}
          >
            <span style={{ width: 14, display: "inline-flex" }}>
              {isDir ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
            </span>
            <span style={{ display: "inline-flex", width: 18, justifyContent: "center" }}>
              {isDir ? (
                open ? (
                  <FolderOpen size={16} color="#EAB308" />
                ) : (
                  <Folder size={16} color="#EAB308" fill="#FEF08A" />
                )
              ) : (
                getFileIcon(n.name)
              )}
            </span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {n.name}
            </span>
            {canModifyTree && (
              <span className="fx-actions" style={{ display: "inline-flex", gap: 2 }}>
                <button
                  style={iconBtnStyle}
                  title="Rename / move"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename(n);
                  }}
                >
                  <Pencil size={13} color="#6B7280" />
                </button>
                <button
                  style={iconBtnStyle}
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(n);
                  }}
                >
                  <Trash2 size={13} color="#6B7280" />
                </button>
              </span>
            )}
          </div>
          {isDir && open && renderNodes(n.children, depth + 1)}
        </React.Fragment>
      );
    });
  }

  const emptyMessage =
    asGuest && !visibility.shareTreeEnabled
      ? "The host hasn't shared files with guests yet."
      : q
        ? "No matching files."
        : canModifyTree
          ? "No files yet. Create or upload some to get started."
          : "No files yet.";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <style>{`.fx-row .fx-actions{visibility:hidden}.fx-row:hover{background:rgba(0,0,0,0.04)}.fx-row:hover .fx-actions{visibility:visible}`}</style>

      <div style={{ padding: "8px 10px", display: "flex", gap: 4, alignItems: "center" }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "#4B5563",
            flex: 1,
          }}
        >
          Explorer
        </div>

        {canModifyTree && (
          <>
            <button onClick={onNewFile} style={iconBtnStyle} title="New file">
              <FilePlus size={15} color="#4B5563" />
            </button>
            <button onClick={onNewFolder} style={iconBtnStyle} title="New folder">
              <FolderPlus size={15} color="#4B5563" />
            </button>
            <button onClick={() => fileInputRef.current?.click()} style={iconBtnStyle} title="Upload files">
              <Upload size={15} color="#4B5563" />
            </button>
            <button onClick={() => folderInputRef.current?.click()} style={iconBtnStyle} title="Upload folder">
              <FolderUp size={15} color="#4B5563" />
            </button>
            {driveOn && (
              <>
                <button
                  onClick={() => void onDriveImport()}
                  style={iconBtnStyle}
                  disabled={driveBusy !== null}
                  title={
                    driveFolder
                      ? `Import from Google Drive folder “${driveFolder.name}”`
                      : isHost
                        ? "Link a Google Drive folder and import it"
                        : "Ask the host to link a Google Drive folder"
                  }
                >
                  <CloudDownload size={15} color={driveBusy === "import" ? "#9CA3AF" : "#4B5563"} />
                </button>
                <button
                  onClick={() => void onDrivePush()}
                  style={iconBtnStyle}
                  disabled={driveBusy !== null || !driveFolder}
                  title={
                    driveFolder
                      ? `Save all files to Google Drive folder “${driveFolder.name}”`
                      : "Link a Drive folder first"
                  }
                >
                  <CloudUpload size={15} color={driveBusy === "push" ? "#9CA3AF" : "#4B5563"} />
                </button>
              </>
            )}
          </>
        )}
        <button onClick={() => void onDownloadZip()} style={iconBtnStyle} title="Download project as .zip">
          <Download size={15} color="#4B5563" />
        </button>
        {isHost && (
          <button onClick={() => setPolicyOpen(true)} style={iconBtnStyle} title="Sharing policy">
            <Settings size={15} color="#4B5563" />
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void onUpload(e.target.files, selectedDir);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        hidden
        {...({ webkitdirectory: "", directory: "" } as any)}
        onChange={(e) => {
          void onUpload(e.target.files, selectedDir);
          e.target.value = "";
        }}
      />

      <div
        style={{
          padding: "0 10px 8px 10px",
          fontSize: 12,
          color: "#6B7280",
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderBottom: "1px solid #E5E7EB",
          marginBottom: 8,
        }}
      >
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title="New files and uploads go into this folder"
          onClick={() => setSelectedDir("")}
        >
          in: {selectedDir || "(root)"}
        </span>
        {isHost && (
          <label style={{ display: "flex", alignItems: "center", gap: 4 }} title="See the tree as guests do">
            <input
              type="checkbox"
              checked={previewAsViewer}
              onChange={(e) => setPreviewAsViewer(e.target.checked)}
            />
            Guest view
          </label>
        )}
      </div>

      {driveOn && (driveFolder || isHost) && (
        <div
          style={{
            padding: "0 10px 8px 10px",
            fontSize: 11,
            color: "#6B7280",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <CloudDownload size={12} />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Drive: {driveFolder ? driveFolder.name : "not linked"}
          </span>
          {isHost && driveFolder && (
            <button
              onClick={() => void onDriveRelink()}
              style={{ ...btn, padding: "2px 8px", fontSize: 11 }}
              disabled={driveBusy !== null}
            >
              Change
            </button>
          )}
        </div>
      )}

      <div style={{ padding: "0 10px 10px 10px" }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter..."
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            outline: "none",
          }}
        />
      </div>

      {err && <div style={{ padding: "0 10px 10px 10px", color: "crimson", fontSize: 12 }}>{err}</div>}
      {notice && <div style={{ padding: "0 10px 10px 10px", color: "#065F46", fontSize: 12 }}>{notice}</div>}

      {driveOn && importOffer && driveFolder && canModifyTree && (
        <div
          style={{
            margin: "0 10px 10px 10px",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid #bfdbfe",
            background: "#eff6ff",
            fontSize: 12,
            color: "#1e3a8a",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <CloudDownload size={14} />
          <span style={{ flex: 1 }}>
            Linked to Drive folder “{driveFolder.name}”.
          </span>
          <button onClick={() => void onDriveImport()} style={btn} disabled={driveBusy !== null}>
            {driveBusy === "import" ? "Importing…" : "Import latest"}
          </button>
          <button onClick={() => setImportOffer(false)} style={iconBtnStyle} title="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div
        style={{ flex: 1, overflow: "auto" }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedDir("");
        }}
      >
        {visibleTree.length === 0 ? (
          <div style={{ padding: 10, opacity: 0.75, fontSize: 13 }}>{emptyMessage}</div>
        ) : (
          renderNodes(visibleTree, 0)
        )}
      </div>

      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} cwd={selectedDir} />
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
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid #d1d5db",
  outline: "none",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 12,
};
