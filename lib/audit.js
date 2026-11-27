/**
 * /demo — экспресс-аудит по адресу сайта: запуск, статус, выдача контактов, отчёт.
 *
 * Лимиты:
 *   устройство — 1 аудит, cookie на год
 *   IP         — 8 запусков в час (на ивенте весь зал сидит за одним NAT)
 *   email      — 1 отчёт на адрес, 30 дней
 *   событие    — 20 аудитов на метку ?ev=..., дальше заявка принимается вручную
 *
 * Состояние живёт в KV (binding AUDIT_KV), расчёт — lib/audit-engine.js.
 */

import {
  engineName,
  fetchReportHtml,
  fetchReportPdf,
  getAuditState,
  publishAudit,
  startAudit,
} from "./audit-engine.js";
import { notifyTelegram, notifyTelegramDocument } from "./lead.js";
import { recordLead } from "./crm.js";

const JOB_TTL_S = 60 * 60 * 6; // 6 часов: дольше задача не нужна
const REPORT_TTL_S = 60 * 60 * 24 * 30; // 30 дней — ссылка для клиента (короткий отчёт)
const ARCHIVE_TTL_S = 60 * 60 * 24 * 180; // 180 дней — архив полного отчёта для оператора
const DEVICE_COOKIE = "nia_audit_dev";
const DEVICE_TTL_S = 60 * 60 * 24 * 365;
const IP_WINDOW_S = 60 * 60;
// Без метки события — 8 в час на IP (защита от ботов). С меткой ?ev= — 30:
// на офлайн-ивенте все гости сидят за одним NAT и делят один публичный адрес.
const IP_LIMIT = 8;
const IP_LIMIT_EVENT = 30;
const EMAIL_TTL_S = 60 * 60 * 24 * 30;
const EV_QUOTA = 20;
const EV_TTL_S = 60 * 60 * 24 * 7;

const ACTIVE = new Set(["queued", "running", "review"]);

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const now = () => Date.now();
const NL = String.fromCharCode(10); // перевод строки без escape-последовательностей

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

/** Телефон: +7/8, пробелы, скобки, дефисы. Нужно 10–15 цифр. */
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return `+7${digits.slice(1)}`;
  if (digits.length === 10) return `+7${digits}`;
  return `+${digits}`;
};

const sameOrigin = (request) => {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === new URL(request.url).host || host === request.headers.get("host") ||
      ["narrativeintelligence.ru", "www.narrativeintelligence.ru"].includes(host);
  } catch {
    return false;
  }
};

async function bumpIp(env, ip, { event = false } = {}) {
  const limit = event ? IP_LIMIT_EVENT : IP_LIMIT;
  const bucket = `${Math.floor(now() / (IP_WINDOW_S * 1000))}`;
  const key = `ip:${await sha256(`${ip}|${bucket}|${env.SESSION_SECRET || ""}`)}`;
  const current = Number((await env.AUDIT_KV.get(key)) || 0);
  if (current >= limit) return { allowed: false, limit };
  await env.AUDIT_KV.put(key, String(current + 1), { expirationTtl: IP_WINDOW_S + 60 });
  return { allowed: true, limit };
}

