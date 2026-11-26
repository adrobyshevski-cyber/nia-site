/**
 * Аутентификация /studio: пароль из секрета, сессия в подписанной cookie.
 *
 * Хеш — sha256(salt ‖ пароль), а не PBKDF2: на бесплатном плане Workers лимит
 * 10 мс CPU на запрос, а PBKDF2 со 100k+ итераций вылетает по CPU. Пароль
 * случайный (~99 бит), поэтому перебор нереален и с быстрым хешем.
 */

const COOKIE_NAME = "nia_studio";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

const attempts = new Map(); // ip → { count, resetAt }

const encoder = new TextEncoder();

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64Url = (text) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Проверяет пароль против строки "sha256$<salt_b64>$<hash_b64>". */
export async function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [algorithm, saltB64, hashB64] = stored.split("$");
  if (algorithm !== "sha256" || !saltB64 || !hashB64) return false;

  const saltBytes = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const expected = atob(hashB64);
  const passwordBytes = encoder.encode(password);

  const input = new Uint8Array(saltBytes.length + passwordBytes.length);
  input.set(saltBytes, 0);
  input.set(passwordBytes, saltBytes.length);

  const actual = toBase64Url(await sha256(input));
  const wanted = toBase64Url(Uint8Array.from(expected, (c) => c.charCodeAt(0)));
  return constantTimeEqual(actual, wanted);
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** Токен вида "<expires>.<подпись>". */
export async function createSessionToken(env, now = Date.now()) {
  const expires = now + SESSION_TTL_MS;
  const signature = toBase64Url(await hmac(env.SESSION_SECRET, String(expires)));
  return `${expires}.${signature}`;
}

export async function isValidSessionToken(env, token, now = Date.now()) {
  if (!token || !env.SESSION_SECRET) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature) return false;
  if (!/^\d+$/.test(expires) || Number(expires) < now) return false;
  const expected = toBase64Url(await hmac(env.SESSION_SECRET, expires));
  return constantTimeEqual(expected, signature);
}

export function readToken(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return "";
}

export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function isAuthenticated(request, env) {
  return isValidSessionToken(env, readToken(request));
}

/** Простое ограничение попыток входа: 8 попыток за 15 минут на IP. */
export function checkRateLimit(ip, now = Date.now()) {
  if (!ip) return { allowed: true, retryAfter: 0 };
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) return { allowed: true, retryAfter: 0 };
  if (entry.count < MAX_ATTEMPTS) return { allowed: true, retryAfter: 0 };
  return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
}

export function registerFailure(ip, now = Date.now()) {
  if (!ip) return;
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
  if (attempts.size > 500) {
    for (const [key, value] of attempts) if (value.resetAt < now) attempts.delete(key);
  }
}

export function resetFailures(ip) {
  if (ip) attempts.delete(ip);
}

/** POST должен приходить со своего же origin — простая защита от CSRF. */
export function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // не браузерный запрос (curl, тесты)
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
