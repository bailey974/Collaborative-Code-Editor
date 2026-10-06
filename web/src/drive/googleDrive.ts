/*
 * Google Drive integration (client-side only — no tokens ever touch our server).
 *
 * Flow, matching the room model where files live in the shared Y.Doc:
 *   - "Import" opens the Google Picker; the user signs in and selects any mix
 *     of files and folders, which are pulled into the doc (folders recursively).
 *   - "Save to Drive" pushes the doc's files back into a chosen folder.
 *
 * Access uses the `drive.file` scope: combined with the Picker, Google grants
 * the app access only to the folder the user explicitly chose (and its
 * contents), so we never request the broad, verification-gated Drive scopes.
 *
 * Config is public (no secrets — an OAuth Client ID and a browser API key).
 * It's fetched at startup from the Worker's GET /api/config (the
 * GOOGLE_CLIENT_ID / GOOGLE_API_KEY vars in server/wrangler.jsonc), so a
 * deploy never needs them at build time. VITE_GOOGLE_CLIENT_ID /
 * VITE_GOOGLE_API_KEY still work as a build-time fallback.
 * When either is missing, isDriveConfigured() is false and the UI stays hidden.
 */

import { looksBinary, MAX_FILE_BYTES, normalizePath } from "../collab/yFiles";