async function takeEventSlot(env, label) {
  const key = `ev:${label || "default"}`;
  const used = Number((await env.AUDIT_KV.get(key)) || 0);
  if (used >= EV_QUOTA) return false;
  await env.AUDIT_KV.put(key, String(used + 1), { expirationTtl: EV_TTL_S });
  return true;
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

/** Наружу отдаём только то, что не жалко: ссылка на отчёт выдаётся лишь после контактов. */
const publicJob = (job) => ({
  id: job.id,
  url: job.url,
  status: job.status,
  elapsed: Math.round((now() - job.createdAt) / 1000),
  stub: job.stub === true,
  reportUrl: null,
});

/** Забирает готовый отчёт и кладёт в KV под коротким токеном. */
async function ensureReport(env, job) {
  if (job.reportToken) return job;

  // В демо-режиме отчёта нет: ссылку не выдаём, UI честно пишет, что это стенд
  if (job.stub) return job;

  const briefHtml = await fetchReportHtml(env, job, { brief: true });
  const reportToken = randomId(16);
  const rewrite = (html) => html.replaceAll(`/audit/${job.externalId}/`, `/r/${reportToken}/`);

  await env.AUDIT_KV.put(
    `report:${reportToken}`,
    JSON.stringify({ html: rewrite(briefHtml), url: job.url, createdAt: now(), externalId: job.externalId }),
    { expirationTtl: REPORT_TTL_S },
  );

  // Полный отчёт кладём в архив: его можно выслать клиенту после личной встречи,
  // даже если сервис уже недоступен или скан почищен по retention.
  try {
    const fullHtml = await fetchReportHtml(env, job, { brief: false });
    if (fullHtml) {
      await env.AUDIT_KV.put(
        `report-full:${reportToken}`,
        JSON.stringify({ html: rewrite(fullHtml), url: job.url, createdAt: now(), externalId: job.externalId }),
        { expirationTtl: ARCHIVE_TTL_S },
      );
    }
  } catch (error) {
    console.error("full report archive failed", String(error.message || error));
  }

  job.reportToken = reportToken;
  return job;
}

async function start(request, env) {
  if (!sameOrigin(request)) return json({ ok: false, error: "Запрос с чужого origin." }, 403);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Некорректный запрос." }, 400);
  }

  const url = siteUrl(payload.url);
  if (!url) return json({ ok: false, error: "Введите корректный публичный адрес сайта, например example.com" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ev = String(payload.ev || "").slice(0, 40);
  const device = readCookie(request, DEVICE_COOKIE);
  if (device && (await env.AUDIT_KV.get(`dev:${device}`))) {
    return json(
      {
        ok: false,
        error: "С этого устройства аудит уже запускали. Напишите нам — пришлём отчёт вручную.",
        code: "device_used",
      },
      429,
    );
  }

  if (!(await bumpIp(env, ip, { event: Boolean(ev) })).allowed) {
    return json(
      { ok: false, error: "Слишком много запусков с этой сети. Попробуйте через час.", code: "ip_limit" },
      429,
    );
  }

  const id = randomId(12);
  const base = {
    id,
    url: url.toString(),
    host: url.hostname.replace(/^www\./, ""),
    createdAt: now(),
    ipHash: await sha256(`${ip}|${env.SESSION_SECRET || ""}`),
    device: device || randomId(8),
    ev,
    stub: engineName(env) === "stub",
  };

  // Квота события: аудиты кончились — принимаем заявку вручную, без запуска движка
  if (!(await takeEventSlot(env, ev))) {
    const job = { ...base, status: "manual", engine: "quota" };
    await writeJob(env, id, job);
    await env.AUDIT_KV.put(`dev:${job.device}`, "1", { expirationTtl: DEVICE_TTL_S });
    return json({ ok: true, job: publicJob(job) }, 200, cookieHeaders(device, job.device));
  }

  try {
    const started = await startAudit(env, { url: base.url, ip, jobId: id });
    const job = { ...base, status: started.status, engine: engineName(env), externalId: started.externalId };
    await writeJob(env, id, job);
    await env.AUDIT_KV.put(`dev:${job.device}`, "1", { expirationTtl: DEVICE_TTL_S });
    return json({ ok: true, job: publicJob(job) }, 200, cookieHeaders(device, job.device));
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 502);
  }
}

function cookieHeaders(device, value) {
  if (device) return {};
  return {
    "set-cookie": `${DEVICE_COOKIE}=${value}; Path=/; Max-Age=${DEVICE_TTL_S}; HttpOnly; Secure; SameSite=Lax`,
  };
}

/** Авто-публикация отчётов: включается переменной AUDIT_AUTO_PUBLISH=1. */
const autoPublishEnabled = (env, job) =>
  String(env.AUDIT_AUTO_PUBLISH || "") === "1" && !job.stub && Boolean(job.externalId);

async function status(request, env) {
  const id = new URL(request.url).searchParams.get("id") || "";
  const job = await readJob(env, id);
  if (!job) return json({ ok: false, error: "Задача не найдена. Запустите аудит заново." }, 404);

  if (ACTIVE.has(job.status)) {
    try {
      const state = await getAuditState(env, job);
      let next = state.status;

      // авто-публикация: если владелец включил AUDIT_AUTO_PUBLISH, не ждём
      // ручного Stage Gate. Сервис всё равно проверяет, что скан succeeded.
      if (next === "review" && autoPublishEnabled(env, job)) {
        try {
          const published = await publishAudit(env, job);
          if (published === "done") {
            next = "done";
            job.autoPublishedAt = now();
          }
        } catch (error) {
          // гейт не пройден — остаётся review, ручное подтверждение работает как раньше
          job.autoPublishError = String(error.message || error).slice(0, 300);
        }
      }

      if (next !== job.status) {
        job.status = next;
        if (state.error) job.error = state.error;
        if (next === "done") {
          job.finishedAt = now();
          await ensureReport(env, job);
        }
        await writeJob(env, job.id, job);
      } else if (job.autoPublishError) {
        await writeJob(env, job.id, job);
      }
    } catch (error) {
      job.error = String(error.message || error);
      // мягкий сбой движка не должен убивать заявку: пробуем на следующем опросе
      if (!job.softErrors) job.softErrors = 0;
      job.softErrors += 1;
      if (job.softErrors >= 5) {
        job.status = "failed";
        job.error = "Сервис аудита недоступен";
      }
      await writeJob(env, job.id, job);
    }
  }

  return json({ ok: true, job: publicJob(job) });
}

async function reveal(request, env) {
  if (!sameOrigin(request)) return json({ ok: false, error: "Запрос с чужого origin." }, 403);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Некорректный запрос." }, 400);
  }

  const job = await readJob(env, String(payload.id || ""));
  if (!job) return json({ ok: false, error: "Задача не найдена. Запустите аудит заново." }, 404);
  if (!["done", "review", "manual"].includes(job.status)) {
    return json({ ok: false, error: "Аудит ещё не готов." }, 409);
  }
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
  await writeJob(env, job.id, job);
  await env.AUDIT_KV.put(emailKey, "1", { expirationTtl: EMAIL_TTL_S });

  // CRM: контакты попадают в D1 сразу, а не живут только в job:<id> с TTL 6 часов.
  // report_token — ключ дедупликации: повторная форма по тому же отчёту обновит лид.
  await recordLead(env, {
    source: "demo",
    name,
    email,
    phone,
    site: job.url,
    event: job.ev || null,
    reportToken: job.reportToken || null,
    consentAt: job.contacted.at,
  });

  const reportUrl = job.reportToken ? `/r/${job.reportToken}/` : null;
  const reason = job.status === "manual" ? "квота события исчерпана" : job.status === "review" ? "отчёт на проверке" : "отчёт готов";

  const lines = [
    "<b>🎯 Экспресс-аудит /demo</b>",
    `<b>Сайт:</b> ${job.url}`,
    `<b>Имя:</b> ${name}`,
    `<b>Email:</b> ${email}`,
    `<b>Телефон:</b> ${phone}`,
    `<b>Событие:</b> ${job.ev || "—"}`,
    `<b>Статус:</b> ${reason}`,
    reportUrl ? `<b>Отчёт:</b> https://narrativeintelligence.ru${reportUrl}` : "<b>Отчёт:</b> ссылки нет",
    `<i>Согласие на обработку ПД: да, ${new Date().toISOString()}</i>`,
  ].join("\n");

  try {
    await notifyTelegram(env, lines);
  } catch (error) {
    console.error("audit reveal notify failed", String(error.message || error));
  }

  // Файл в чат: ссылка может не открыться из-за фильтрации домена у клиента,
  // а HTML-файл приходит целиком и не зависит от доступности сайта.
  if (job.reportToken && !job.stub) {
    try {
      const raw =
        (await env.AUDIT_KV.get(`report-full:${job.reportToken}`)) ||
        (await env.AUDIT_KV.get(`report:${job.reportToken}`));
      const stored = raw ? JSON.parse(raw) : null;
      if (stored?.html) {
        const host = (job.host || "site").replace(/[^a-z0-9.-]/gi, "");
        await notifyTelegramDocument(env, {
          filename: `narrative-audit-${host}.html`,
          bytes: new TextEncoder().encode(stored.html),
          contentType: "text/html",
          caption: [
            "<b>Отчёт файлом (версия для оператора)</b>",
            job.url,
            reportUrl ? `Короткая версия для клиента: https://narrativeintelligence.ru${reportUrl}` : "",
            `<b>Полная версия:</b> https://narrativeintelligence.ru/r/${job.reportToken}/full/`,
          ].filter(Boolean).join(NL),
        });
      }
    } catch (error) {
      console.error("audit reveal document failed", String(error.message || error));
    }
  }

  return json({ ok: true, status: job.status, reportUrl });
}

