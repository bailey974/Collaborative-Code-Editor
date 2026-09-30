import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { attachPresenceStyles } from "./presenceStyles";

/**
 * Room-based collaboration context.
 *
 * Applies the design from:
 * - room roles (RBAC-ish: host/editor/viewer)
 * - file-tree visibility policy (share roots + hide/exclude rules)
 * - per-document permissions + request-to-edit workflow
 * - optional shared terminal (host-controlled)
 */

type Status = "connecting" | "connected" | "disconnected";

export type RoomRole = "host" | "editor" | "viewer";
export type DocPermissionLevel = "none" | "view" | "edit" | "manage";

export type VisibilityPolicy = {
  shareTreeEnabled: boolean;
  shareRoots: string[]; // include-list roots; empty => "all"
  hidePatterns: string[]; // glob-ish patterns
  excludePatterns: string[]; // glob-ish patterns (strongest)
};

export type Me = {
  userId: string;
  name: string;
  color: string;
};

export type Member = {
  userId: string;
  name: string;
  color: string;
  role: RoomRole;
  online: boolean;
};

export type EditRequest = {
  id: string;
  path: string; // document id in this app (file path)
  requestedBy: { userId: string; name: string };
  createdAt: number;
};

export type TerminalPolicy = {
  shared: boolean;
  allowGuestInput: boolean;
  controllerUserId: string | null; // null => host only, "*" => any guest
};

type Session = {
  doc: Y.Doc;
  provider: WebsocketProvider;
  awareness: WebsocketProvider["awareness"];
};

type PathAccess =
  | { ok: true }
  | { ok: false; reason: "tree_not_shared" | "outside_shared_roots" | "hidden" | "excluded" };

type CollabContextValue = {
  wsUrl: string;
  roomId: string;
  setRoomId: (id: string) => void;

  // Yjs
  doc: Session["doc"];
  awareness: Session["awareness"];
  status: Status;
  lastError: string | null;

  // identity + roles
  me: Me;
  role: RoomRole;
  isHost: boolean;
  members: Member[];

  // policies + rights
  visibility: VisibilityPolicy;
  terminalPolicy: TerminalPolicy;

  getPathAccess: (path: string, opts?: { asGuest?: boolean }) => PathAccess;
  effectiveDocLevel: (path: string) => DocPermissionLevel;
  canViewDoc: (path: string) => boolean;
  canEditDoc: (path: string) => boolean;

  // host controls
  setMemberRole: (userId: string, role: Exclude<RoomRole, "host"> | "viewer" | "editor") => void;

  setShareTreeEnabled: (enabled: boolean) => void;
  setShareRoots: (roots: string[]) => void;
  setHidePatterns: (patterns: string[]) => void;
  setExcludePatterns: (patterns: string[]) => void;

  grantDocPermission: (path: string, userId: string, level: DocPermissionLevel) => void;

  // request-to-edit
  editRequests: EditRequest[];
  requestEdit: (path: string) => void;
  resolveEditRequest: (id: string, approve: boolean) => void;

  // terminal controls
  setTerminalPolicy: (patch: Partial<TerminalPolicy>) => void;
  requestTerminalControl: () => void;
  terminalRequests: Array<{ id: string; userId: string; name: string; createdAt: number }>;
};

const CollabContext = createContext<CollabContextValue | null>(null);

/* =========================
   Small utilities
========================= */

function randomColor() {
  const hues = [10, 40, 90, 140, 190, 220, 260, 300];
  const h = hues[Math.floor(Math.random() * hues.length)];
  return `hsl(${h} 80% 55%)`;
}

function normalizeStatus(s: any): Status {
  const v = String(s ?? "").toLowerCase();
  if (v === "connected") return "connected";
  if (v === "disconnected") return "disconnected";
  return "connecting";
}

