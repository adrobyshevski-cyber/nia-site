/**
 * /demo — экспресс-аудит по адресу сайта: запуск, статус, выдача контактов.
 *
 * Лимиты (по договорённости):
 *   устройство — 1 аудит, cookie на год
 *   IP         — 8 запусков в час (на ивенте весь зал сидит за одним NAT)
 *   email      — 1 отчёт на адрес, 30 дней
 *
 * Состояние живёт в KV (binding AUDIT_KV). Сервис расчёта — lib/audit-engine.js.
 */

import { engineName, getAuditState, startAudit } from "./audit-engine.js";
import { notifyTelegram } from "./lead.js";

const JOB_TTL_S = 60 * 60 * 6; // 6 часов: дольше аудит не нужен
const DEVICE_COOKIE = "nia_audit_dev";
const DEVICE_TTL_S = 60 * 60 * 24 * 365;
const IP_WINDOW_S = 60 * 60;
const IP_LIMIT = 8;
const EMAIL_TTL_S = 60 * 60 * 24 * 30;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const now = () => Date.now();

const randomId = (bytes = 12) => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
};

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const readCookie = (request, name) => {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
};

const siteUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (!url.hostname.includes(".") || url.hostname.length < 4) return null;
  if (url.username || url.password) return null;
  return url;
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Телефон: допускаем +7/8, пробелы, скобки, дефисы. Нужно 10–15 цифр. */
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return `+7${digits.slice(1)}`;
  if (digits.length === 10) return `+7${digits}`;
  return `+${digits}`;
};

/**
 * Учёт попыток: читаем-пишем в KV. KV не атомарен, поэтому при гоночных запросах
 * счётчик может недосчитать — для демо-страницы это приемлемо.
 */
async function bumpIp(env, ip) {
  const bucket = `${Math.floor(now() / (IP_WINDOW_S * 1000))}`;
  const key = `ip:${await sha256(`${ip}|${bucket}|${env.SESSION_SECRET || ""}`)}`;
  const current = Number((await env.AUDIT_KV.get(key)) || 0);
  if (current >= IP_LIMIT) return { allowed: false, used: current };
  await env.AUDIT_KV.put(key, String(current + 1), { expirationTtl: IP_WINDOW_S + 60 });
  return { allowed: true, used: current + 1 };
}

async function readJob(env, id) {
  if (!/^[a-f0-9]{16,64}$/.test(String(id))) return null;
  const raw = await env.AUDIT_KV.get(`job:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJob(env, id, job) {
  await env.AUDIT_KV.put(`job:${id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_S });
}

const publicJob = (job) => ({
  id: job.id,
  url: job.url,
  status: job.status,
  elapsed: Math.round((now() - job.createdAt) / 1000),
  reportUrl: job.status === "done" ? job.reportUrl || null : null,
  stub: engineName({ AUDIT_ENGINE: job.engine }) === "stub",
});

async function start(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const origin = request.headers.get("origin");
  if (origin) {
    const ok = ["narrativeintelligence.ru", "www.narrativeintelligence.ru", new URL(request.url).host].includes(
      new URL(origin).host,
    );
    if (!ok) return json({ ok: false, error: "Запрос с чужого origin." }, 403);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Некорректный запрос." }, 400);
  }

  const url = siteUrl(payload.url);
  if (!url) return json({ ok: false, error: "Введите корректный публичный адрес сайта, например example.com" }, 400);

  const device = readCookie(request, DEVICE_COOKIE);
  if (device) {
    const used = await env.AUDIT_KV.get(`dev:${device}`);
    if (used) {
      return json(
        {
          ok: false,
          error: "С этого устройства аудит уже запускали. Напишите нам — пришлём отчёт вручную.",
          code: "device_used",
        },
        429,
      );
    }
  }

  const ipLimit = await bumpIp(env, ip);
  if (!ipLimit.allowed) {
    return json(
      { ok: false, error: "Слишком много запусков с этой сети. Попробуйте через час.", code: "ip_limit" },
      429,
    );
  }

  const id = randomId(12);
  const job = {
    id,
    url: url.toString(),
    host: url.hostname.replace(/^www\./, ""),
    status: "queued",
    createdAt: now(),
    ipHash: await sha256(`${ip}|${env.SESSION_SECRET || ""}`),
    device: device || randomId(8),
    engine: engineName(env) === "http" ? "live" : "stub",
    // метка события из QR (?ev=...): нужна для статистики по ивентам
    ev: String(payload.ev || "").slice(0, 40),
  };

  try {
    const started = await startAudit(env, { url: job.url, jobId: id });
    job.externalId = started.externalId;
    job.status = started.status === "queued" ? "queued" : "running";
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 502);
  }

  await writeJob(env, id, job);
  await env.AUDIT_KV.put(`dev:${job.device}`, "1", { expirationTtl: DEVICE_TTL_S });

  const headers = {};
  if (!device) {
    headers["set-cookie"] =
      `${DEVICE_COOKIE}=${job.device}; Path=/; Max-Age=${DEVICE_TTL_S}; HttpOnly; Secure; SameSite=Lax`;
  }

  return json({ ok: true, job: publicJob(job) }, 200, headers);
}

