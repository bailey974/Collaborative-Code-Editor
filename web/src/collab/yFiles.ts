import * as Y from "yjs";

/*
 * Project files live in the room's Y.Doc:
 *   "files"      Y.Map<path, Y.Text>   file contents
 *   "files:dirs" Y.Map<path, true>     explicitly created (possibly empty) folders
 * Paths are relative, "/"-separated, no leading slash: "src/main.py".
 */

const Y_FILES = "files";
const Y_DIRS = "files:dirs";
const Y_DOC_PERMS = "docs:perms";

export const MAX_FILE_BYTES = 1_000_000;

export function normalizePath(p?: string | null) {
  return (p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

export function basename(p: string) {
  const parts = normalizePath(p).split("/");
  return parts[parts.length - 1] ?? "";
}

export function dirname(p: string) {
  const parts = normalizePath(p).split("/");
  parts.pop();
  return parts.join("/");
}

export function joinPath(dir: string, name: string) {
  return normalizePath(dir ? `${dir}/${name}` : name);
}

export function getFilesMap(doc: Y.Doc) {
  return doc.getMap<Y.Text>(Y_FILES);
}

export function getDirsMap(doc: Y.Doc) {
  return doc.getMap<boolean>(Y_DIRS);
}

export function getOrCreateYText(doc: Y.Doc, filePath: string) {
  const files = getFilesMap(doc);
  const key = normalizePath(filePath);

  let ytext = files.get(key);
  if (!ytext) {
    ytext = new Y.Text();
    files.set(key, ytext);
  }
  return ytext;
}

export function fileExists(doc: Y.Doc, path: string) {
  return getFilesMap(doc).has(normalizePath(path));
}

function isUnder(path: string, dir: string) {
  return path === dir || path.startsWith(dir + "/");
}

export function dirExists(doc: Y.Doc, path: string) {
  const p = normalizePath(path);
  if (!p) return true;
  if (getDirsMap(doc).has(p)) return true;
  for (const k of getFilesMap(doc).keys()) if (k.startsWith(p + "/")) return true;
  return false;
}

export function createFile(doc: Y.Doc, path: string, content = "") {
  const p = normalizePath(path);
  if (!p) throw new Error("Enter a file name.");
  if (fileExists(doc, p)) throw new Error(`"${p}" already exists.`);
  if (dirExists(doc, p)) throw new Error(`"${p}" is a folder.`);
  doc.transact(() => {
    const text = new Y.Text();
    if (content) text.insert(0, content);
    getFilesMap(doc).set(p, text);
  });
  return p;
}

export function createDir(doc: Y.Doc, path: string) {
  const p = normalizePath(path);
  if (!p) throw new Error("Enter a folder name.");
  if (fileExists(doc, p)) throw new Error(`"${p}" is a file.`);
  getDirsMap(doc).set(p, true);
  return p;
}

/** Writes (or overwrites) many files at once, e.g. from an upload. */
export function writeFiles(doc: Y.Doc, entries: Array<{ path: string; content: string }>) {
  const files = getFilesMap(doc);
  doc.transact(() => {
    for (const { path, content } of entries) {
      const p = normalizePath(path);
      if (!p) continue;
      const existing = files.get(p);
      if (existing) {
        existing.delete(0, existing.length);
        existing.insert(0, content);
      } else {
        const text = new Y.Text();
        text.insert(0, content);
        files.set(p, text);
      }
    }
  });
}

/** Deletes a file, or a folder and everything under it. */
export function deletePath(doc: Y.Doc, path: string) {
  const p = normalizePath(path);
  if (!p) return;
  const files = getFilesMap(doc);
  const dirs = getDirsMap(doc);
  doc.transact(() => {
    for (const k of Array.from(files.keys())) if (isUnder(k, p)) files.delete(k);
    for (const k of Array.from(dirs.keys())) if (isUnder(k, p)) dirs.delete(k);
  });
}

/**
 * Renames/moves a file or folder. Y.Text can't be re-parented, so contents
 * are copied into new Y.Text instances. Per-file permissions follow the file
 * when the caller is allowed to change them (host only; the server reverts
 * anyone else).
 */
export function renamePath(doc: Y.Doc, from: string, to: string, opts: { movePerms: boolean }) {
  const src = normalizePath(from);
  const dst = normalizePath(to);
  if (!src || !dst || src === dst) return;
  if (isUnder(dst, src)) throw new Error("Can't move a folder into itself.");
  if (fileExists(doc, dst) || getDirsMap(doc).has(dst)) throw new Error(`"${dst}" already exists.`);

  const files = getFilesMap(doc);
  const dirs = getDirsMap(doc);
  const perms = doc.getMap<Y.Map<string>>(Y_DOC_PERMS);
  const remap = (k: string) => dst + k.slice(src.length);

  doc.transact(() => {
    for (const k of Array.from(files.keys())) {
      if (!isUnder(k, src)) continue;
      const text = new Y.Text();
      text.insert(0, files.get(k)!.toString());
      files.set(remap(k), text);
      files.delete(k);
    }
    for (const k of Array.from(dirs.keys())) {
      if (!isUnder(k, src)) continue;
      dirs.set(remap(k), true);
      dirs.delete(k);
    }
    if (opts.movePerms) {
      for (const k of Array.from(perms.keys())) {
        if (!isUnder(k, src)) continue;
        const acl = perms.get(k)!;
        const copy = new Y.Map<string>();
        acl.forEach((lvl, uid) => copy.set(uid, lvl));
        perms.set(remap(k), copy);
        perms.delete(k);
      }
    }
  });
  return dst;
}

export type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children: TreeNode[];
};

/** Builds a sorted tree (folders first) from the files and dirs maps. */
export function buildTree(doc: Y.Doc, include: (path: string) => boolean = () => true): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirIndex = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirIndex.get(path);
    if (existing) return existing;
    const parent = ensureDir(dirname(path));
    const node: TreeNode = { name: basename(path), path, type: "dir", children: [] };
    parent.children.push(node);
    dirIndex.set(path, node);
    return node;
  };

  for (const d of getDirsMap(doc).keys()) {
    const p = normalizePath(d);
    if (p && include(p)) ensureDir(p);
  }
  for (const f of getFilesMap(doc).keys()) {
    const p = normalizePath(f);
    if (!p || !include(p)) continue;
    ensureDir(dirname(p)).children.push({ name: basename(p), path: p, type: "file", children: [] });
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    for (const n of nodes) sort(n.children);
  };
  sort(root.children);
  return root.children;
}

/** Heuristic: treat files containing NUL bytes as binary. */
export function looksBinary(text: string) {
  return text.slice(0, 8000).includes("\u0000");
}