let CLIENT_ID = String(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
let API_KEY = String(import.meta.env.VITE_GOOGLE_API_KEY ?? "").trim();

const API_BASE = (import.meta.env.VITE_API_BASE_URL?.toString() ?? "").replace(/\/+$/, "");

/** Loads the Drive config from the Worker. Never throws; gives up after 3s. */
export async function loadDriveConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/config`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const cfg = (await res.json()) as { googleClientId?: string; googleApiKey?: string };
    if (cfg.googleClientId && cfg.googleApiKey) {
      CLIENT_ID = cfg.googleClientId;
      API_KEY = cfg.googleApiKey;
    }
  } catch {
    // offline or old Worker: keep the build-time values
  }
}

// drive.file: app only sees files it created or the user picked. Enough for
// importing/pushing a folder chosen via the Picker, and avoids app verification.
const SCOPE = "https://www.googleapis.com/auth/drive.file";

const FOLDER_MIME = "application/vnd.google-apps.folder";

export type DriveFolder = { id: string; name: string };
export type DriveItem = { id: string; name: string; mimeType: string };
export type ImportEntry = { path: string; content: string };
export type ImportResult = { entries: ImportEntry[]; skipped: string[] };
export type PushResult = { created: number; updated: number; skipped: string[] };

export function isDriveConfigured() {
  return CLIENT_ID.length > 0 && API_KEY.length > 0;
}

/* ------------------------------------------------------------------ */
/* Script loading                                                      */
/* ------------------------------------------------------------------ */

const loaded = new Map<string, Promise<void>>();

function loadScript(src: string) {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
    loaded.set(src, p);
  }
  return p;
}

// Minimal shapes for the Google globals we touch.
declare global {
  interface Window {
    google?: any;
    gapi?: any;
  }
}

async function loadGis() {
  await loadScript("https://accounts.google.com/gsi/client");
  if (!window.google?.accounts?.oauth2) throw new Error("Google Identity failed to initialise.");
}

async function loadPicker() {
  await loadScript("https://apis.google.com/js/api.js");
  await new Promise<void>((resolve, reject) => {
    window.gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("Picker failed to load.")) });
  });
}

/* ------------------------------------------------------------------ */
/* Auth — an in-memory access token for the session                    */
/* ------------------------------------------------------------------ */

let cachedToken = "";
let cachedTokenExpiry = 0;
let tokenClient: any = null;

/**
 * Returns a Drive access token, prompting the user via Google's consent popup
 * the first time. Must be called from a user gesture (a click). Tokens are
 * cached in memory only and expire ~1h; we refresh silently when we can.
 */
export async function getAccessToken(): Promise<string> {
  if (!isDriveConfigured()) throw new Error("Google Drive is not configured.");
  if (cachedToken && Date.now() < cachedTokenExpiry - 60_000) return cachedToken;

  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: () => {}, // replaced per-request below
    });
  }

  return new Promise<string>((resolve, reject) => {
    tokenClient.callback = (resp: any) => {
      if (resp?.error) {
        reject(new Error(resp.error_description || resp.error || "Google sign-in failed."));
        return;
      }
      cachedToken = resp.access_token;
      cachedTokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      resolve(cachedToken);
    };
    // prompt: "" lets Google skip the popup if consent is still valid.
    tokenClient.requestAccessToken({ prompt: cachedToken ? "" : "consent" });
  });
}

/* ------------------------------------------------------------------ */
/* Folder picker                                                       */
/* ------------------------------------------------------------------ */

/** Opens the Google Picker in folder-select mode. Resolves null if cancelled. */
export async function pickFolder(): Promise<DriveFolder | null> {
  const token = await getAccessToken();
  await loadPicker();

  return new Promise<DriveFolder | null>((resolve, reject) => {
    try {
      const google = window.google;
      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setMimeTypes(FOLDER_MIME)
        .setParent("root");

      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .setTitle("Choose a folder to link to this room")
        .setCallback((data: any) => {
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.PICKED) {
            const doc = data[google.picker.Response.DOCUMENTS]?.[0];
            resolve(doc ? { id: doc.id, name: doc.name } : null);
          } else if (action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Opens the Google Picker allowing multi-select of both files and folders.
 * Signs the user in first (consent popup on first use). Resolves [] if
 * cancelled. Whatever the user picks is what `drive.file` grants us access to.
 */
export async function pickItems(): Promise<DriveItem[]> {
  const token = await getAccessToken();
  await loadPicker();

  return new Promise<DriveItem[]>((resolve, reject) => {
    try {
      const google = window.google;
      // DOCS view, folders included and selectable, so the user can tick any
      // mix of individual files and whole folders.
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setParent("root");

      const picker = new google.picker.PickerBuilder()
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .setTitle("Choose files or folders to import")
        .setCallback((data: any) => {
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.PICKED) {
            const docs = data[google.picker.Response.DOCUMENTS] ?? [];
            resolve(
              docs.map((d: any) => ({ id: d.id, name: d.name, mimeType: d.mimeType }))
            );
          } else if (action === google.picker.Action.CANCEL) {
            resolve([]);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/* ------------------------------------------------------------------ */
/* Drive REST helpers                                                  */
/* ------------------------------------------------------------------ */

async function driveFetch(url: string, init: RequestInit = {}, token?: string) {
  const t = token ?? (await getAccessToken());
  const resp = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, ...(init.headers || {}) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Drive API ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp;
}

type DriveChild = { id: string; name: string; mimeType: string };

async function listChildren(folderId: string, token: string): Promise<DriveChild[]> {
  const out: DriveChild[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const resp = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`, {}, token);
    const json: any = await resp.json();
    out.push(...(json.files ?? []));
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

async function downloadText(fileId: string, token: string): Promise<string> {
  const resp = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {},
    token
  );
  return resp.text();
}

/* ------------------------------------------------------------------ */
/* Import: picked files/folders -> flat list of text files             */
/* ------------------------------------------------------------------ */

/**
 * Imports whatever the user picked — any mix of individual files and folders —
 * into a flat path->content list. Folders are walked recursively; a picked
 * item keeps its own name as the top-level path (folder "src" -> "src/…",
 * file "notes.py" -> "notes.py"). Google-native docs, binaries and files over
 * MAX_FILE_BYTES are reported in `skipped` rather than imported.
 */
