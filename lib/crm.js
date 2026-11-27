/**
 * CRM на Cloudflare D1: лиды, сделки по услугам, лента заметок.
 *
 * Зачем D1, а не KV: нужны выборки по стадии/источнику, поиск по подстроке и
 * связи лид → сделки → активности. В KV заявки из /demo жили в `job:<id>` с
 * TTL 6 часов, то есть контакты терялись.
 *
 * Доступ — та же сессия, что у /studio (cookie nia_studio, секрет SESSION_SECRET,
 * пароль ADMIN_PASSWORD_HASH): вход один, отдельных ролей нет.
 *
 * Если биндинга DB нет (например, на превью-окружении), recordLead тихо
 * возвращает null — приём заявок и Telegram от этого не ломаются.
 */

import { isAuthenticated, isSameOrigin } from "./auth.js";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const fail = (status, error) => json({ ok: false, error }, status);

const LIMITS = { name: 100, email: 200, phone: 40, site: 300, event: 120, notes: 4000, text: 2000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Источники лида. `demo` — экспресс-аудит на стенде, `audit_form` — формы сайта. */
export const SOURCES = ["demo", "audit_form", "manual"];
export const SERVICES = ["audit", "brand", "culture", "economics", "strategy", "lab"];
export const STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost", "paused"];

const KINDS = ["note", "call", "email", "meeting", "stage", "system"];

export const nowIso = () => new Date().toISOString();

const clip = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

const nullable = (value, limit) => clip(value, limit) || null;

export const crmReady = (env) => Boolean(env && env.DB);

function requireDb(env) {
  if (!env || !env.DB) throw new Error("D1 не подключён: добавьте binding DB в wrangler.jsonc и примените миграции.");
  return env.DB;
}

const oneOf = (value, allowed, fallback = "") => {
  const text = clip(value, 40);
  return allowed.includes(text) ? text : fallback;
};

/** Сумма сделки: пусто → NULL, иначе целое неотрицательное число. */
function parseAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Сумма должна быть неотрицательным числом.");
  return Math.round(number);
}

/**
 * Запись лида из любой точки сайта. Не бросает исключений: заявка важнее CRM.
 * Дедупликация — по `report_token`: демо-отчёт и последующая форма дают один лид.
 */
