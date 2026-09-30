import { SignJWT, jwtVerify } from "jose";

// Workers' WebCrypto caps PBKDF2 at 100k iterations.
const PBKDF2_ITERATIONS = 100_000;
const TOKEN_TTL = "7d";

export type TokenClaims = { sub: string; email: string };

function toB64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Format: pbkdf2_sha256$<iterations>$<salt b64>$<hash b64> */
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algo, iters, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2_sha256" || !iters || !saltB64 || !hashB64) return false;
  const iterations = Number(iters);
  if (!Number.isInteger(iterations) || iterations > PBKDF2_ITERATIONS) return false;
  const actual = await pbkdf2(password, fromB64(saltB64), iterations);
  return timingSafeEqual(actual, fromB64(hashB64));
}

function secretKey(secret: string) {
  return new TextEncoder().encode(secret);
}

export async function signToken(claims: TokenClaims, secret: string) {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey(secret));
}

export async function verifyToken(token: string, secret: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