function stringifyReason(input: any) {
  // CloseEvent.reason and CloseEvent.code are sometimes non-enumerable, so JSON.stringify() can lose them.
  const ev = input?.event ?? input;

  const code = typeof ev?.code === "number" ? (ev.code as number) : null;
  const reasonStr =
    typeof ev?.reason === "string" && ev.reason.trim().length > 0 ? ev.reason.trim() : null;

  if (reasonStr) {
    // Include non-normal close codes for debugging.
    if (code && code !== 1000) return `${reasonStr} (code ${code})`;
    return reasonStr;
  }
  if (code && code !== 1000) return `WebSocket closed (code ${code})`;

  if (!input) return "Unknown error";
  if (typeof input === "string") return input;
  if (input?.message) return String(input.message);
  if (typeof input?.reason === "string" && input.reason.trim()) return input.reason.trim();
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function stableUserId(input: unknown) {
  const s = String(input ?? "").trim();
  if (s) return s;
  // avoid collisions across clients
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as any).randomUUID()
      : `anon-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
  return rnd;
}

function normalizePath(p: string) {
  return (p ?? "").replace(/\\/g, "/").replace(/\/+/g, "/");
}

function resolveWsBaseUrl(explicit?: string) {
  const env = (import.meta as any)?.env?.VITE_COLLAB_WS_URL;
  let raw = String(explicit ?? env ?? "ws://localhost:1234").trim();

  // Strip accidental wrapping quotes that break WebSocket URLs on Windows/.env.
  raw = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();

  // Allow users to paste Render HTTPS URLs; convert to ws/wss.
  if (raw.startsWith("https://")) raw = "wss://" + raw.slice("https://".length);
  else if (raw.startsWith("http://")) raw = "ws://" + raw.slice("http://".length);

  // y-websocket expects a base URL; room is appended by the client provider.
  // If a path was accidentally included, drop it.
  try {
    const u = new URL(raw);
    raw = u.origin; // keeps ws/wss scheme
  } catch {
    // keep as-is
  }

  raw = raw.replace(/\/+$/, "");
  return raw;
}

function globToRegExp(pattern: string) {
  // Very small glob: * => any chars, ? => single char
  // Everything else escaped.
  const p = normalizePath(pattern.trim());
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const rx = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  try {
    return new RegExp(rx, "i");
  } catch {
    // If the regex is malformed, treat as non-matching.
    return null;
  }
}

function isUnderRoot(path: string, root: string) {
  const p = normalizePath(path);
  const r = normalizePath(root);
  if (!r) return true;
  if (p === r) return true;
  const withSlash = r.endsWith("/") ? r : r + "/";
  return p.startsWith(withSlash);
}

function levelRank(lvl: DocPermissionLevel): number {
  switch (lvl) {
    case "none":
      return 0;
    case "view":
      return 1;
    case "edit":
      return 2;
    case "manage":
      return 3;
    default:
      return 0;
  }
}

function minLevel(a: DocPermissionLevel, b: DocPermissionLevel): DocPermissionLevel {
  return levelRank(a) <= levelRank(b) ? a : b;
}

function roleMaxLevel(role: RoomRole): DocPermissionLevel {
  if (role === "host") return "manage";
  if (role === "editor") return "edit";
  return "view";
}

/* =========================
   Yjs object names
========================= */

const Y_ROOM_META = "room:meta"; // map: hostId
const Y_ROLES = "room:roles"; // map: userId => role
const Y_VIS = "room:visibility"; // map: shareTreeEnabled
const Y_VIS_ROOTS = "room:visibility:roots"; // array<string>
const Y_VIS_HIDE = "room:visibility:hide"; // array<string>
const Y_VIS_EXCLUDE = "room:visibility:exclude"; // array<string>

const Y_DOC_PERMS = "docs:perms"; // map: path => Y.Map(userId => level)
const Y_EDIT_REQUESTS = "docs:editRequests"; // array<EditRequest>

const Y_TERM_POLICY = "terminal:policy"; // map: shared, allowGuestInput, controllerUserId
const Y_TERM_REQUESTS = "terminal:requests"; // array<{id,userId,name,createdAt}>

/* =========================
   Provider
========================= */

export function CollabProvider({
  children,
  defaultRoomId = "default-room",
  wsUrl,
  displayName = "Anonymous",
  userId,
  token,
}: {
  children: React.ReactNode;
  defaultRoomId?: string;
  wsUrl?: string;
  displayName?: string;
  userId?: string | number;

  /**
   * Access token (e.g., your Django SimpleJWT access token).
   * NOTE: This provider currently uses `y-websocket` (no built-in auth), so this is unused.
   * If you switch back to a Hocuspocus server/provider, you can use this for onAuthenticate.
   */
  token?: string | (() => string | Promise<string>);
}) {
  const [roomId, setRoomId] = useState(defaultRoomId);
  const [session, setSession] = useState<Session | null>(null);

  const [status, setStatus] = useState<Status>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  // Reactive snapshots from Yjs
  const [rolesSnap, setRolesSnap] = useState<Record<string, RoomRole>>({});
  const [hostId, setHostId] = useState<string | null>(null);

  const [visibilitySnap, setVisibilitySnap] = useState<VisibilityPolicy>({
    shareTreeEnabled: false,
    shareRoots: [],
    hidePatterns: [],
    excludePatterns: [],
  });

  const [terminalPolicySnap, setTerminalPolicySnap] = useState<TerminalPolicy>({
    shared: false,
    allowGuestInput: false,
    controllerUserId: null,
  });

  const [editRequestsSnap, setEditRequestsSnap] = useState<EditRequest[]>([]);
  const [terminalRequestsSnap, setTerminalRequestsSnap] = useState<
    Array<{ id: string; userId: string; name: string; createdAt: number }>
  >([]);

  // Stable identity for this client
  const meRef = useRef<Me>({
    userId: stableUserId(userId ?? displayName),
    name: displayName,
    color: randomColor(),
  });

  const resolvedWsUrl = useMemo(() => resolveWsBaseUrl(wsUrl), [wsUrl]);

  // Keep name fresh (user might login after first render)
  useEffect(() => {
    meRef.current = {
      ...meRef.current,
      userId: stableUserId(userId ?? meRef.current.userId),
      name: displayName || meRef.current.name,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, displayName]);

  useEffect(() => {
    let alive = true;

    const doc = new Y.Doc();
    // NOTE:
    // This client is configured to work with the `y-websocket` server (e.g. `npx y-websocket --port 1234`).
    // If you are running a Hocuspocus server instead, swap this back to HocuspocusProvider.
    const provider = new WebsocketProvider(resolvedWsUrl, roomId, doc, {
      connect: true,
    } as any);

    const awareness = provider.awareness;
    const envRaw = (import.meta as any)?.env?.VITE_COLLAB_WS_URL;
    const attemptedUrl = `${resolvedWsUrl}/${encodeURIComponent(roomId)}`;
    // eslint-disable-next-line no-console
    console.log("[collab] ws connect", { wsBase: resolvedWsUrl, roomId, attemptedUrl, env: envRaw });


    // Presence
    awareness.setLocalStateField("user", {
      id: meRef.current.userId,
      name: meRef.current.name,
      color: meRef.current.color,
    });

    const detachStyles = attachPresenceStyles(awareness as any);

    const onStatus = (ev: any) => {
      if (!alive) return;
      const next = normalizeStatus(ev?.status);
      setStatus(next);
      if (next === "connected") setLastError(null);
    };

    provider.on("status", onStatus);

    // Some builds of y-websocket provider emit these events (safe even if unused).
    const onConnError = (e: any) => {
      if (!alive) return;
      setLastError(
        (prev) =>
          prev ??
          `WebSocket error\nURL: ${attemptedUrl}\nVITE_COLLAB_WS_URL: ${String(envRaw ?? "").trim() || "(unset)"}`
      );
    };
    const onConnClose = (e: any) => {
      if (!alive) return;
      const reason = stringifyReason(e);
      setStatus("disconnected");
      setLastError(
        (prev) =>
          prev ??
          `${reason}\nURL: ${attemptedUrl}\nVITE_COLLAB_WS_URL: ${String(envRaw ?? "").trim() || "(unset)"}`
      );
    };
    provider.on("connection-error", onConnError);
    provider.on("connection-close", onConnClose);

    // Capture close codes/reasons from the underlying WebSocket when available.
    // (Browsers may report code 1005 when the peer closes without a close frame.)
    let wsCloseHandler: any = null;
    let wsErrorHandler: any = null;
    const attachWsListeners = () => {
      const ws = (provider as any)?.ws;
      if (!ws || wsCloseHandler) return;
      wsCloseHandler = (e: any) => {
        if (!alive) return;
        setStatus("disconnected");
        const reason = stringifyReason(e);
        setLastError(
          (prev) =>
            prev ??
            `${reason}
URL: ${attemptedUrl}
VITE_COLLAB_WS_URL: ${String(envRaw ?? "").trim() || "(unset)"}`
        );
      };
      wsErrorHandler = (e: any) => {
        if (!alive) return;
        setLastError(
          (prev) =>
            prev ??
            `WebSocket error
URL: ${attemptedUrl}
VITE_COLLAB_WS_URL: ${String(envRaw ?? "").trim() || "(unset)"}`
        );
      };
      ws.addEventListener?.("close", wsCloseHandler);
      ws.addEventListener?.("error", wsErrorHandler);
    };
    attachWsListeners();

    // Initialize shared structures (do not overwrite if already present)
    const roomMeta = doc.getMap<any>(Y_ROOM_META);
    const roles = doc.getMap<any>(Y_ROLES);
    const vis = doc.getMap<any>(Y_VIS);
    const roots = doc.getArray<string>(Y_VIS_ROOTS);
    const hide = doc.getArray<string>(Y_VIS_HIDE);
    const exclude = doc.getArray<string>(Y_VIS_EXCLUDE);

    const termPolicy = doc.getMap<any>(Y_TERM_POLICY);

    doc.transact(() => {
      if (vis.get("shareTreeEnabled") == null) vis.set("shareTreeEnabled", false);

      if (termPolicy.get("shared") == null) termPolicy.set("shared", false);
      if (termPolicy.get("allowGuestInput") == null) termPolicy.set("allowGuestInput", false);
      if (termPolicy.get("controllerUserId") == null) termPolicy.set("controllerUserId", null);

      // Ensure our user has at least a role entry once host exists.
      // (We will also compute host based on roomMeta.hostId.)
      if (!roles.get(meRef.current.userId)) {
        // default: viewer until host grants editor
        roles.set(meRef.current.userId, "viewer");
      }
    });

    // Try to claim host if none exists (best-effort; backend should enforce in production)
    const tryClaimHost = () => {
      if (!alive) return;
      doc.transact(() => {
        const current = roomMeta.get("hostId");
        if (!current) {
          roomMeta.set("hostId", meRef.current.userId);
          roles.set(meRef.current.userId, "host");
        }
      });
    };

    // Observe Yjs for snapshots
    const updateHost = () => setHostId(String(roomMeta.get("hostId") ?? "") || null);

    const updateRoles = () => {
      const out: Record<string, RoomRole> = {};
      roles.forEach((v, k) => {
        const role = String(v) as RoomRole;
        if (role === "host" || role === "editor" || role === "viewer") out[String(k)] = role;
      });
      setRolesSnap(out);
    };

    const updateVisibility = () => {
      const snap: VisibilityPolicy = {
        shareTreeEnabled: !!vis.get("shareTreeEnabled"),
        shareRoots: roots.toArray().map((x) => String(x)),
        hidePatterns: hide.toArray().map((x) => String(x)),
        excludePatterns: exclude.toArray().map((x) => String(x)),
      };
      setVisibilitySnap(snap);
    };

    const updateTerminalPolicy = () => {
      const snap: TerminalPolicy = {
        shared: !!termPolicy.get("shared"),
        allowGuestInput: !!termPolicy.get("allowGuestInput"),
        controllerUserId: (termPolicy.get("controllerUserId") as any) ?? null,
      };
      setTerminalPolicySnap(snap);
    };

    const editReqArr = doc.getArray<any>(Y_EDIT_REQUESTS);
    const updateEditRequests = () => {
      const raw = editReqArr.toArray();
      const parsed: EditRequest[] = raw
        .map((x) => x as EditRequest)
        .filter((x) => x && typeof x.id === "string" && typeof x.path === "string")
        .sort((a, b) => a.createdAt - b.createdAt);
      setEditRequestsSnap(parsed);
    };

    const termReqArr = doc.getArray<any>(Y_TERM_REQUESTS);
    const updateTerminalRequests = () => {
      const raw = termReqArr.toArray();
      const parsed = raw
        .map((x) => x as any)
        .filter((x) => x && typeof x.id === "string" && typeof x.userId === "string")
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      setTerminalRequestsSnap(parsed);
    };

    updateHost();
    updateRoles();
    updateVisibility();
    updateTerminalPolicy();
    updateEditRequests();
    updateTerminalRequests();

    roomMeta.observe(updateHost);
    roles.observe(updateRoles);

    vis.observe(updateVisibility);
    roots.observe(updateVisibility);
    hide.observe(updateVisibility);
    exclude.observe(updateVisibility);

    termPolicy.observe(updateTerminalPolicy);

    editReqArr.observe(updateEditRequests);
    termReqArr.observe(updateTerminalRequests);

    // When we become connected, attempt host claim if needed.
    const statusWatcher = (ev: any) => {
      const next = normalizeStatus(ev?.status);
      if (next === "connected") {
        attachWsListeners();
        tryClaimHost();
      }
    };
    provider.on("status", statusWatcher);

    setSession({ doc, provider, awareness });
    setStatus("connecting");
    setLastError(null);

    return () => {
      alive = false;

      provider.off("status", onStatus);
      provider.off("status", statusWatcher);
      provider.off("connection-error", onConnError);
      provider.off("connection-close", onConnClose);

      // best-effort detach underlying ws listeners
      const ws = (provider as any)?.ws;
      if (ws && wsCloseHandler) ws.removeEventListener?.("close", wsCloseHandler);
      if (ws && wsErrorHandler) ws.removeEventListener?.("error", wsErrorHandler);

      roomMeta.unobserve(updateHost);
      roles.unobserve(updateRoles);

      vis.unobserve(updateVisibility);
      roots.unobserve(updateVisibility);
      hide.unobserve(updateVisibility);
      exclude.unobserve(updateVisibility);

      termPolicy.unobserve(updateTerminalPolicy);
      editReqArr.unobserve(updateEditRequests);
      termReqArr.unobserve(updateTerminalRequests);

      detachStyles?.();
      provider.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [resolvedWsUrl, roomId, token]);

  const me = meRef.current;
  const isHost = hostId === me.userId;

  const role: RoomRole = useMemo(() => {
    if (isHost) return "host";
    return rolesSnap[me.userId] ?? "viewer";
  }, [isHost, rolesSnap, me.userId]);

  // keep awareness role field in sync (presence only)
  useEffect(() => {
    if (!session) return;
    try {
      (session.awareness as any).setLocalStateField("role", role);
    } catch {
      // ignore
    }
  }, [session, role]);

  const members: Member[] = useMemo(() => {
    if (!session) return [];
    const states = session.awareness.getStates();
    const out: Member[] = [];
    states.forEach((st: any) => {
      const user = st?.user;
      if (!user?.id) return;
      const uid = String(user.id);
      const r = uid === hostId ? "host" : rolesSnap[uid] ?? "viewer";
      out.push({
        userId: uid,
        name: String(user.name ?? uid),
        color: String(user.color ?? "#888"),
        role: r,
        online: true,
      });
    });

    // ensure we always render self (even if awareness hasn't propagated yet)
    if (!out.some((m) => m.userId === me.userId)) {
      out.push({
        userId: me.userId,
        name: me.name,
        color: me.color,
        role,
        online: true,
      });
    }

    // stable ordering: host first, then editors, then viewers, then alpha
    const order = (r: RoomRole) => (r === "host" ? 0 : r === "editor" ? 1 : 2);
    out.sort((a, b) => {
      const d = order(a.role) - order(b.role);
      if (d !== 0) return d;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [session, rolesSnap, hostId, me.userId, me.name, me.color, role]);

  const getPathAccess = useMemo(() => {
    return (path: string, opts?: { asGuest?: boolean }): PathAccess => {
      const asGuest = opts?.asGuest ?? !isHost;
      if (!asGuest) return { ok: true };

      const p = normalizePath(path);

      if (!visibilitySnap.shareTreeEnabled) return { ok: false, reason: "tree_not_shared" };

      const roots = visibilitySnap.shareRoots.map(normalizePath).filter(Boolean);
      if (roots.length > 0) {
        const ok = roots.some((r) => isUnderRoot(p, r));
        if (!ok) return { ok: false, reason: "outside_shared_roots" };
      }

      // exclude wins
      for (const pat of visibilitySnap.excludePatterns) {
        const rx = globToRegExp(pat);
        if (rx && rx.test(p)) return { ok: false, reason: "excluded" };
      }
      for (const pat of visibilitySnap.hidePatterns) {
        const rx = globToRegExp(pat);
        if (rx && rx.test(p)) return { ok: false, reason: "hidden" };
      }

      return { ok: true };
    };
  }, [visibilitySnap, isHost]);

  const effectiveDocLevel = useMemo(() => {
    return (path: string): DocPermissionLevel => {
      if (!session) return "none";

      // role-based max
      const maxByRole = roleMaxLevel(role);

      // host always manage
      if (role === "host") return "manage";

      const docPerms = session.doc.getMap<any>(Y_DOC_PERMS);
      const key = normalizePath(path);
      const acl = docPerms.get(key) as Y.Map<any> | undefined;

      const aclLevelRaw = acl?.get(me.userId);
      const aclLevel = (String(aclLevelRaw ?? "") as DocPermissionLevel) || null;

      // default: if no ACL entry, inherit from room role (common mental model)
      const inherited = aclLevel ?? maxByRole;

      // clamp by room role capability
      return minLevel(inherited, maxByRole);
    };
  }, [session, role, me.userId]);

  const canViewDoc = useMemo(() => {
    return (path: string) => {
      const access = getPathAccess(path, { asGuest: !isHost });
      if (!access.ok) return false;
      return levelRank(effectiveDocLevel(path)) >= levelRank("view");
    };
  }, [getPathAccess, effectiveDocLevel, isHost]);

  const canEditDoc = useMemo(() => {
    return (path: string) => {
      const access = getPathAccess(path, { asGuest: !isHost });
      if (!access.ok) return false;
      return levelRank(effectiveDocLevel(path)) >= levelRank("edit");
    };
  }, [getPathAccess, effectiveDocLevel, isHost]);

  const value = useMemo<CollabContextValue | null>(() => {
    if (!session) return null;

    const roomMeta = session.doc.getMap<any>(Y_ROOM_META);
    const roles = session.doc.getMap<any>(Y_ROLES);

    const vis = session.doc.getMap<any>(Y_VIS);
    const roots = session.doc.getArray<string>(Y_VIS_ROOTS);
    const hide = session.doc.getArray<string>(Y_VIS_HIDE);
    const exclude = session.doc.getArray<string>(Y_VIS_EXCLUDE);

    const docPerms = session.doc.getMap<any>(Y_DOC_PERMS);
    const editReqArr = session.doc.getArray<any>(Y_EDIT_REQUESTS);

    const termPolicy = session.doc.getMap<any>(Y_TERM_POLICY);
    const termReqArr = session.doc.getArray<any>(Y_TERM_REQUESTS);

    const setMemberRole = (userId: string, nextRole: RoomRole) => {
      if (!isHost) return;
      const uid = String(userId);
      if (uid === me.userId) return;
      if (uid === hostId) return;
      if (nextRole === "host") return;
      session.doc.transact(() => {
        roles.set(uid, nextRole);
      });
    };

    const setShareTreeEnabled = (enabled: boolean) => {
      if (!isHost) return;
      session.doc.transact(() => {
        vis.set("shareTreeEnabled", !!enabled);
      });
    };

    const setShareRoots = (next: string[]) => {
      if (!isHost) return;
      session.doc.transact(() => {
        roots.delete(0, roots.length);
        for (const r of next.map(normalizePath).filter(Boolean)) roots.push([r]);
      });
    };

    const setHidePatterns = (next: string[]) => {
      if (!isHost) return;
      session.doc.transact(() => {
        hide.delete(0, hide.length);
        for (const r of next.map(normalizePath).filter(Boolean)) hide.push([r]);
      });
    };

    const setExcludePatterns = (next: string[]) => {
      if (!isHost) return;
      session.doc.transact(() => {
        exclude.delete(0, exclude.length);
        for (const r of next.map(normalizePath).filter(Boolean)) exclude.push([r]);
      });
    };

    const grantDocPermission = (path: string, userId: string, level: DocPermissionLevel) => {
      if (!isHost) return;
      const key = normalizePath(path);
      const uid = String(userId);
      if (!uid) return;

      session.doc.transact(() => {
        let acl = docPerms.get(key) as Y.Map<any> | undefined;
        if (!acl) {
          acl = new Y.Map<any>();
          docPerms.set(key, acl);
        }
        acl.set(uid, level);
      });
    };

    const requestEdit = (path: string) => {
      const p = normalizePath(path);
      if (!p) return;

      // If we already have edit rights, no-op.
      if (levelRank(effectiveDocLevel(p)) >= levelRank("edit")) return;

      // Avoid duplicates (same requester + same path)
      const existing = editReqArr.toArray().some((r: any) => {
        return r?.path === p && r?.requestedBy?.userId === me.userId;
      });
      if (existing) return;

      const req: EditRequest = {
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? (crypto as any).randomUUID()
            : `req-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`,
        path: p,
        requestedBy: { userId: me.userId, name: me.name },
        createdAt: Date.now(),
      };

      session.doc.transact(() => {
        editReqArr.push([req as any]);
      });
    };

    const resolveEditRequest = (id: string, approve: boolean) => {
      if (!isHost) return;
      const arr = editReqArr;
      const idx = arr.toArray().findIndex((x: any) => x?.id === id);
      if (idx < 0) return;

      const req = arr.get(idx) as any as EditRequest;

      session.doc.transact(() => {
        // remove request
        arr.delete(idx, 1);

        if (approve) {
          let acl = docPerms.get(req.path) as Y.Map<any> | undefined;
          if (!acl) {
            acl = new Y.Map<any>();
            docPerms.set(req.path, acl);
          }
          acl.set(req.requestedBy.userId, "edit");
        }
      });
    };

    const setTerminalPolicy = (patch: Partial<TerminalPolicy>) => {
      if (!isHost) return;
      session.doc.transact(() => {
        if (patch.shared != null) termPolicy.set("shared", !!patch.shared);
        if (patch.allowGuestInput != null)
          termPolicy.set("allowGuestInput", !!patch.allowGuestInput);
        if (patch.controllerUserId !== undefined)
          termPolicy.set("controllerUserId", patch.controllerUserId);
      });
    };

    const requestTerminalControl = () => {
      if (isHost) return;
      const exists = termReqArr
        .toArray()
        .some((x: any) => x?.userId === me.userId && !x?.resolvedAt);

      if (exists) return;

      const req = {
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? (crypto as any).randomUUID()
            : `termreq-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`,
        userId: me.userId,
        name: me.name,
        createdAt: Date.now(),
      };

      session.doc.transact(() => {
        termReqArr.push([req as any]);
      });
    };

    return {
      wsUrl: resolvedWsUrl,
      roomId,
      setRoomId,

      doc: session.doc,
      awareness: session.awareness,
      status,
      lastError,

      me,
      role,
      isHost,
      members,

      visibility: visibilitySnap,
      terminalPolicy: terminalPolicySnap,

      getPathAccess,
      effectiveDocLevel,
      canViewDoc,
      canEditDoc,

      setMemberRole,

      setShareTreeEnabled,
      setShareRoots,
      setHidePatterns,
      setExcludePatterns,

      grantDocPermission,

      editRequests: editRequestsSnap,
      requestEdit,
      resolveEditRequest,

      setTerminalPolicy,
      requestTerminalControl,
      terminalRequests: terminalRequestsSnap,
    };
  }, [
    session,
    resolvedWsUrl,
    roomId,
    status,
    lastError,
    me,
    role,
    isHost,
    hostId,
    members,
    visibilitySnap,
    terminalPolicySnap,
    getPathAccess,
    effectiveDocLevel,
    canViewDoc,
    canEditDoc,
    editRequestsSnap,
    terminalRequestsSnap,
  ]);

  if (!value) {
    return (
      <div style={{ padding: 16, fontFamily: "system-ui", opacity: 0.7 }}>
        Starting collaboration…
      </div>
    );
  }

  if (lastError) {
    return (
      <div style={{ padding: 16, fontFamily: "system-ui" }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Collaboration error</div>
        <div style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{lastError}</div>
        <div style={{ marginTop: 8, opacity: 0.7 }}>
          If this says <b>room-full</b>, the room already has 10 users.
        </div>
      </div>
    );
  }

  return <CollabContext.Provider value={value}>{children}</CollabContext.Provider>;
}

export function useCollab() {
  const ctx = useContext(CollabContext);
  if (!ctx) throw new Error("useCollab must be used inside <CollabProvider />");
  return ctx;
}