export async function importItems(items: DriveItem[]): Promise<ImportResult> {
  const token = await getAccessToken();
  const entries: ImportEntry[] = [];
  const skipped: string[] = [];

  const importFile = async (
    file: { id: string; name: string; mimeType: string },
    rel: string
  ) => {
    // Google-native docs (Docs/Sheets/…) have no raw bytes to download.
    if (file.mimeType.startsWith("application/vnd.google-apps")) {
      skipped.push(`${rel} (Google ${file.mimeType.split(".").pop()})`);
      return;
    }
    try {
      const content = await downloadText(file.id, token);
      if (content.length > MAX_FILE_BYTES) {
        skipped.push(`${rel} (over 1 MB)`);
        return;
      }
      if (looksBinary(content)) {
        skipped.push(`${rel} (binary)`);
        return;
      }
      entries.push({ path: rel, content });
    } catch {
      skipped.push(`${rel} (download failed)`);
    }
  };

  const walk = async (id: string, prefix: string) => {
    const children = await listChildren(id, token);
    for (const child of children) {
      const rel = normalizePath(prefix ? `${prefix}/${child.name}` : child.name);
      if (!rel) continue;
      if (child.mimeType === FOLDER_MIME) {
        await walk(child.id, rel);
      } else {
        await importFile(child, rel);
      }
    }
  };

  for (const item of items) {
    const base = normalizePath(item.name);
    if (!base) continue;
    if (item.mimeType === FOLDER_MIME) {
      await walk(item.id, base);
    } else {
      await importFile(item, base);
    }
  }
  return { entries, skipped };
}

/* ------------------------------------------------------------------ */
/* Push: room files -> Drive folder (create/update, mirror structure)  */
/* ------------------------------------------------------------------ */

async function findChild(parentId: string, name: string, token: string): Promise<DriveChild | null> {
  const escaped = name.replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `'${parentId}' in parents and name = '${escaped}' and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: "1",
  });
  const resp = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`, {}, token);
  const json: any = await resp.json();
  return json.files?.[0] ?? null;
}

async function ensureSubfolder(parentId: string, name: string, token: string): Promise<string> {
  const existing = await findChild(parentId, name, token);
  if (existing && existing.mimeType === FOLDER_MIME) return existing.id;
  const resp = await driveFetch(
    "https://www.googleapis.com/drive/v3/files?fields=id",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    },
    token
  );
  const json: any = await resp.json();
  return json.id;
}

async function uploadText(
  parentId: string,
  name: string,
  content: string,
  existingId: string | null,
  token: string
) {
  if (existingId) {
    await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
      { method: "PATCH", headers: { "Content-Type": "text/plain" }, body: content },
      token
    );
    return;
  }
  const boundary = "-------collab" + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    metadata +
    `\r\n--${boundary}\r\n` +
    "Content-Type: text/plain\r\n\r\n" +
    content +
    `\r\n--${boundary}--`;
  await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
    token
  );
}

export async function pushFiles(rootFolderId: string, files: ImportEntry[]): Promise<PushResult> {
  const token = await getAccessToken();
  const result: PushResult = { created: 0, updated: 0, skipped: [] };

  // Cache folder-path -> Drive id so we only resolve each subfolder once.
  const dirCache = new Map<string, string>([["", rootFolderId]]);

  const resolveDir = async (dir: string): Promise<string> => {
    const cached = dirCache.get(dir);
    if (cached) return cached;
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    const name = dir.includes("/") ? dir.slice(dir.lastIndexOf("/") + 1) : dir;
    const parentId = await resolveDir(parent);
    const id = await ensureSubfolder(parentId, name, token);
    dirCache.set(dir, id);
    return id;
  };

  for (const { path, content } of files) {
    const p = normalizePath(path);
    if (!p) continue;
    try {
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      const name = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
      const parentId = await resolveDir(dir);
      const existing = await findChild(parentId, name, token);
      const existingFileId = existing && existing.mimeType !== FOLDER_MIME ? existing.id : null;
      await uploadText(parentId, name, content, existingFileId, token);
      if (existingFileId) result.updated++;
      else result.created++;
    } catch (e) {
      result.skipped.push(`${p} (${e instanceof Error ? e.message : "failed"})`);
    }
  }
  return result;
}
