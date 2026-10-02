import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import { attachPresenceStyles } from "./presenceStyles";

/**
 * Room-based collaboration context.
 *
 * Applies the design from:
 * - room roles (RBAC-ish: host/editor/viewer)
 * - file-tree visibility policy (share roots + hide/exclude rules)
 * - per-document permissions + request-to-edit workflow
 * - shared run output (host-controlled)
 *
 * The Room Durable Object (server/src/room.ts) is authoritative: it assigns
 * the host from the room's creator, makes viewers read-only, and reverts
 * changes to room settings made by anyone but the host. The checks here are
 * for UX only.
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

export type RoomInfo = {
  id: string;
  name: string;
  joinCode: string;
  maxUsers: number;
};

type Session = {
  doc: Y.Doc;
  provider: YProvider;
  awareness: YProvider["awareness"];
};

type PathAccess =
  | { ok: true }
  | { ok: false; reason: "tree_not_shared" | "outside_shared_roots" | "hidden" | "excluded" };

type CollabContextValue = {
  room: RoomInfo;
  roomId: string;

  // Yjs
  doc: Session["doc"];
  awareness: Session["awareness"];
  status: Status;
  lastError: string | null;
  synced: boolean;

  sendChat: (text: string) => void;

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
  defaultRole: "viewer" | "editor";
  setDefaultRole: (role: "viewer" | "editor") => void;
  setMemberRole: (userId: string, role: Exclude<RoomRole, "host"> | "viewer" | "editor") => void;

  setShareTreeEnabled: (enabled: boolean) => void;
  setShareRoots: (roots: string[]) => void;
  setHidePatterns: (patterns: string[]) => void;
  setExcludePatterns: (patterns: string[]) => void;

  // Google Drive folder linked to this room (host-only; stored in room:meta).
  driveFolder: { id: string; name: string } | null;
  setDriveFolder: (folder: { id: string; name: string } | null) => void;

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

/**
 * Collaboration server host + protocol. Defaults to the page's own origin
 * (production serves the app and the Worker together; `vite dev` proxies
 * /parties). Set VITE_COLLAB_URL to point at a different Worker.
 */
function resolveCollabServer() {
  const raw = String(import.meta.env.VITE_COLLAB_URL ?? "").trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const secure = u.protocol === "https:" || u.protocol === "wss:";
      return { host: u.host, protocol: secure ? ("wss" as const) : ("ws" as const) };
    } catch {
      // fall through to same-origin
    }
  }
  const secure = window.location.protocol === "https:";
  return { host: window.location.host, protocol: secure ? ("wss" as const) : ("ws" as const) };
}

/** Close reasons sent by the Room Durable Object that retrying won't fix. */
const FATAL_CLOSE_REASONS: Record<string, string> = {
  "room-full": "This room already has the maximum number of people connected.",
  unauthorized: "Your session is not authorised for this room. Try signing in again.",
  "room-deleted": "The host deleted this room.",
};

