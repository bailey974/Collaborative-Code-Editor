import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext } from "partyserver";

/*
 * One Durable Object per room. Holds the room's Y.Doc in memory, syncs it to
 * every connected client and persists it to the object's own SQLite storage.
 *
 * The Worker (index.ts) authenticates the socket and checks room membership
 * before the request reaches this class, and forwards who the user is in
 * x-collab-* headers.
 *
 * Y.Doc key names must match web/src/collab/CollabProvider.tsx.
 */

const Y_ROOM_META = "room:meta";
const Y_ROLES = "room:roles";
const Y_DOC_PERMS = "docs:perms";
const Y_EDIT_REQUESTS = "docs:editRequests";
const Y_TERM_REQUESTS = "terminal:requests";
const Y_CHAT = "chat:messages";

/** Only the host (or the server itself) may change these. */
const HOST_ONLY_MAPS = [Y_ROOM_META, Y_ROLES, "room:visibility", "terminal:policy"];
const HOST_ONLY_ARRAYS = [
  "room:visibility:roots",
  "room:visibility:hide",
  "room:visibility:exclude",
  Y_EDIT_REQUESTS,
  Y_TERM_REQUESTS,
  Y_CHAT,
];
// docs:perms is a map of path => Y.Map(userId => level), handled separately.
const PROTECTED = new Set([...HOST_ONLY_MAPS, ...HOST_ONLY_ARRAYS, Y_DOC_PERMS]);

const MAX_CHAT_MESSAGES = 500;
const MAX_CHAT_LENGTH = 4000;
const CHUNK_BYTES = 512 * 1024; // stay well under the 2 MB SQLite row limit

type ConnState = { userId: string; name: string };
type Snapshot = Record<string, unknown>;

const SERVER_ORIGIN = "server";

function makeId() {
  return crypto.randomUUID();
}

export class Room extends YServer {
  static options = { hibernate: true };

  static callbackOptions = {
    debounceWait: 5000,
    debounceMaxWait: 20000,
    timeout: 10000,
  };

  private snapshot: Snapshot = {};
  private guardInstalled = false;

  /* ---------- persistence ---------- */

  async onLoad() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS ydoc (chunk INTEGER PRIMARY KEY, data BLOB NOT NULL)");

