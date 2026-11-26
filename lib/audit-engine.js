/**
 * Движок аудита — единственное место, которое знает, кто именно считает отчёт.
 *
 * Сейчас два режима (env.AUDIT_ENGINE):
 *   stub — имитация: заявка «в работе» 40 секунд, отчёта нет (честно помечено в UI)
 *   http — реальный сервис из другого проекта: env.AUDIT_SERVICE_URL + env.AUDIT_SERVICE_TOKEN
 *
 * Контракт, который должен реализовать внешний сервис:
 *   POST {url}/audits            {"url": "https://..."}  → 202 {"id": "..."}
 *   GET  {url}/audits/{id}       → {"status": "queued|running|done|failed",
 *                                   "report_url"?: "https://...", "error"?: "..."}
 * Заголовок авторизации: Authorization: Bearer <AUDIT_SERVICE_TOKEN>
 * Альтернатива опросу — вебхук: сервис сам дергает POST /api/audit/callback (см. ниже).
 */

const STUB_QUEUE_MS = 8_000;
const STUB_DONE_MS = 40_000;

export const engineName = (env) => (env.AUDIT_ENGINE === "live" ? "http" : "stub");

function serviceBase(env) {
  const base = (env.AUDIT_SERVICE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("AUDIT_SERVICE_URL не задан");
  return base;
}

async function serviceFetch(env, path, init = {}) {
  const response = await fetch(`${serviceBase(env)}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(env.AUDIT_SERVICE_TOKEN ? { authorization: `Bearer ${env.AUDIT_SERVICE_TOKEN}` } : {}),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Сервис аудита вернул не-JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Сервис аудита: HTTP ${response.status}`);
  }
  return payload || {};
}

/** Ставит аудит в очередь. Возвращает { externalId, status }. */
export async function startAudit(env, { url, jobId }) {
  if (engineName(env) === "stub") {
    return { externalId: `stub-${jobId}`, status: "queued" };
  }

  const payload = await serviceFetch(env, "/audits", {
    method: "POST",
    body: JSON.stringify({ url, reference: jobId }),
  });

  if (!payload.id) throw new Error("Сервис аудита не вернул id задачи");
  return {
    externalId: String(payload.id),
    status: ["queued", "running", "done"].includes(payload.status) ? payload.status : "queued",
  };
}

/** Текущее состояние аудита: { status, reportUrl?, error? }. */
export async function getAuditState(env, job) {
  if (engineName(env) === "stub") {
    const age = Date.now() - job.createdAt;
    if (age < STUB_QUEUE_MS) return { status: "queued" };
    if (age < STUB_DONE_MS) return { status: "running" };
    return { status: "done", reportUrl: null, stub: true };
  }

  const payload = await serviceFetch(env, `/audits/${encodeURIComponent(job.externalId)}`);
  const status = ["queued", "running", "done", "failed"].includes(payload.status) ? payload.status : "running";
  return {
    status,
    reportUrl: payload.report_url ? String(payload.report_url) : null,
    error: payload.error ? String(payload.error) : null,
  };
}