export async function recordLead(env, input = {}) {
  if (!crmReady(env)) return null;

  const lead = {
    source: oneOf(input.source, SOURCES, "manual"),
    name: nullable(input.name, LIMITS.name),
    email: nullable(input.email, LIMITS.email)?.toLowerCase() || null,
    phone: nullable(input.phone, LIMITS.phone),
    site: nullable(input.site, LIMITS.site),
    event: nullable(input.event, LIMITS.event),
    reportToken: nullable(input.reportToken, 80),
    consentAt: nullable(input.consentAt, 40),
  };

  // без контакта лид бесполезен — источник мог прислать только анонимный клик
  if (!lead.email && !lead.phone) return null;

  try {
    const row = await requireDb(env)
      .prepare(
        `INSERT INTO leads (id, created_at, source, name, email, phone, site, event, report_token, status, consent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
         ON CONFLICT(report_token) DO UPDATE SET
           name       = COALESCE(excluded.name, leads.name),
           email      = COALESCE(excluded.email, leads.email),
           phone      = COALESCE(excluded.phone, leads.phone),
           site       = COALESCE(excluded.site, leads.site),
           event      = COALESCE(excluded.event, leads.event),
           consent_at = COALESCE(leads.consent_at, excluded.consent_at)
         RETURNING id`,
      )
      .bind(
        crypto.randomUUID(),
        nowIso(),
        lead.source,
        lead.name,
        lead.email,
        lead.phone,
        lead.site,
        lead.event,
        lead.reportToken,
        lead.consentAt,
      )
      .first();
    return row?.id || null;
  } catch (error) {
    console.error("crm recordLead failed", String(error?.message || error));
    return null;
  }
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Общие условия для списка и CSV-выгрузки: один фильтр — один источник правды. */
function leadFilter({ q = "", status = "", source = "" } = {}) {
  const where = [];
  const params = [];

  const query = clip(q, 100);
  if (query) {
    const like = `%${escapeLike(query)}%`;
    where.push(
      "(l.name LIKE ? ESCAPE '\\' OR l.email LIKE ? ESCAPE '\\' OR l.site LIKE ? ESCAPE '\\' OR l.phone LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like, like);
  }
  const stage = oneOf(status, STAGES);
  if (stage) {
    where.push("l.status = ?");
    params.push(stage);
  }
  const from = oneOf(source, SOURCES);
  if (from) {
    where.push("l.source = ?");
    params.push(from);
  }

  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** GET /api/crm/leads — список с фильтрами и поиском. */
export async function listLeads(env, { q = "", status = "", source = "", limit = 50, offset = 0 } = {}) {
  const db = requireDb(env);
  const { clause, params } = leadFilter({ q, status, source });
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = Math.max(Number(offset) || 0, 0);

  const rows = await db
    .prepare(
      `SELECT l.id, l.created_at, l.source, l.name, l.email, l.phone, l.site, l.event,
              l.report_token, l.status, l.consent_at,
              (SELECT COUNT(*) FROM deals d WHERE d.lead_id = l.id) AS deal_count,
              (SELECT d.stage FROM deals d WHERE d.lead_id = l.id ORDER BY d.updated_at DESC LIMIT 1) AS deal_stage,
              (SELECT MIN(d.next_step_at) FROM deals d WHERE d.lead_id = l.id AND d.next_step_at IS NOT NULL) AS next_at
         FROM leads l ${clause}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...params, size, skip)
    .all();

  const total = await db.prepare(`SELECT COUNT(*) AS n FROM leads l ${clause}`).bind(...params).first();

  return { items: rows.results || [], total: Number(total?.n) || 0, limit: size, offset: skip };
}

/** Карточка лида: контакты + сделки + активности. */
export async function getLead(env, id) {
  const db = requireDb(env);
  const key = clip(id, 60);
  if (!key) return null;

  const [leadResult, dealsResult, activitiesResult] = await db.batch([
    db.prepare("SELECT * FROM leads WHERE id = ?").bind(key),
    db.prepare("SELECT * FROM deals WHERE lead_id = ? ORDER BY created_at DESC").bind(key),
    db.prepare("SELECT * FROM activities WHERE lead_id = ? ORDER BY at DESC LIMIT 200").bind(key),
  ]);

  const lead = (leadResult.results || [])[0];
  if (!lead) return null;
  return { lead, deals: dealsResult.results || [], activities: activitiesResult.results || [] };
}

const LEAD_FIELDS = { name: LIMITS.name, email: LIMITS.email, phone: LIMITS.phone, site: LIMITS.site, notes: LIMITS.notes };

export async function updateLead(env, id, payload = {}) {
  const db = requireDb(env);
  const key = clip(id, 60);
  if (!key) return null;

  const sets = [];
  const params = [];

  for (const [field, limit] of Object.entries(LEAD_FIELDS)) {
    if (!(field in payload)) continue;
    const value = nullable(payload[field], limit);
    if (field === "email" && value && !EMAIL_RE.test(value)) {
      throw new Error("Проверьте адрес электронной почты.");
    }
    sets.push(`${field} = ?`);
    params.push(field === "email" && value ? value.toLowerCase() : value);
  }

  if ("status" in payload) {
    const status = oneOf(payload.status, STAGES);
    if (!status) throw new Error("Неизвестная стадия.");
    sets.push("status = ?");
    params.push(status);
  }

  if (!sets.length) return getLead(env, key);

  // смена стадии лида попадает в ленту — иначе история теряется
  if ("status" in payload) {
    const current = await db.prepare("SELECT status FROM leads WHERE id = ?").bind(key).first();
    const next = params[params.length - 1];
    if (current && current.status !== next) {
      await addActivity(env, key, { kind: "stage", text: `Стадия: ${current.status} → ${next}` });
    }
  }

  const updated = await db
    .prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ? RETURNING id`)
    .bind(...params, key)
    .first();
  if (!updated) return null;
  return getLead(env, key);
}

/** Удаление лида: сделки и активности уходят каскадом. */
export async function deleteLead(env, id) {
  const db = requireDb(env);
  const key = clip(id, 60);
  if (!key) return false;
  const row = await db.prepare("DELETE FROM leads WHERE id = ? RETURNING id").bind(key).first();
  return Boolean(row);
}

export async function addActivity(env, leadId, { kind = "note", text = "", dealId = null } = {}) {
  const db = requireDb(env);
  const key = clip(leadId, 60);
  const body = clip(text, LIMITS.text);
  if (!key || !body) throw new Error("Пустая заметка.");
  const type = oneOf(kind, KINDS, "note");
  const row = await db
    .prepare("INSERT INTO activities (id, lead_id, deal_id, at, kind, text) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(crypto.randomUUID(), key, dealId ? clip(dealId, 60) : null, nowIso(), type, body)
    .first();
  return row;
}

export async function createDeal(env, leadId, payload = {}) {
  const db = requireDb(env);
  const key = clip(leadId, 60);
  const service = oneOf(payload.service, SERVICES);
  if (!key) throw new Error("Не указан лид.");
  if (!service) throw new Error("Выберите услугу.");
  const stage = oneOf(payload.stage, STAGES, "new");
  const stamp = nowIso();
  const row = await db
    .prepare(
      `INSERT INTO deals (id, lead_id, service, stage, next_step, next_step_at, amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      key,
      service,
      stage,
      nullable(payload.next_step, LIMITS.text),
      nullable(payload.next_step_at, 40),
      parseAmount(payload.amount),
      stamp,
      stamp,
    )
    .first();
  return row;
}

export async function updateDeal(env, dealId, payload = {}) {
  const db = requireDb(env);
  const key = clip(dealId, 60);
  if (!key) return null;

  const sets = [];
  const params = [];

  if ("stage" in payload) {
    const stage = oneOf(payload.stage, STAGES);
    if (!stage) throw new Error("Неизвестная стадия.");
    sets.push("stage = ?");
    params.push(stage);
  }
  if ("service" in payload) {
    const service = oneOf(payload.service, SERVICES);
    if (!service) throw new Error("Неизвестная услуга.");
    sets.push("service = ?");
    params.push(service);
  }
  if ("next_step" in payload) {
    sets.push("next_step = ?");
    params.push(nullable(payload.next_step, LIMITS.text));
  }
  if ("next_step_at" in payload) {
    sets.push("next_step_at = ?");
    params.push(nullable(payload.next_step_at, 40));
    // новый срок — новое напоминание: старый отправленный не блокирует следующий
    sets.push("reminded_at = NULL");
  }
  if ("amount" in payload) {
    sets.push("amount = ?");
    params.push(parseAmount(payload.amount));
  }

  if (!sets.length) return null;

  sets.push("updated_at = ?");
  params.push(nowIso());

  const before = await db.prepare("SELECT lead_id, stage FROM deals WHERE id = ?").bind(key).first();
  if (!before) return null;

  const row = await db
    .prepare(`UPDATE deals SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...params, key)
    .first();

  if ("stage" in payload) {
    const next = oneOf(payload.stage, STAGES);
    if (next && next !== before.stage) {
      await addActivity(env, before.lead_id, { kind: "stage", dealId: key, text: `Сделка: ${before.stage} → ${next}` });
    }
  }

  return row;
}

export async function deleteDeal(env, dealId) {
  const db = requireDb(env);
  const key = clip(dealId, 60);
  if (!key) return false;
  const row = await db.prepare("DELETE FROM deals WHERE id = ? RETURNING id").bind(key).first();
  return Boolean(row);
}

/** Сводка: за 30 дней по источникам, воронка, ближайшие шаги. */
export async function stats(env) {
  const db = requireDb(env);
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const weekAhead = new Date(Date.now() + 7 * 86400_000).toISOString();

  const [bySource, byStatus, byService, totals, upcoming, byEvent] = await db.batch([
    db.prepare("SELECT source, COUNT(*) AS n FROM leads WHERE created_at >= ? GROUP BY source").bind(monthAgo),
    db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status"),
    db.prepare("SELECT service, stage, COUNT(*) AS n FROM deals GROUP BY service, stage"),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM leads) AS leads,
                (SELECT COUNT(*) FROM leads WHERE created_at >= ?) AS leads30,
                (SELECT COUNT(*) FROM deals WHERE stage NOT IN ('won', 'lost')) AS open_deals,
                (SELECT COUNT(*) FROM deals WHERE stage = 'won') AS won`,
      )
      .bind(monthAgo),
    db
      .prepare(
        `SELECT d.id, d.service, d.stage, d.next_step, d.next_step_at, l.id AS lead_id, l.name, l.site
           FROM deals d JOIN leads l ON l.id = d.lead_id
          WHERE d.next_step_at IS NOT NULL AND d.next_step_at <= ?
          ORDER BY d.next_step_at LIMIT 20`,
      )
      .bind(weekAhead),
    db
      .prepare(
        `SELECT COALESCE(NULLIF(event, ''), '(без метки)') AS event, COUNT(*) AS n,
                SUM(CASE WHEN report_token IS NOT NULL THEN 1 ELSE 0 END) AS reports
           FROM leads WHERE created_at >= ? GROUP BY event ORDER BY n DESC LIMIT 12`,
      )
      .bind(monthAgo),
  ]);

  return {
    sources: bySource.results || [],
    statuses: byStatus.results || [],
    services: byService.results || [],
    totals: (totals.results || [])[0] || { leads: 0, leads30: 0, open_deals: 0, won: 0 },
    upcoming: upcoming.results || [],
    events: (byEvent.results || []).map((row) => ({ event: row.event, n: Number(row.n) || 0, reports: Number(row.reports) || 0 })),
  };
}

// ---------- CSV и срок хранения ----------

const csvCell = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Excel с русской локалью ждёт ";" и BOM, иначе кириллица ломается
const CSV_DELIMITER = ";";
const csvRow = (values) => values.map(csvCell).join(CSV_DELIMITER);

const LEAD_COLUMNS = ["id", "created_at", "source", "status", "name", "email", "phone", "site", "event", "report_token", "consent_at", "notes"];
const DEAL_COLUMNS = ["id", "created_at", "service", "stage", "amount", "next_step", "next_step_at", "lead_id", "lead_name", "lead_email", "lead_site"];

/** CSV лидов с теми же фильтрами, что и список. */
export async function exportLeadsCsv(env, filters = {}) {
  const db = requireDb(env);
  const { clause, params } = leadFilter(filters);
  const rows = await db
    .prepare(`SELECT l.* FROM leads l ${clause} ORDER BY l.created_at DESC, l.id DESC LIMIT 5000`)
    .bind(...params)
    .all();
  const lines = [csvRow(LEAD_COLUMNS)];
  for (const row of rows.results || []) lines.push(csvRow(LEAD_COLUMNS.map((key) => row[key])));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** CSV сделок — для сверки денег и воронки. */
export async function exportDealsCsv(env) {
  const db = requireDb(env);
  const rows = await db
    .prepare(
      `SELECT d.id, d.created_at, d.service, d.stage, d.amount, d.next_step, d.next_step_at,
              d.lead_id, l.name AS lead_name, l.email AS lead_email, l.site AS lead_site
         FROM deals d JOIN leads l ON l.id = d.lead_id
        ORDER BY d.created_at DESC LIMIT 5000`,
    )
    .all();
  const lines = [csvRow(DEAL_COLUMNS)];
  for (const row of rows.results || []) lines.push(csvRow(DEAL_COLUMNS.map((key) => row[key])));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * Срок хранения (152-ФЗ): лиды старше N дней обезличиваются — имя, контакты,
 * заметки и токен отчёта стираются, а строки сделок и статистика остаются.
 * Лиды с открытыми сделками не трогаем: работа ещё идёт.
 * Активности старше N дней удаляются: в тексте заметок тоже персональные данные.
 *
 * По умолчанию dryRun — реальное удаление только по явному dryRun: false.
 */
export async function applyRetention(env, { days = 180, dryRun = true, at = new Date() } = {}) {
  const db = requireDb(env);
  const horizon = Math.max(Number(days) || 180, 1);
  const cutoff = new Date(at.getTime() - horizon * 86400_000).toISOString();

  const stale = await db
    .prepare(
      `SELECT id FROM leads
        WHERE created_at < ?
          AND (name IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL OR notes IS NOT NULL OR report_token IS NOT NULL)`,
    )
    .bind(cutoff)
    .all();
  const candidates = (stale.results || []).map((row) => row.id);

  const openDeals = await db.prepare("SELECT DISTINCT lead_id FROM deals WHERE stage NOT IN ('won', 'lost')").all();
  const open = new Set((openDeals.results || []).map((row) => row.lead_id));
  const targets = candidates.filter((id) => !open.has(id));

  const oldActivities = await db.prepare("SELECT COUNT(*) AS n FROM activities WHERE at < ?").bind(cutoff).first();
  const summary = {
    dryRun,
    days: horizon,
    cutoff,
    leads: targets.length,
    keptOpen: candidates.length - targets.length,
    activities: Number(oldActivities?.n) || 0,
  };
  if (dryRun) return summary;

  if (targets.length) {
    const statements = targets.map((id) =>
      db
        .prepare("UPDATE leads SET name = NULL, email = NULL, phone = NULL, notes = NULL, report_token = NULL WHERE id = ?")
        .bind(id),
    );
    await db.batch(statements);
  }

  const deleted = await db.prepare("DELETE FROM activities WHERE at < ? RETURNING id").bind(cutoff).all();
  summary.activities = (deleted.results || []).length;
  return summary;
}

// ---------- напоминания по сделкам (cron) ----------

/** Часовой пояс для человеческих дат в Telegram (в D1 всё в ISO/UTC). */
const DISPLAY_TZ = "Europe/Moscow";
const SITE = "https://narrativeintelligence.ru";

const escapeHtml = (value) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmtShort = (iso) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DISPLAY_TZ,
  }).format(date);
};

/** Сделки, у которых шаг уже наступил (или просрочен) и напоминание ещё не уходило. */
export async function dueReminders(env, at = nowIso()) {
  const db = requireDb(env);
  const rows = await db
    .prepare(
      `SELECT d.id, d.service, d.stage, d.next_step, d.next_step_at,
              l.id AS lead_id, l.name, l.site, l.email, l.status
         FROM deals d JOIN leads l ON l.id = d.lead_id
        WHERE d.reminded_at IS NULL
          AND d.next_step_at IS NOT NULL
          AND d.next_step_at <= ?
          AND d.stage NOT IN ('won', 'lost')
        ORDER BY d.next_step_at
        LIMIT 20`,
    )
    .bind(at)
    .all();
  return rows.results || [];
}

/** Текст сообщения: одна сводка на все наступившие шаги. */
export function reminderMessage(rows, at = nowIso()) {
  const lines = [`<b>⏰ CRM · шаги по сделкам: ${rows.length}</b>`, `<i>на ${fmtShort(at)} МСК</i>`];
  for (const row of rows) {
    const who = [escapeHtml(row.name || "без имени"), row.site ? escapeHtml(row.site) : ""].filter(Boolean).join(" · ");
    lines.push(
      `\n<b>${escapeHtml(row.service)} · ${escapeHtml(row.stage)}</b>`,
      row.next_step ? escapeHtml(row.next_step) : "шаг не описан",
      `<i>срок: ${fmtShort(row.next_step_at)} МСК</i>`,
      who,
      `<a href="${SITE}/crm/?lead=${encodeURIComponent(row.lead_id)}">открыть карточку</a>`,
    );
  }
  return lines.join("\n");
}

/** Отмечает сделку как напомненную и пишет это в ленту лида. */
export async function markReminded(env, rows, at = nowIso()) {
  const db = requireDb(env);
  if (!rows.length) return 0;
  const statements = [];
  for (const row of rows) {
    statements.push(db.prepare("UPDATE deals SET reminded_at = ?, updated_at = ? WHERE id = ?").bind(at, at, row.id));
    statements.push(
      db
        .prepare("INSERT INTO activities (id, lead_id, deal_id, at, kind, text) VALUES (?, ?, ?, ?, 'system', ?)")
        .bind(
          crypto.randomUUID(),
          row.lead_id,
          row.id,
          at,
          `Напоминание отправлено: ${row.next_step || row.service} (${fmtShort(row.next_step_at)})`,
        ),
    );
  }
  await db.batch(statements);
  return rows.length;
}

/**
 * Отправка напоминаний: сначала сообщение, потом отметки — если Telegram упал,
 * шаг останется неотмеченным и уйдёт следующим запуском cron, а не потеряется.
 */
export async function runReminders(env, notify, at = new Date()) {
  if (!crmReady(env)) return { sent: 0, due: 0, skipped: "no-db" };
  const stamp = at.toISOString();

  const rows = await dueReminders(env, stamp);
  if (!rows.length) return { sent: 0, due: 0 };
  if (typeof notify !== "function") return { sent: 0, due: rows.length, skipped: "no-notify" };

  try {
    await notify(reminderMessage(rows, stamp));
  } catch (error) {
    console.error("crm reminders notify failed", String(error?.message || error));
    return { sent: 0, due: rows.length, error: String(error?.message || error) };
  }

  await markReminded(env, rows, stamp);
  return { sent: rows.length, due: rows.length };
}

/** POST /api/crm/leads — лид, добавленный вручную. */
async function createLead(env, payload) {
  if (!payload || typeof payload !== "object") throw new Error("Некорректный запрос.");
  const email = nullable(payload.email, LIMITS.email);
  const phone = nullable(payload.phone, LIMITS.phone);
  if (!email && !phone) throw new Error("Укажите email или телефон.");
  if (email && !EMAIL_RE.test(email)) throw new Error("Проверьте адрес электронной почты.");

  const id = await recordLead(env, { ...payload, source: "manual" });
  if (!id) throw new Error("Не удалось сохранить лид.");

  // контекст «откуда и о чём» — в отдельную колонку, а не в activities:
  // это свойство лида, его видно сразу в карточке
  const notes = nullable(payload.notes, LIMITS.notes);
  if (notes) {
    await requireDb(env).prepare("UPDATE leads SET notes = ? WHERE id = ?").bind(notes, id).first();
  }

  return getLead(env, id);
}

/** Роутер /api/crm/*: все методы требуют сессии /studio. */
export async function handleCrm(request, env, pathname, deps = {}) {
  if (!(await isAuthenticated(request, env))) {
    return fail(401, "Требуется вход: /studio.");
  }
  if (request.method !== "GET" && !isSameOrigin(request)) {
    return fail(403, "Запрос с чужого origin.");
  }
  if (!crmReady(env)) {
    return fail(503, "D1 не подключён: binding DB в wrangler.jsonc и migrations/0001_init.sql.");
  }

  const url = new URL(request.url);
  const path = pathname.replace(/\/+$/, "") || "/api/crm";

  try {
    if (path === "/api/crm/health") {
      return json({ ok: true, d1: true });
    }

    if (path === "/api/crm/export.csv" && request.method === "GET") {
      const type = url.searchParams.get("type") === "deals" ? "deals" : "leads";
      const body =
        type === "deals"
          ? await exportDealsCsv(env)
          : await exportLeadsCsv(env, {
              q: url.searchParams.get("q") || "",
              status: url.searchParams.get("status") || "",
              source: url.searchParams.get("source") || "",
            });
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(body, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="nia-crm-${type}-${stamp}.csv"`,
          "cache-control": "no-store",
        },
      });
    }

    if (path === "/api/crm/retention/run") {
      if (request.method !== "POST") return fail(405, "Метод не поддерживается.");
      const dryRun = url.searchParams.get("dry") !== "0";
      const days = Number(env.CRM_RETENTION_DAYS) || 180;
      return json({ ok: true, ...(await applyRetention(env, { days, dryRun })) });
    }

    if (path === "/api/crm/reminders/run") {
      if (request.method !== "POST") return fail(405, "Метод не поддерживается.");
      if (typeof deps.notify !== "function") {
        return fail(503, "Telegram не настроен: TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.");
      }
      return json({ ok: true, ...(await runReminders(env, deps.notify)) });
    }

    if (path === "/api/crm/leads") {
      if (request.method === "GET") {
        const params = url.searchParams;
        return json({
          ok: true,
          ...(await listLeads(env, {
            q: params.get("q") || "",
            status: params.get("status") || "",
            source: params.get("source") || "",
            limit: params.get("limit"),
            offset: params.get("offset"),
          })),
        });
      }
      if (request.method === "POST") {
        return json({ ok: true, ...(await createLead(env, await request.json())) });
      }
      return fail(405, "Метод не поддерживается.");
    }

    if (path === "/api/crm/stats" && request.method === "GET") {
      return json({ ok: true, ...(await stats(env)) });
    }

    const leadMatch = path.match(/^\/api\/crm\/leads\/([^/]+)(\/deals|\/activities)?$/);
    if (leadMatch) {
      const id = decodeURIComponent(leadMatch[1]);
      const sub = leadMatch[2];

      if (sub === "/deals") {
        if (request.method === "POST") {
          return json({ ok: true, deal: await createDeal(env, id, await request.json()) });
        }
        return fail(405, "Метод не поддерживается.");
      }

      if (sub === "/activities") {
        if (request.method === "POST") {
          const payload = await request.json();
          return json({ ok: true, activity: await addActivity(env, id, payload) });
        }
        return fail(405, "Метод не поддерживается.");
      }

      if (request.method === "GET") {
        const card = await getLead(env, id);
        if (!card) return fail(404, "Лид не найден.");
        return json({ ok: true, ...card });
      }
      if (request.method === "PATCH" || request.method === "POST") {
        const card = await updateLead(env, id, await request.json());
        if (!card) return fail(404, "Лид не найден.");
        return json({ ok: true, ...card });
      }
      if (request.method === "DELETE") {
        if (!(await deleteLead(env, id))) return fail(404, "Лид не найден.");
        return json({ ok: true });
      }
      return fail(405, "Метод не поддерживается.");
    }

    const dealMatch = path.match(/^\/api\/crm\/deals\/([^/]+)$/);
    if (dealMatch) {
      const id = decodeURIComponent(dealMatch[1]);
      if (request.method === "PATCH" || request.method === "POST") {
        const deal = await updateDeal(env, id, await request.json());
        if (!deal) return fail(404, "Сделка не найдена.");
        return json({ ok: true, deal });
      }
      if (request.method === "DELETE") {
        if (!(await deleteDeal(env, id))) return fail(404, "Сделка не найдена.");
        return json({ ok: true });
      }
      return fail(405, "Метод не поддерживается.");
    }

    return fail(404, "Неизвестный метод CRM API.");
  } catch (error) {
    const message = String(error?.message || error);
    // ошибки валидации — 400, всё остальное (D1, SQL) — 502
    const status = /Укажите|Проверьте|Выберите|Неизвестн|Пустая|Некорректный|Не указан|Не удалось|Сумма/.test(message) ? 400 : 502;
    if (status === 502) console.error("crm api failed", message);
    return fail(status, message);
  }
}
