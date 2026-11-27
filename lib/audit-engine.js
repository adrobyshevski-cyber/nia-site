/**
 * Движок аудита — единственное место, которое знает, кто считает отчёт.
 *
 *   stub       — локальная имитация: «в работе» 40 секунд, отчёта нет
 *                (в UI честно написано, что это демо)
 *   storyaudit — реальный сервис (StoryAudit, FastAPI) по HTTP
 *
 * Контракт StoryAudit (см. PR adrobyshevski-cyber/storyaudit#1):
 *   POST /audit   form: website, consent=on
 *                 заголовки: accept: application/json, x-internal-token, x-forwarded-for
 *                 → 201 {token, state_url, report_url, pdf_url}
 *   GET  /audit/{token}/state          → {state, report_url, error}
 *   GET  /audit/{token}/report?inline=1 → готовый HTML с встроенным CSS
 *   GET  /audit/{token}/report.pdf      → PDF
 *
 * Состояния сервиса → наши: ingesting=queued, analyzing=running, review=review,
 * ready=done, failed/rejected=failed, expired=expired.
 */

const STUB_QUEUE_MS = 8_000;
const STUB_DONE_MS = 40_000;

const STATUS_MAP = {
  ingesting: "queued",
  analyzing: "running",
  review: "review",
  ready: "done",
  failed: "failed",
  rejected: "failed",
  expired: "expired",
};

/** Включаем реальный движок только когда заданы и режим, и адрес сервиса. */
export const engineName = (env) =>
  String(env.AUDIT_ENGINE || "").toLowerCase() === "live" && env.AUDIT_SERVICE_URL ? "storyaudit" : "stub";

const mapStatus = (state) => STATUS_MAP[String(state || "").toLowerCase()] || "running";

function serviceBase(env) {
  const base = String(env.AUDIT_SERVICE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("AUDIT_SERVICE_URL не задан");
  return base;
}

function serviceHeaders(env, extra = {}) {
  const headers = { accept: "application/json", ...extra };
  if (env.AUDIT_INTERNAL_TOKEN) headers["x-internal-token"] = env.AUDIT_INTERNAL_TOKEN;
  return headers;
}

/** Ставит аудит в очередь. Возвращает { externalId, status }. */
export async function startAudit(env, { url, ip, jobId }) {
  if (engineName(env) === "stub") {
    return { externalId: `stub-${jobId}`, status: "queued" };
  }

  const form = new FormData();
  form.set("website", url);
  form.set("consent", "on");

  // Edge перезаписывает X-Forwarded-For своим адресом, поэтому реальный клиент
  // едет отдельным заголовком; сервис читает его только для доверенного вызова.
  const headers = serviceHeaders(env, { "x-forwarded-for": ip || "", "x-client-ip": ip || "" });

  const response = await fetch(`${serviceBase(env)}/audit`, { method: "POST", headers, body: form });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Сервис аудита вернул не-JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.error || `Сервис аудита: HTTP ${response.status}`);
  }
  if (!payload?.token) throw new Error("Сервис аудита не вернул токен задачи");

  return { externalId: String(payload.token), status: "queued" };
}

/** Текущее состояние аудита: { status, error? }. */
export async function getAuditState(env, job) {
  if (engineName(env) === "stub") {
    const age = Date.now() - job.createdAt;
    if (age < STUB_QUEUE_MS) return { status: "queued" };
    if (age < STUB_DONE_MS) return { status: "running" };
    return { status: "done", stub: true };
  }

  const response = await fetch(`${serviceBase(env)}/audit/${encodeURIComponent(job.externalId)}/state`, {
    headers: serviceHeaders(env),
  });
  if (!response.ok) throw new Error(`Сервис аудита: HTTP ${response.status} на /state`);
  const payload = await response.json().catch(() => null);
  if (!payload) throw new Error("Сервис аудита вернул пустой статус");

  return { status: mapStatus(payload.state), error: payload.error ? String(payload.error) : null };
}

/** Готовый HTML отчёта со встроенным CSS: brief — короткая версия, иначе полная. */
export async function fetchReportHtml(env, job, { brief = true } = {}) {
  if (job.stub) return null;
  const query = brief ? "?inline=1&brief=1" : "?inline=1";
  const response = await fetch(
    `${serviceBase(env)}/audit/${encodeURIComponent(job.externalId)}/report${query}`,
    { headers: serviceHeaders(env, { accept: "text/html" }) },
  );
  if (!response.ok) throw new Error(`Сервис аудита: HTTP ${response.status} на /report`);
  const html = await response.text();
  if (!html.trim()) throw new Error("Сервис аудита вернул пустой отчёт");
  return html;
}

/** PDF отчёта — отдаём браузеру как есть. */
export async function fetchReportPdf(env, job) {
  const response = await fetch(
    `${serviceBase(env)}/audit/${encodeURIComponent(job.externalId)}/report.pdf`,
    { headers: serviceHeaders(env, { accept: "application/pdf" }) },
  );
  if (!response.ok) return null;
  return response;
}