    const rows = sql.exec<{ data: ArrayBuffer }>("SELECT data FROM ydoc ORDER BY chunk").toArray();
    if (rows.length > 0) {
      const parts = rows.map((r) => new Uint8Array(r.data));
      const total = parts.reduce((n, p) => n + p.length, 0);
      const update = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        update.set(p, offset);
        offset += p.length;
      }
      Y.applyUpdate(this.document, update, SERVER_ORIGIN);
    }

    this.installGuard();
  }

  async onSave() {
    const update = Y.encodeStateAsUpdate(this.document);
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM ydoc");
      for (let i = 0, chunk = 0; i < update.length; i += CHUNK_BYTES, chunk++) {
        sql.exec("INSERT INTO ydoc (chunk, data) VALUES (?, ?)", chunk, update.slice(i, i + CHUNK_BYTES));
      }
    });
  }

  /* ---------- connections ---------- */

  onConnect(conn: Connection, ctx: ConnectionContext) {
    const h = ctx.request.headers;
    const userId = h.get("x-collab-user-id") ?? "";
    const name = h.get("x-collab-user-name") ?? "user";
    const hostId = h.get("x-collab-host-id") ?? "";
    const maxUsers = Number(h.get("x-collab-max-users") ?? "10") || 10;

    if (!userId) {
      conn.close(4001, "unauthorized");
      return;
    }

    const online = new Set<string>();
    for (const c of this.getConnections<ConnState>()) {
      if (c.id !== conn.id && c.state?.userId) online.add(c.state.userId);
    }
    if (!online.has(userId) && online.size >= maxUsers) {
      conn.close(4003, "room-full");
      return;
    }

    conn.setState({ userId, name } satisfies ConnState);

    // The room creator (from D1) is always the host; everyone else starts with
    // the default role set by the host (viewer unless changed).
    const meta = this.document.getMap<unknown>(Y_ROOM_META);
    const roles = this.document.getMap<unknown>(Y_ROLES);
    this.document.transact(() => {
      if (hostId && meta.get("hostId") !== hostId) meta.set("hostId", hostId);
      if (hostId && roles.get(hostId) !== "host") roles.set(hostId, "host");
      if (!roles.has(userId)) roles.set(userId, meta.get("defaultRole") === "editor" ? "editor" : "viewer");
    }, SERVER_ORIGIN);

    super.onConnect(conn, ctx);
  }

  private userOf(conn: Connection): ConnState | null {
    const st = conn.state as ConnState | null | undefined;
    return st?.userId ? st : null;
  }

  private isHostUser(userId: string) {
    return this.document.getMap<unknown>(Y_ROOM_META).get("hostId") === userId;
  }

  private hasAnyEditGrant(userId: string) {
    const perms = this.document.getMap<Y.Map<string>>(Y_DOC_PERMS);
    for (const acl of perms.values()) {
      const lvl = acl instanceof Y.Map ? acl.get(userId) : undefined;
      if (lvl === "edit" || lvl === "manage") return true;
    }
    return false;
  }

  /**
   * Viewers cannot write to the shared doc at all, unless the host granted
   * them edit access to at least one file. Chat and requests from viewers go
   * through custom messages instead.
   */
  isReadOnly(conn: Connection) {
    const user = this.userOf(conn);
    if (!user) return true;
    const role = this.document.getMap<unknown>(Y_ROLES).get(user.userId);
    if (this.isHostUser(user.userId) || role === "editor") return false;
    return !this.hasAnyEditGrant(user.userId);
  }

  /* ---------- custom messages (chat + requests) ---------- */

  onCustomMessage(conn: Connection, message: string) {
    const user = this.userOf(conn);
    if (!user) return;

    let msg: { type?: string; text?: unknown; path?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    const doc = this.document;

    if (msg.type === "chat") {
      const text = String(msg.text ?? "").trim().slice(0, MAX_CHAT_LENGTH);
      if (!text) return;
      const chat = doc.getArray<unknown>(Y_CHAT);
      doc.transact(() => {
        chat.push([{ id: makeId(), userId: user.userId, name: user.name, text, createdAt: Date.now() }]);
        const overflow = chat.length - MAX_CHAT_MESSAGES;
        if (overflow > 0) chat.delete(0, overflow);
      }, SERVER_ORIGIN);
      return;
    }

    if (msg.type === "edit-request") {
      const path = String(msg.path ?? "").trim();
      if (!path) return;
      const arr = doc.getArray<any>(Y_EDIT_REQUESTS);
      const dup = arr.toArray().some((r) => r?.path === path && r?.requestedBy?.userId === user.userId);
      if (dup) return;
      doc.transact(() => {
        arr.push([
          { id: makeId(), path, requestedBy: { userId: user.userId, name: user.name }, createdAt: Date.now() },
        ]);
      }, SERVER_ORIGIN);
      return;
    }

    if (msg.type === "terminal-request") {
      const arr = doc.getArray<any>(Y_TERM_REQUESTS);
      if (arr.toArray().some((r) => r?.userId === user.userId)) return;
      doc.transact(() => {
        arr.push([{ id: makeId(), userId: user.userId, name: user.name, createdAt: Date.now() }]);
      }, SERVER_ORIGIN);
    }
  }

  /* ---------- protected-state guard ---------- */

  /**
   * Clients are trusted to edit files, but not room settings. After any
   * transaction from a non-host connection that touched a protected type,
   * restore every protected type from the last trusted snapshot.
   */
  private installGuard() {
    if (this.guardInstalled) return;
    this.guardInstalled = true;

    const doc = this.document;
    const topName = new Map<Y.AbstractType<any>, string>();
    const topNameOf = (type: Y.AbstractType<any>): string | undefined => {
      let t: Y.AbstractType<any> = type;
      while (t._item) t = t._item.parent as Y.AbstractType<any>;
      if (!topName.size || !topName.has(t)) {
        topName.clear();
        doc.share.forEach((v, k) => topName.set(v, k));
      }
      return topName.get(t);
    };

    this.takeSnapshot();

    doc.on("afterTransaction", (tr: Y.Transaction) => {
      const origin = tr.origin as Connection | string | null;
      const fromClient = origin && typeof origin === "object" && "id" in origin;

      let touched = false;
      tr.changedParentTypes.forEach((_events, type) => {
        const name = topNameOf(type);
        if (name && PROTECTED.has(name)) touched = true;
      });
      if (!touched) return;

      const user = fromClient ? this.userOf(origin as Connection) : null;
      if (!fromClient || (user && this.isHostUser(user.userId))) {
        this.takeSnapshot();
        return;
      }

      // Revert outside the current transaction's cleanup.
      queueMicrotask(() => this.restoreSnapshot());
    });
  }

  private takeSnapshot() {
    const doc = this.document;
    const snap: Snapshot = {};
    for (const k of HOST_ONLY_MAPS) snap[k] = doc.getMap(k).toJSON();
    for (const k of HOST_ONLY_ARRAYS) snap[k] = doc.getArray(k).toJSON();
    snap[Y_DOC_PERMS] = doc.getMap(Y_DOC_PERMS).toJSON();
    this.snapshot = snap;
  }

  private restoreSnapshot() {
    const doc = this.document;
    const snap = this.snapshot;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

    doc.transact(() => {
      for (const k of HOST_ONLY_MAPS) {
        const map = doc.getMap<unknown>(k);
        const want = (snap[k] ?? {}) as Record<string, unknown>;
        if (same(map.toJSON(), want)) continue;
        for (const key of Array.from(map.keys())) if (!(key in want)) map.delete(key);
        for (const [key, val] of Object.entries(want)) if (!same(map.get(key), val)) map.set(key, val);
      }

      for (const k of HOST_ONLY_ARRAYS) {
        const arr = doc.getArray<unknown>(k);
        const want = (snap[k] ?? []) as unknown[];
        if (same(arr.toJSON(), want)) continue;
        arr.delete(0, arr.length);
        arr.push(want);
      }

      const perms = doc.getMap<Y.Map<string>>(Y_DOC_PERMS);
      const wantPerms = (snap[Y_DOC_PERMS] ?? {}) as Record<string, Record<string, string>>;
      if (!same(perms.toJSON(), wantPerms)) {
        for (const key of Array.from(perms.keys())) perms.delete(key);
        for (const [path, acl] of Object.entries(wantPerms)) {
          const m = new Y.Map<string>();
          for (const [uid, lvl] of Object.entries(acl)) m.set(uid, lvl);
          perms.set(path, m);
        }
      }
    }, SERVER_ORIGIN);
  }
}
