/**
 * Приём заявок: Telegram-канал.
 *
 * Почему только Telegram: Web3Forms на бесплатном тарифе не принимает запросы с
 * серверов («Use our API in client side», allowlist IP — только Pro), поэтому
 * письмо отправляется из браузера напрямую (см. lead.js), а здесь — мгновенное
 * уведомление в Telegram, где токен бота нельзя отдавать в браузер.
 *
 * Нужны секреты TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID
 * (wrangler secret put / .dev.vars для локальной разработки).
 */

const LIMITS = { name: 100, email: 200, message: 2000, website: 300, page: 200, kind: 32 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const MIN_FILL_MS = 1500; // быстрее человек такую форму не заполнит

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clip = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }
  // прогрессивное улучшение: обычный submit формы без JS
  try {
    return Object.fromEntries(await request.formData());
  } catch {
    return null;
  }
}

/** Уведомление в Telegram произвольным HTML-текстом (используется /demo). */
export async function notifyTelegram(env, html) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return { ok: true };
}

/**
 * Отправляет файл в Telegram (sendDocument). Нужен, когда ссылка на отчёт у
 * клиента не открывается: файл приходит в чат и не зависит от доступности домена.
 */
export async function notifyTelegramDocument(env, { filename, bytes, caption, contentType = "application/pdf" }) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы");

  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", (caption || "").slice(0, 1000));
  form.set("parse_mode", "HTML");
  form.set("document", new Blob([bytes], { type: contentType }), filename);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Telegram document ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return { ok: true };
}

async function sendTelegram(env, lead) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы" };
  }

  const title = lead.kind === "audit" ? "🔍 Заявка на аудит" : "✉️ Запрос с сайта";
  const rows = [
    `<b>${escapeHtml(title)}</b>`,
    lead.name ? `<b>Имя:</b> ${escapeHtml(lead.name)}` : null,
    `<b>Email:</b> ${escapeHtml(lead.email)}`,
    lead.website ? `<b>Сайт:</b> ${escapeHtml(lead.website)}` : null,
    lead.message ? `\n${escapeHtml(lead.message)}` : null,
    `\n<i>${escapeHtml(lead.page || "—")}</i>`,
  ].filter(Boolean);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: rows.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Telegram ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

/** POST /api/lead */
export async function handleLead(request, env) {
  const raw = await readBody(request);
  if (!raw) return json({ ok: false, error: "Некорректный формат запроса." }, 400);

  // honeypot: поле скрыто в CSS, человек его не заполнит
  if (clip(raw.botcheck, 100)) return json({ ok: true });

  // защита от мгновенных отправок ботами (без JS поле elapsed пустое — тогда не проверяем)
  const elapsed =
    raw.elapsed === undefined || raw.elapsed === null || raw.elapsed === "" ? NaN : Number(raw.elapsed);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) return json({ ok: true });

  const lead = {
    kind: clip(raw.kind, LIMITS.kind) === "audit" ? "audit" : "contact",
    name: clip(raw.name, LIMITS.name),
    email: clip(raw.email, LIMITS.email).toLowerCase(),
    website: clip(raw.website, LIMITS.website),
    message: clip(raw.message, LIMITS.message),
    page: clip(raw.page, LIMITS.page),
  };

  if (!EMAIL_RE.test(lead.email)) {
    return json({ ok: false, error: "Проверьте адрес электронной почты." }, 400);
  }
  if (lead.kind === "audit" && !lead.website) {
    return json({ ok: false, error: "Укажите адрес сайта для аудита." }, 400);
  }
  if (lead.kind === "contact" && !lead.message) {
    return json({ ok: false, error: "Опишите задачу — хотя бы одним предложением." }, 400);
  }

  const result = await sendTelegram(env, lead);
  if (!result.ok) {
    // письмо уходит из браузера отдельным запросом, поэтому это не потеря заявки,
    // но в лог пишем — пригодится при разборе «а мне ничего не пришло»
    console.error("telegram delivery failed", JSON.stringify({ lead, error: result.error }));
    return json({ ok: false, error: "Telegram-уведомление не доставлено." }, 502);
  }

  return json({ ok: true });
}
