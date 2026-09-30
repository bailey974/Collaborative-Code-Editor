import { Hono, type Context } from "hono";
import { routePartykitRequest } from "partyserver";
import { hashPassword, signToken, verifyPassword, verifyToken, type TokenClaims } from "./auth";

export { Room } from "./room";

export interface Env {
  DB: D1Database;
  Room: DurableObjectNamespace;
  JWT_SECRET: string;
}

type Vars = { user: TokenClaims };
type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

type UserRow = { id: string; email: string; password_hash: string };
type RoomRow = {
  id: string;
  name: string;
  join_code: string;
  created_by: string | null;
  created_at: number;
  max_users: number;
};

const JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const JOIN_LEN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 20;

function generateJoinCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(JOIN_LEN));
  return Array.from(bytes, (b) => JOIN_ALPHABET[b % JOIN_ALPHABET.length]).join("");
}

function publicUser(u: { id: string; email: string }) {
  return { id: u.id, email: u.email, username: u.email.split("@")[0] };
}

function roomPayload(r: RoomRow) {
  return {
    id: r.id,
    name: r.name,
    join_code: r.join_code,
    created_by: r.created_by,
    created_at: new Date(r.created_at).toISOString(),
    max_users: r.max_users,
    doc_name: r.id,
  };
}

function bearer(c: AppContext) {
  const h = c.req.header("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Returns true if the caller is over the limit for this bucket. */
async function rateLimited(db: D1Database, bucket: string) {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
       RETURNING count`
    )
    .bind(bucket, now, now - RATE_WINDOW_MS)
    .first<{ count: number }>();
  return (row?.count ?? 0) > RATE_MAX;
}

const app = new Hono<{ Bindings: Env; Variables: Vars }>({ strict: false });

app.onError((err, c) => {
  console.error(err);
  return c.json({ detail: "Internal server error" }, 500);
});

app.get("/api/healthz", (c) => c.json({ ok: true }));

/* ---------- auth ---------- */

async function readCredentials(c: AppContext) {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as any);
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  return { email, password };
}

async function issue(c: AppContext, user: { id: string; email: string }) {
  const access = await signToken({ sub: user.id, email: user.email }, c.env.JWT_SECRET);
  return c.json({ access, user: publicUser(user) });
}

app.post("/api/auth/register", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (await rateLimited(c.env.DB, `auth:${ip}`)) {
    return c.json({ message: "Too many attempts. Try again in a few minutes." }, 429);
  }

  const { email, password } = await readCredentials(c);
  if (!email || !password) return c.json({ message: "Email and password required." }, 400);
  if (!EMAIL_RE.test(email)) return c.json({ message: "Enter a valid email address." }, 400);
  if (password.length < 8) return c.json({ message: "Password must be at least 8 characters." }, 400);

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return c.json({ message: "An account with that email already exists." }, 400);

  const user = { id: crypto.randomUUID(), email };
  await c.env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, email, await hashPassword(password), Date.now())
    .run();

  return issue(c, user);
});

app.post("/api/auth/login", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (await rateLimited(c.env.DB, `auth:${ip}`)) {
    return c.json({ message: "Too many attempts. Try again in a few minutes." }, 429);
  }

  const { email, password } = await readCredentials(c);
  const user = await c.env.DB.prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ message: "Invalid email or password." }, 401);
  }
  return issue(c, user);
});

/* ---------- authenticated routes ---------- */

app.use("/api/auth/me", requireAuth);
app.use("/api/rooms/*", requireAuth);
app.use("/api/rooms", requireAuth);

async function requireAuth(c: AppContext, next: () => Promise<void>) {
  const token = bearer(c);
  const claims = token ? await verifyToken(token, c.env.JWT_SECRET) : null;
  if (!claims) return c.json({ detail: "Not authenticated." }, 401);
  c.set("user", claims);
  await next();
}

app.get("/api/auth/me", (c) => {
  const u = c.get("user");
  return c.json(publicUser({ id: u.sub, email: u.email }));
});

app.get("/api/rooms", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.* FROM rooms r
     JOIN room_members m ON m.room_id = r.id
     WHERE m.user_id = ?
     ORDER BY r.created_at DESC`
  )
    .bind(c.get("user").sub)
    .all<RoomRow>();
  return c.json({ rooms: results.map(roomPayload) });
});