/** Minimum gap between access checks while the socket keeps failing. */
const ACCESS_CHECK_INTERVAL_MS = 10_000;

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
  room,
  displayName = "Anonymous",
  userId,
  token,
  onLeave,
  checkAccess,
}: {
  children: React.ReactNode;
  room: RoomInfo;
  displayName?: string;
  userId: string | number;
  /** JWT from /api/auth; the Worker checks it and room membership on connect. */
  token: string;
  /** Called when the user dismisses a fatal connection error. */
  onLeave?: () => void;
  /**
   * Asked while the socket can't connect. Resolve false if the user is no
   * longer a member (room deleted or left elsewhere) so we stop retrying.
   */
  checkAccess?: () => Promise<boolean>;
}) {
  const roomId = room.id;
  const [session, setSession] = useState<Session | null>(null);

  const [status, setStatus] = useState<Status>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  // Brief "back online" message after a reconnect has resynced (FR-5 / 2.3).
  const [notice, setNotice] = useState<string | null>(null);
  const checkAccessRef = useRef(checkAccess);
  checkAccessRef.current = checkAccess;
  const [roomName, setRoomName] = useState<string | null>(null);
  // Bumped on awareness changes so the member list stays live.
  const [awarenessTick, setAwarenessTick] = useState(0);
  const [defaultRole, setDefaultRoleSnap] = useState<"viewer" | "editor">("viewer");

  // Reactive snapshots from Yjs
  const [rolesSnap, setRolesSnap] = useState<Record<string, RoomRole>>({});
  const [hostId, setHostId] = useState<string | null>(null);
  const [driveFolderSnap, setDriveFolderSnap] = useState<{ id: string; name: string } | null>(null);

  const [visibilitySnap, setVisibilitySnap] = useState<VisibilityPolicy>({
    shareTreeEnabled: false,
    shareRoots: [],
    hidePatterns: [],
    excludePatterns: [],
  });

  const [terminalPolicySnap, setTerminalPolicySnap] = useState<TerminalPolicy>({
    shared: false,
    allowGuestInput: true,
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

  const server = useMemo(() => resolveCollabServer(), []);

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
    // Only announce "back online" after a drop that followed a successful sync.
    let everSynced = false;
    let wasOffline = false;
    let lastAccessCheck = 0;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;

    const doc = new Y.Doc();
    const provider = new YProvider(server.host, roomId, doc, {
      party: "room",
      protocol: server.protocol,
      params: { token },
      connect: true,
    });

    const awareness = provider.awareness;

    // Presence
    awareness.setLocalStateField("user", {
      id: meRef.current.userId,
      name: meRef.current.name,
      color: meRef.current.color,
    });

    const detachStyles = attachPresenceStyles(awareness);

    const onAwareness = () => {
      if (alive) setAwarenessTick((t) => t + 1);
    };
    awareness.on("change", onAwareness);

    const onStatus = (ev: any) => {
      if (!alive) return;
      const next = normalizeStatus(ev?.status);
      setStatus(next);
      if (next === "connected") setLastError(null);
      if (next === "disconnected" && everSynced) wasOffline = true;
    };
    provider.on("status", onStatus);

    const onSync = (isSynced: boolean) => {
      if (!alive) return;
      setSynced(!!isSynced);
      if (isSynced) everSynced = true;
      if (isSynced && wasOffline) {
        wasOffline = false;
        setNotice("Back online. Your changes are synced.");
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => alive && setNotice(null), 3500);
      }
    };
    provider.on("sync", onSync);

    const onConnError = () => {
      if (!alive) return;
      if (everSynced) wasOffline = true;
      setLastError("Can't reach the collaboration server. Retrying…");

      // A refused handshake (403: room deleted / no longer a member) looks the
      // same as a network error here, so ask the API before retrying forever.
      const check = checkAccessRef.current;
      const now = Date.now();
      if (!check || now - lastAccessCheck < ACCESS_CHECK_INTERVAL_MS) return;
      lastAccessCheck = now;
      check()
        .then((ok) => {
          if (!alive || ok) return;
          setFatalError("This room no longer exists, or you're no longer a member of it.");
          provider.disconnect();
        })
        .catch(() => {
          // offline or API down: keep retrying
        });
    };
    const onConnClose = (e: any) => {
      if (!alive) return;
      const reason = typeof e?.reason === "string" ? e.reason : "";
      if (FATAL_CLOSE_REASONS[reason]) {
        setFatalError(FATAL_CLOSE_REASONS[reason]);
        provider.disconnect();
        return;
      }
      if (everSynced) wasOffline = true;
      setStatus("disconnected");
      setLastError(`Connection lost (${stringifyReason(e)}). Reconnecting…`);
    };
    provider.on("connection-error", onConnError);
    provider.on("connection-close", onConnClose);

    // Shared structures. Defaults are read with fallbacks rather than written
    // here: the server owns room settings and would revert our writes.
    const roomMeta = doc.getMap<any>(Y_ROOM_META);
    const roles = doc.getMap<any>(Y_ROLES);
    const vis = doc.getMap<any>(Y_VIS);
    const roots = doc.getArray<string>(Y_VIS_ROOTS);
    const hide = doc.getArray<string>(Y_VIS_HIDE);
    const exclude = doc.getArray<string>(Y_VIS_EXCLUDE);

    const termPolicy = doc.getMap<any>(Y_TERM_POLICY);

    // Observe Yjs for snapshots
    const updateHost = () => {
      if (roomMeta.get("deleted") === true) {
        setFatalError(FATAL_CLOSE_REASONS["room-deleted"]);
        provider.disconnect();
        return;
      }
      setRoomName(String(roomMeta.get("name") ?? "") || null);
      setHostId(String(roomMeta.get("hostId") ?? "") || null);
      setDefaultRoleSnap(roomMeta.get("defaultRole") === "editor" ? "editor" : "viewer");
      const dfId = String(roomMeta.get("driveFolderId") ?? "");
      const dfName = String(roomMeta.get("driveFolderName") ?? "");
      setDriveFolderSnap(dfId ? { id: dfId, name: dfName || dfId } : null);
    };

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
        // Default on: editors may run code unless the host turns it off.
        allowGuestInput: termPolicy.get("allowGuestInput") !== false,
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

    setSession({ doc, provider, awareness });
    setStatus("connecting");
    setLastError(null);
    setFatalError(null);
    setSynced(false);
    setNotice(null);

    return () => {
      alive = false;

      provider.off("status", onStatus);
      provider.off("sync", onSync);
      awareness.off("change", onAwareness);
      provider.off("connection-error", onConnError);
      provider.off("connection-close", onConnClose);

      roomMeta.unobserve(updateHost);
      roles.unobserve(updateRoles);

      vis.unobserve(updateVisibility);
      roots.unobserve(updateVisibility);
      hide.unobserve(updateVisibility);
      exclude.unobserve(updateVisibility);

      termPolicy.unobserve(updateTerminalPolicy);
      editReqArr.unobserve(updateEditRequests);
      termReqArr.unobserve(updateTerminalRequests);

      clearTimeout(noticeTimer);
      detachStyles?.();
      provider.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [server, roomId, token]);

  // The host can rename the room; the server pushes the new name into room:meta.
  const liveRoom = useMemo(
    () => (roomName && roomName !== room.name ? { ...room, name: roomName } : room),
    [room, roomName]
  );

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, rolesSnap, hostId, me.userId, me.name, me.color, role, awarenessTick]);

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

    const setDefaultRole = (next: "viewer" | "editor") => {
      if (!isHost) return;
      session.doc.transact(() => {
        roomMeta.set("defaultRole", next);
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

    const setDriveFolder = (folder: { id: string; name: string } | null) => {
      if (!isHost) return;
      session.doc.transact(() => {
        if (folder && folder.id) {
          roomMeta.set("driveFolderId", folder.id);
          roomMeta.set("driveFolderName", folder.name || folder.id);
        } else {
          roomMeta.delete("driveFolderId");
          roomMeta.delete("driveFolderName");
        }
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

    // Viewers can't write to the doc, so requests and chat go through the
    // server, which appends them with the sender's verified identity.
    const sendToServer = (msg: Record<string, unknown>) => {
      try {
        session.provider.sendMessage(JSON.stringify(msg));
      } catch {
        // not connected; the user can retry
      }
    };

    const requestEdit = (path: string) => {
      const p = normalizePath(path);
      if (!p) return;

      // If we already have edit rights, no-op.
      if (levelRank(effectiveDocLevel(p)) >= levelRank("edit")) return;

      const existing = editReqArr.toArray().some((r: any) => {
        return r?.path === p && r?.requestedBy?.userId === me.userId;
      });
      if (existing) return;

      sendToServer({ type: "edit-request", path: p });
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
      if (termReqArr.toArray().some((x: any) => x?.userId === me.userId)) return;
      sendToServer({ type: "terminal-request" });
    };

    const sendChat = (text: string) => {
      const t = text.trim();
      if (t) sendToServer({ type: "chat", text: t });
    };

    return {
      room: liveRoom,
      roomId,

      doc: session.doc,
      awareness: session.awareness,
      status,
      lastError,
      synced,

      sendChat,

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

      defaultRole,
      setDefaultRole,
      setMemberRole,

      setShareTreeEnabled,
      setShareRoots,
      setHidePatterns,
      setExcludePatterns,

      driveFolder: driveFolderSnap,
      setDriveFolder,

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
    liveRoom,
    roomId,
    status,
    lastError,
    synced,
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
    defaultRole,
    driveFolderSnap,
  ]);

  if (fatalError) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 560 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Can't join “{room.name}”</div>
        <div style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{fatalError}</div>
        {onLeave && (
          <button
            onClick={onLeave}
            style={{
              marginTop: 14,
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #d1d5db",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Back to rooms
          </button>
        )}
      </div>
    );
  }

  if (!value) {
    return (
      <div style={{ padding: 16, fontFamily: "system-ui", opacity: 0.7 }}>
        Starting collaboration…
      </div>
    );
  }

  return (
    <CollabContext.Provider value={value}>
      {lastError && status !== "connected" && (
        <div role="status" style={toastStyle}>
          {lastError}
        </div>
      )}
      {notice && !(lastError && status !== "connected") && (
        <div role="status" style={toastStyle}>
          {notice}
        </div>
      )}
      {children}
    </CollabContext.Provider>
  );
}

const toastStyle: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: 16,
  transform: "translateX(-50%)",
  zIndex: 10000,
  padding: "8px 14px",
  borderRadius: 8,
  background: "#111827",
  color: "#fff",
  fontSize: 13,
  fontFamily: "system-ui",
  boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
};

export function useCollab() {
  const ctx = useContext(CollabContext);
  if (!ctx) throw new Error("useCollab must be used inside <CollabProvider />");
  return ctx;
}