/** Отдача отчёта: HTML или PDF по короткому токену. */
export async function handleReport(request, env, path) {
  const match = /^\/r\/([a-f0-9]{16,64})(\/full)?(\/report\.pdf)?\/?$/.exec(path);
  if (!match) return notFound();

  const [, token, full, pdf] = match;
  const raw = await env.AUDIT_KV?.get(full ? `report-full:${token}` : `report:${token}`);
  if (!raw) return notFound();

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return notFound();
  }

  if (pdf) {
    if (report.stub || !report.externalId) return notFound();
    const response = await fetchReportPdf(env, { externalId: report.externalId });
    if (!response) return notFound();
    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="narrative-audit-${token}.pdf"`,
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
        "referrer-policy": "no-referrer",
      },
    });
  }

  return new Response(report.html || "<!doctype html><p>Отчёт недоступен.</p>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src data:; base-uri 'none'",
    },
  });
}

function notFound() {
  return new Response(
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="robots" content="noindex">' +
      '<title>Отчёт не найден</title><style>body{background:#0b0b12;color:#f2f0f8;font:16px/1.6 system-ui;' +
      "display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}</style></head>" +
      "<body><div><h1>Отчёт не найден</h1><p>Ссылка устарела или отчёт был удалён.</p>" +
      '<p><a style="color:#b3a5ff" href="https://narrativeintelligence.ru/audit/">Запросить бесплатный аудит</a></p></div></body></html>',
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function handleAudit(request, env, path) {
  if (!env.AUDIT_KV) return json({ ok: false, error: "Хранилище не настроено." }, 500);

  if (path === "/api/audit/start" && request.method === "POST") return start(request, env);
  if (path === "/api/audit/status" && request.method === "GET") return status(request, env);
  if (path === "/api/audit/reveal" && request.method === "POST") return reveal(request, env);
  if (path.startsWith("/api/audit/")) return json({ ok: false, error: "Неизвестный метод API." }, 404);
  return json({ ok: false, error: "Метод не поддерживается." }, 405);
}

export const auditInternals = { siteUrl, normalizePhone, normalizeEmail, publicJob, normalizeState: (s) => s };