async function status(request, env) {
  const id = new URL(request.url).searchParams.get("id") || "";
  const job = await readJob(env, id);
  if (!job) return json({ ok: false, error: "Задача не найдена. Запустите аудит заново." }, 404);

  if (job.status !== "done" && job.status !== "failed") {
    try {
      const state = await getAuditState(env, job);
      if (state.status !== job.status || state.reportUrl) {
        job.status = state.status;
        if (state.reportUrl) job.reportUrl = state.reportUrl;
        if (state.error) job.error = state.error;
        if (state.status === "done") job.finishedAt = now();
        await writeJob(env, job.id, job);
      }
    } catch (error) {
      job.status = "failed";
      job.error = String(error.message || error);
      await writeJob(env, job.id, job);
    }
  }

  return json({ ok: true, job: publicJob(job) });
}

async function reveal(request, env) {
  const origin = request.headers.get("origin");
  if (origin) {
    const ok = ["narrativeintelligence.ru", "www.narrativeintelligence.ru", new URL(request.url).host].includes(
      new URL(origin).host,
    );
    if (!ok) return json({ ok: false, error: "Запрос с чужого origin." }, 403);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Некорректный запрос." }, 400);
  }

  const job = await readJob(env, String(payload.id || ""));
  if (!job) return json({ ok: false, error: "Задача не найдена. Запустите аудит заново." }, 404);
  if (job.status !== "done") return json({ ok: false, error: "Аудит ещё не готов." }, 409);
  if (job.contacted) return json({ ok: false, error: "Контакты по этой заявке уже получены." }, 409);

  const name = String(payload.name || "").trim();
  const email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.phone);
  const consent = payload.consent === true;

  if (name.length < 2 || name.length > 80) return json({ ok: false, error: "Укажите имя." }, 400);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "Проверьте адрес электронной почты." }, 400);
  if (!phone) return json({ ok: false, error: "Укажите телефон в формате +7 999 123-45-67." }, 400);
  if (!consent) return json({ ok: false, error: "Нужно согласие на обработку персональных данных." }, 400);

  const emailKey = `email:${await sha256(`${email}|${env.SESSION_SECRET || ""}`)}`;
  if (await env.AUDIT_KV.get(emailKey)) {
    return json({ ok: false, error: "Для этого адреса отчёт уже запрашивали.", code: "email_used" }, 429);
  }

  job.contacted = { name, email, phone, at: now() };
  job.status = "done";
  await writeJob(env, job.id, job);
  await env.AUDIT_KV.put(emailKey, "1", { expirationTtl: EMAIL_TTL_S });

  const lines = [
    "<b>🎯 Экспресс-аудит /demo</b>",
    `<b>Сайт:</b> ${job.url}`,
    `<b>Имя:</b> ${name}`,
    `<b>Email:</b> ${email}`,
    `<b>Телефон:</b> ${phone}`,
    job.reportUrl ? `<b>Отчёт:</b> ${job.reportUrl}` : "<b>Отчёт:</b> демо-режим, не формировался",
    `<i>Согласие на обработку ПД: да, ${new Date().toISOString()}</i>`,
  ].join("\n");

  try {
    await notifyTelegram(env, lines);
  } catch (error) {
    // контакты уже сохранены в задаче — не теряем лид из-за Telegram
    console.error("audit reveal notify failed", String(error.message || error));
  }

  return json({ ok: true, reportUrl: job.reportUrl || null });
}

export async function handleAudit(request, env, path) {
  if (!env.AUDIT_KV) return json({ ok: false, error: "Хранилище не настроено." }, 500);

  if (path === "/api/audit/start" && request.method === "POST") return start(request, env);
  if (path === "/api/audit/status" && request.method === "GET") return status(request, env);
  if (path === "/api/audit/reveal" && request.method === "POST") return reveal(request, env);
  if (path.startsWith("/api/audit/")) return json({ ok: false, error: "Неизвестный метод API." }, 404);
  return json({ ok: false, error: "Метод не поддерживается." }, 405);
}

export const auditInternals = { siteUrl, normalizePhone, normalizeEmail, publicJob };
