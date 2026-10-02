import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";

import CodeEditor from "./components/CodeEditor";
import TerminalPanel from "./components/TerminalPanel";
import FileExplorer from "./components/FileExplorer";
import ChatPanel from "./components/ChatPanel";
import PeoplePanel from "./components/PeoplePanel";
import { CollabProvider, useCollab, type RoomInfo } from "./collab/CollabProvider";
import { getFilesMap, normalizePath } from "./collab/yFiles";

/* =========================
   API
========================= */

// Same origin by default: the Worker serves both the app and /api
// (vite dev proxies /api to wrangler dev). Override to use another Worker.
const API_BASE = (import.meta.env.VITE_API_BASE_URL?.toString() ?? "").replace(/\/+$/, "");

type User = { id: string; email: string; username?: string };

type ApiRoom = {
  id: string;
  name: string;
  join_code: string;
  max_users: number;
  created_by: string | null;
  created_at: string;
};

type AuthResponse = {
  access: string;
  refresh?: string;
  user?: User;
};

// Set by AuthProvider: signs the user out when the API rejects their token.
let onUnauthorized: (() => void) | null = null;

async function requestJson<T>(
  path: string,
  opts: RequestInit & { token?: string | null } = {}
): Promise<T> {
  const headers = new Headers(opts.headers);

  if (!headers.has("Content-Type") && !(opts.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);

  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers,
  });

  if (res.status === 401 && opts.token) onUnauthorized?.();

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.detail || data?.message || JSON.stringify(data);
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  // allow empty bodies
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const api = {
  login: (email: string, password: string) =>
    requestJson<AuthResponse>("/api/auth/login/", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string) =>
    requestJson<AuthResponse>("/api/auth/register/", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: (token: string) =>
    requestJson<User>("/api/auth/me/", {
      method: "GET",
      token,
    }),
  listRooms: (token: string) => requestJson<{ rooms: ApiRoom[] }>("/api/rooms/", { token }),
  createRoom: (token: string, name: string) =>
    requestJson<ApiRoom>("/api/rooms/", { method: "POST", token, body: JSON.stringify({ name }) }),
  joinRoom: (token: string, joinCode: string) =>
    requestJson<ApiRoom>("/api/rooms/join/", {
      method: "POST",
      token,
      body: JSON.stringify({ join_code: joinCode }),
    }),
  leaveRoom: (token: string, roomId: string) =>
    requestJson<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(roomId)}/leave/`, { method: "POST", token }),
  renameRoom: (token: string, roomId: string, name: string) =>
    requestJson<ApiRoom>(`/api/rooms/${encodeURIComponent(roomId)}/`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ name }),
    }),
  deleteRoom: (token: string, roomId: string) =>
    requestJson<{ ok: boolean }>(`/api/rooms/${encodeURIComponent(roomId)}/`, { method: "DELETE", token }),
};

/** Expiry time (ms) from a JWT's `exp` claim, or null if it can't be read. */
function tokenExpiry(token: string): number | null {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = JSON.parse(atob(part)).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function toRoomInfo(r: ApiRoom): RoomInfo {
  return { id: r.id, name: r.name, joinCode: r.join_code, maxUsers: r.max_users };
}

/* =========================
   Auth Context
========================= */

type AuthContextValue = {
  token: string | null;
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Why the user was signed out automatically (shown on the login page). */
  notice: string | null;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const TOKEN_KEY = "auth_access_token";

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY)
  );
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const expire = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setNotice("Your session has expired. Please sign in again.");
  }, []);

  // Any 401 from the API means the token is no longer valid.
  useEffect(() => {
    onUnauthorized = expire;
    return () => {
      onUnauthorized = null;
    };
  }, [expire]);

  // Sign out when the token expires, even if no request is made.
  useEffect(() => {
    if (!token) return;
    const exp = tokenExpiry(token);
    if (exp === null) return;
    const ms = exp - Date.now();
    if (ms <= 0) {
      expire();
      return;
    }
    // setTimeout overflows above ~24.8 days; tokens last 7.
    const t = setTimeout(expire, Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [token, expire]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setLoading(true);
      try {
        if (token) {
          const me = await api.me(token);
          if (!cancelled) setUser(me);
        } else {
          if (!cancelled) setUser(null);
        }
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        if (!cancelled) {
          setToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function login(email: string, password: string) {
    const res = await api.login(email.trim(), password);
    localStorage.setItem(TOKEN_KEY, res.access);
    setNotice(null);
    setToken(res.access);
    if (res.user) setUser(res.user);
  }

  async function register(email: string, password: string) {
    const res = await api.register(email.trim(), password);
    localStorage.setItem(TOKEN_KEY, res.access);
    setToken(res.access);
    if (res.user) setUser(res.user);
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }

  const value = useMemo<AuthContextValue>(
    () => ({ token, user, loading, login, register, logout, notice }),
    [token, user, loading, notice]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/* =========================
   Routing Helpers
========================= */

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div style={{ padding: 24 }}>Loading...</div>;

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

/* =========================
   UI bits
========================= */

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        padding: "10px 12px",
        border: "1px solid #d1d5db",
        borderRadius: 8,
        outline: "none",
        ...props.style,
      }}
    />
  );
}

function PrimaryButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children: React.ReactNode;
  }
) {
  const { children, ...rest } = props;
  return (
    <button
      {...rest}
      style={{
        padding: "10px 12px",
        border: "1px solid #d1d5db",
        borderRadius: 8,
        background: "#fff",
        cursor: rest.disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

/* =========================
   Pages
========================= */

function LoginPage() {
  const { login, notice } = useAuth();
  const nav = useNavigate();
  const location = useLocation() as any;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login(email, password);
      const dest = location?.state?.from ?? "/";
      nav(dest, { replace: true });
    } catch (ex: any) {
      setErr(ex?.message ?? "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 440,
        margin: "72px auto",
        padding: 24,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
      }}
    >
      <h1 style={{ margin: 0, marginBottom: 16 }}>Login</h1>

      {notice && !err && <div style={{ marginBottom: 12, color: "#92400e" }}>{notice}</div>}
      {err && <div style={{ marginBottom: 12, color: "#b91c1c" }}>{err}</div>}

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Email</span>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Password</span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        <PrimaryButton disabled={busy} type="submit">
          {busy ? "Signing in..." : "Sign in"}
        </PrimaryButton>
      </form>

      <div style={{ marginTop: 14 }}>
        No account? <Link to="/register">Create one</Link>
      </div>
    </div>
  );
}

function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);

    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    if (password !== password2) {
      setErr("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      await register(email, password);
      nav("/", { replace: true });
    } catch (ex: any) {
      setErr(ex?.message ?? "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 440,
        margin: "72px auto",
        padding: 24,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
      }}
    >
      <h1 style={{ margin: 0, marginBottom: 16 }}>Create account</h1>

      {err && <div style={{ marginBottom: 12, color: "#b91c1c" }}>{err}</div>}

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Email</span>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Password</span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Confirm password</span>
          <Input
            type="password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            autoComplete="new-password"
          />
        </label>

        <PrimaryButton disabled={busy} type="submit">
          {busy ? "Creating..." : "Create account"}
        </PrimaryButton>
      </form>

      <div style={{ marginTop: 14 }}>
        Already have an account? <Link to="/login">Login</Link>
      </div>
    </div>
  );
}

/* =========================
   Rooms
========================= */

const roomKey = (userId: string) => `collab_room:${userId}`;

function loadRoom(userId: string): RoomInfo | null {
  try {
    const raw = localStorage.getItem(roomKey(userId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.id ? (parsed as RoomInfo) : null;
  } catch {
    return null;
  }
}

function saveRoom(userId: string, room: RoomInfo | null) {
  try {
    if (room) localStorage.setItem(roomKey(userId), JSON.stringify(room));
    else localStorage.removeItem(roomKey(userId));
  } catch {
    // storage unavailable (private mode); the room just won't be remembered
  }
}

const smallBtn: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
};

const darkBtn: React.CSSProperties = {
  border: "1px solid #111827",
  borderRadius: 8,
  background: "#111827",
  color: "#fff",
  padding: "8px 12px",
  cursor: "pointer",
};

/** Lists your rooms and lets you create or join one. */
function RoomsPanel({
  currentRoomId,
  onSelect,
  onRemoved,
}: {
  currentRoomId?: string;
  onSelect: (room: RoomInfo) => void;
  /** Called after the user leaves or deletes a room. */
  onRemoved?: (roomId: string) => void;
}) {
  const { token, user } = useAuth();
  const [rooms, setRooms] = useState<ApiRoom[] | null>(null);
  const [roomName, setRoomName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.listRooms(token);
      setRooms(res.rooms);
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't load rooms.");
      setRooms([]);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(fn: () => Promise<ApiRoom>) {
    setErr(null);
    setBusy(true);
    try {
      onSelect(toRoomInfo(await fn()));
    } catch (e: any) {
      setErr(e?.message ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function leave(room: ApiRoom) {
    if (!token) return;
    if (!window.confirm(`Leave "${room.name}"? You can rejoin with its code (${room.join_code}).`)) return;
    try {
      await api.leaveRoom(token, room.id);
      onRemoved?.(room.id);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't leave room.");
    }
  }

  async function rename(room: ApiRoom) {
    if (!token) return;
    const next = window.prompt("New room name", room.name)?.trim();
    if (!next || next === room.name) return;
    if (next.length < 2) return setErr("Room name must be at least 2 characters.");
    setErr(null);
    try {
      await api.renameRoom(token, room.id, next);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't rename room.");
    }
  }

  async function remove(room: ApiRoom) {
    if (!token) return;
    const ok = window.confirm(
      `Delete "${room.name}" for everyone?\n\nAll of its files and chat will be permanently deleted. This can't be undone.`
    );
    if (!ok) return;
    setErr(null);
    try {
      await api.deleteRoom(token, room.id);
      onRemoved?.(room.id);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't delete room.");
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {err && <div style={{ color: "crimson", fontSize: 13 }}>{err}</div>}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = roomName.trim();
            if (name.length < 2) return setErr("Room name must be at least 2 characters.");
            void act(() => api.createRoom(token!, name));
          }}
          style={{ display: "grid", gap: 8 }}
        >
          <span style={{ fontWeight: 600 }}>Create a room</span>
          <Input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g. Team Alpha" />
          <button type="submit" disabled={busy} style={darkBtn}>
            Create
          </button>
        </form>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const code = joinCode.trim().toUpperCase();
            if (code.length < 4) return setErr("Enter a valid join code.");
            void act(() => api.joinRoom(token!, code));
          }}
          style={{ display: "grid", gap: 8 }}
        >
          <span style={{ fontWeight: 600 }}>Join with a code</span>
          <Input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="e.g. K7P9Q2XA"
            style={{ textTransform: "uppercase", letterSpacing: 2 }}
          />
          <button type="submit" disabled={busy} style={darkBtn}>
            Join
          </button>
        </form>
      </div>

      <div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Your rooms</div>
        {rooms === null ? (
          <div style={{ opacity: 0.7 }}>Loading…</div>
        ) : rooms.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No rooms yet. Create one or join with a code.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {rooms.map((r) => {
              const owned = !!user && r.created_by === String(user.id);
              return (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    background: r.id === currentRoomId ? "#f3f4f6" : "#fff",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.7, fontFamily: "ui-monospace, monospace" }}>
                      {r.join_code}
                      {owned && " · host"}
                    </div>
                  </div>
                  {r.id === currentRoomId ? (
                    <span style={{ fontSize: 12, opacity: 0.7 }}>current</span>
                  ) : (
                    <button onClick={() => onSelect(toRoomInfo(r))} style={smallBtn}>
                      Open
                    </button>
                  )}
                  {owned ? (
                    <>
                      <button onClick={() => void rename(r)} style={smallBtn} title="Rename room">
                        Rename
                      </button>
                      <button
                        onClick={() => void remove(r)}
                        style={{ ...smallBtn, color: "#b91c1c", borderColor: "#fca5a5" }}
                        title="Delete room for everyone"
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <button onClick={() => void leave(r)} style={smallBtn} title="Leave room">
                      Leave
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function RoomLobby({ onSelect }: { onSelect: (room: RoomInfo) => void }) {
  const { user, logout } = useAuth();
  return (
    <div style={{ maxWidth: 640, margin: "56px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 24, flex: 1 }}>Collaborative Code Editor</h1>
        <span style={{ fontSize: 12, opacity: 0.75 }}>{user?.email}</span>
        <button onClick={logout} style={smallBtn}>
          Logout
        </button>
      </div>
      <RoomsPanel onSelect={onSelect} />
    </div>
  );
}

function RoomDialog({
  open,
  onClose,
  currentRoomId,
  onSelect,
  onRemoved,
}: {
  open: boolean;
  onClose: () => void;
  currentRoomId: string;
  onSelect: (room: RoomInfo) => void;
  onRemoved: (roomId: string) => void;
}) {
  if (!open) return null;
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
          width: 560,
          maxWidth: "92vw",
          maxHeight: "86vh",
          overflow: "auto",
          background: "#fff",
          borderRadius: 12,
          padding: 16,
          border: "1px solid #e5e7eb",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, flex: 1 }}>Rooms</div>
          <button onClick={onClose} style={smallBtn}>
            ✕
          </button>
        </div>
        <RoomsPanel
          currentRoomId={currentRoomId}
          onSelect={(r) => {
            onSelect(r);
            onClose();
          }}
          onRemoved={(id) => {
            if (id === currentRoomId) onClose();
            onRemoved(id);
          }}
        />
      </div>
    </div>
  );
}

function RoomBar({ onOpenRoomDialog }: { onOpenRoomDialog: () => void }) {
  const { room, status, members, role } = useCollab();
  const dot = status === "connected" ? "#10b981" : status === "connecting" ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <button onClick={onOpenRoomDialog} style={smallBtn}>
        Rooms
      </button>
      <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: dot }} title={status} />
        <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{room.name}</b>
        <button
          onClick={() => void navigator.clipboard.writeText(room.joinCode).catch(() => {})}
          title="Copy join code"
          style={{ ...smallBtn, padding: "2px 6px", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
        >
          {room.joinCode}
        </button>
        <span style={{ opacity: 0.75 }}>
          {members.length}/{room.maxUsers} • {role}
        </span>
      </div>
    </div>
  );
}

/* =========================
   Main protected app UI
========================= */

function AppShell({
  onSelectRoom,
  onRoomRemoved,
}: {
  onSelectRoom: (room: RoomInfo) => void;
  onRoomRemoved: (roomId: string) => void;
}) {
  const { user, logout } = useAuth();
  const { doc, room, synced } = useCollab();

  const [showTerminal, setShowTerminal] = useState(true);
  const [sidePanel, setSidePanel] = useState<"chat" | "people" | null>("chat");
  const [activePath, setActivePath] = useState<string | undefined>();
  const [roomDialogOpen, setRoomDialogOpen] = useState(false);

  // Close the editor if the open file is deleted or renamed by someone else.
  useEffect(() => {
    const files = getFilesMap(doc);
    const check = () => {
      setActivePath((p) => (p && synced && !files.has(normalizePath(p)) ? undefined : p));
    };
    check();
    files.observe(check);
    return () => files.unobserve(check);
  }, [doc, synced]);

  const tabBtn = (key: "chat" | "people", label: string) => (
    <button
      onClick={() => setSidePanel((v) => (v === key ? null : key))}
      style={{ ...smallBtn, background: sidePanel === key ? "#f3f4f6" : "#fff" }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <div
        style={{
          minHeight: 44,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 12px",
          borderBottom: "1px solid #e5e7eb",
          flex: "0 0 auto",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: 600 }}>Collaborative Code Editor</div>

        <RoomBar onOpenRoomDialog={() => setRoomDialogOpen(true)} />

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{user?.email}</div>
          <button onClick={() => setShowTerminal((v) => !v)} style={smallBtn}>
            {showTerminal ? "Hide Output" : "Show Output"}
          </button>
          {tabBtn("chat", "Chat")}
          {tabBtn("people", "People")}
          <button onClick={logout} style={smallBtn}>
            Logout
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", minWidth: 0 }}>
        <aside
          style={{
            width: 300,
            minWidth: 220,
            borderRight: "1px solid #e5e7eb",
            overflow: "hidden",
          }}
        >
          <FileExplorer activePath={activePath} onOpenFile={(path) => setActivePath(path)} />
        </aside>

        <main style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0, display: "flex" }}>
          <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ flex: "1 1 auto", minHeight: 0 }}>
              {synced ? (
                <CodeEditor filePath={activePath ?? null} />
              ) : (
                <div style={{ padding: 18, opacity: 0.7 }}>Loading room…</div>
              )}
            </div>

            {showTerminal && (
              <div style={{ height: 240, borderTop: "1px solid #e5e7eb" }}>
                <TerminalPanel activePath={activePath} />
              </div>
            )}
          </div>

          {sidePanel && (
            <div
              style={{
                width: 300,
                borderLeft: "1px solid #e5e7eb",
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
              {sidePanel === "chat" ? <ChatPanel /> : <PeoplePanel />}
            </div>
          )}
        </main>
      </div>

      <RoomDialog
        open={roomDialogOpen}
        onClose={() => setRoomDialogOpen(false)}
        currentRoomId={room.id}
        onSelect={onSelectRoom}
        onRemoved={onRoomRemoved}
      />
    </div>
  );
}

/* =========================
   App (Router + Provider + CollabProvider)
========================= */

function CollabWrapper() {
  const { user, token } = useAuth();
  const userId = user ? String(user.id) : "";
  const [room, setRoom] = useState<RoomInfo | null>(() => (userId ? loadRoom(userId) : null));

  const selectRoom = useCallback(
    (next: RoomInfo | null) => {
      saveRoom(userId, next);
      setRoom(next);
    },
    [userId]
  );

  // Leaving or deleting the open room drops you back to the lobby.
  const roomRemoved = useCallback(
    (roomId: string) => {
      if (room?.id === roomId) selectRoom(null);
    },
    [room, selectRoom]
  );

  const checkAccess = useCallback(async () => {
    if (!token || !room) return true;
    const res = await api.listRooms(token);
    return res.rooms.some((r) => r.id === room.id);
  }, [token, room]);

  if (!user || !token) return <div style={{ padding: 24 }}>Loading...</div>;
  if (!room) return <RoomLobby onSelect={selectRoom} />;

  return (
    <CollabProvider
      key={room.id}
      room={room}
      token={token}
      userId={userId}
      displayName={user.username ?? user.email.split("@")[0]}
      onLeave={() => selectRoom(null)}
      checkAccess={checkAccess}
    >
      <AppShell onSelectRoom={selectRoom} onRoomRemoved={roomRemoved} />
    </CollabProvider>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <CollabWrapper />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </HashRouter>
  );
}