app.post("/api/rooms", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as any);
  const name = String(body.name ?? "").trim().slice(0, 80);
  if (name.length < 2) return c.json({ message: "Room name must be at least 2 characters." }, 400);

  const userId = c.get("user").sub;
  const now = Date.now();

  for (let attempt = 0; attempt < 5; attempt++) {
    const room: RoomRow = {
      id: crypto.randomUUID(),
      name,
      join_code: generateJoinCode(),
      created_by: userId,
      created_at: now,
      max_users: 10,
    };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO rooms (id, name, join_code, created_by, created_at, max_users) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(room.id, room.name, room.join_code, room.created_by, room.created_at, room.max_users),
        c.env.DB.prepare("INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)").bind(
          room.id,
          userId,
          now
        ),
      ]);
      return c.json(roomPayload(room), 201);
    } catch (e) {
      // join_code collision: retry with a new code
      if (!String(e).includes("UNIQUE")) throw e;
    }
  }
  return c.json({ message: "Could not create room, try again." }, 500);
});

app.post("/api/rooms/join", async (c) => {
  const body = await c.req.json<{ join_code?: string }>().catch(() => ({}) as any);
  const code = String(body.join_code ?? "").trim().toUpperCase();
  if (!code) return c.json({ detail: "invalid-code" }, 400);

  const room = await c.env.DB.prepare("SELECT * FROM rooms WHERE join_code = ?").bind(code).first<RoomRow>();
  if (!room) return c.json({ detail: "No room with that join code." }, 404);

  await c.env.DB.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)")
    .bind(room.id, c.get("user").sub, Date.now())
    .run();

  return c.json(roomPayload(room));
});

app.post("/api/rooms/:id/leave", async (c) => {
  await c.env.DB.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("user").sub)
    .run();
  return c.json({ ok: true });
});

app.all("/api/*", (c) => c.json({ detail: "Not found." }, 404));

/* ---------- collaboration websockets ---------- */

/**
 * /parties/room/<roomId>?token=<jwt>
 * Verifies the token and room membership, then forwards trusted identity
 * headers to the Room Durable Object.
 */
async function authorizeSocket(request: Request, env: Env, roomId: string) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const claims = token ? await verifyToken(token, env.JWT_SECRET) : null;
  if (!claims) return new Response("Unauthorized", { status: 401 });

  const room = await env.DB.prepare(
    `SELECT r.created_by, r.max_users FROM rooms r
     JOIN room_members m ON m.room_id = r.id
     WHERE r.id = ? AND m.user_id = ?`
  )
    .bind(roomId, claims.sub)
    .first<{ created_by: string | null; max_users: number }>();
  if (!room) return new Response("Not a member of this room", { status: 403 });

  // Rebuild headers so clients can't smuggle their own x-collab-* values.
  const headers = new Headers();
  request.headers.forEach((v, k) => {
    if (!k.toLowerCase().startsWith("x-collab-")) headers.set(k, v);
  });
  headers.set("x-collab-user-id", claims.sub);
  headers.set("x-collab-user-name", claims.email.split("@")[0]);
  headers.set("x-collab-host-id", room.created_by ?? "");
  headers.set("x-collab-max-users", String(room.max_users));
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/parties/")) {
      const res = await routePartykitRequest(request, env as unknown as Record<string, unknown>, {
        onBeforeConnect: (req, { party, name }) =>
          party === "room" ? authorizeSocket(req, env, name) : new Response("Not found", { status: 404 }),
        onBeforeRequest: () => new Response("Not found", { status: 404 }),
      });
      return res ?? new Response("Not found", { status: 404 });
    }

    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
