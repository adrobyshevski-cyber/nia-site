/**
 * POST /api/lead — приём заявок с сайта.
 *
 * Доставка идёт параллельно по двум каналам, чтобы заявка не терялась при сбое одного:
 *   1) email через Web3Forms API  (env.WEB3FORMS_KEY)
 *   2) уведомление в Telegram     (env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID)
 *
 * Переменные окружения задаются в Cloudflare Pages → Settings → Environment variables.
 * Локально: файл .dev.vars (см. .dev.vars.example).
 */

const LIMITS = { name: 100, email: 200, message: 2000, website: 300, page: 200, kind: 32 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const MIN_FILL_MS = 1500; // быстрее человек такую форму не заполнит

const json = (body, status = 200) =>
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
  // progressive enhancement: обычный submit формы без JS
  try {
    return Object.fromEntries(await request.formData());
  } catch {
    return null;
  }
}

async function sendEmail(env, lead) {
  const key = env.WEB3FORMS_KEY;
  if (!key) return { channel: "email", ok: false, skipped: true, error: "WEB3FORMS_KEY не задан" };

  const lines = [
    `Тип заявки: ${lead.kind}`,
    `Имя: ${lead.name || "—"}`,
    `Email: ${lead.email}`,
    lead.website ? `Сайт: ${lead.website}` : null,
    "",
    lead.message || "(сообщение не заполнено)",
    "",
    `Страница: ${lead.page || "—"}`,
    `Referer: ${lead.referer || "—"}`,
    `Время (UTC): ${new Date().toISOString()}`,
  ].filter((line) => line !== null);

  const subject =
    lead.kind === "audit" ? "NIA / заявка на бесплатный аудит" : "NIA / запрос с сайта";

  const res = await fetch("https://api.web3forms.com/submit", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      access_key: key,
      subject,
      from_name: "NIA Site",
      replyto: lead.email,
      email: lead.email,
      name: lead.name || "—",
      message: lines.join("\n"),
    }),
  });

  const text = await res.text();
  if (!res.ok) return { channel: "email", ok: false, error: `Web3Forms ${res.status}: ${text.slice(0, 200)}` };
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* Web3Forms иногда отвечает не-JSON при ошибке */
  }
  if (payload && payload.success === false) {
    return { channel: "email", ok: false, error: `Web3Forms: ${payload.message || "success=false"}` };
  }
  return { channel: "email", ok: true };
}

async function sendTelegram(env, lead) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { channel: "telegram", ok: false, skipped: true, error: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы" };
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
    return { channel: "telegram", ok: false, error: `Telegram ${res.status}: ${text.slice(0, 200)}` };
  }
  return { channel: "telegram", ok: true };
}

export async function onRequestPost({ request, env }) {
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
    referer: clip(request.headers.get("referer") || "", LIMITS.page),
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

  const results = await Promise.allSettled([sendEmail(env, lead), sendTelegram(env, lead)]);
  const channels = results.map((r) =>
    r.status === "fulfilled" ? r.value : { channel: "unknown", ok: false, error: String(r.reason) },
  );

  const delivered = channels.some((c) => c.ok);
  // заявка не доставлена никуда — пишем в логи воркера, чтобы можно было найти вручную
  if (!delivered) console.error("lead delivery failed", JSON.stringify({ lead, channels }));

  return json(
    delivered ? { ok: true } : { ok: false, error: "Не удалось доставить заявку. Напишите на niaagency@yandex.com." },
    delivered ? 200 : 502,
  );
}

export async function onRequest({ request }) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  return json({ ok: false, error: "Метод не поддерживается." }, 405);
}
