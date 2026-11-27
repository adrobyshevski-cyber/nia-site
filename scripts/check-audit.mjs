/**
 * Тесты /demo: лимиты, валидация, стейт-машина, квота события, отчёты.
 * KV, Telegram и StoryAudit подменены — сеть не используется.
 *
 * Запуск: node scripts/check-audit.mjs
 */

import { handleAudit, handleReport, auditInternals } from "../lib/audit.js";

const ENV = {
  SESSION_SECRET: "test-secret",
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_CHAT_ID: "42",
  AUDIT_ENGINE: "stub",
};

let failed = 0;
const telegram = [];

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const realFetch = globalThis.fetch;

const telegramOk = async (url) => {
  telegram.push(String(url));
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

/** Заглушка StoryAudit: поведение задаётся через объект service. */
const service = { state: "analyzing", reportHtml: "", pdf: "%PDF-1.4", calls: [], fail: false };

const serviceFetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  service.calls.push({ path, method: init.method || "GET", headers: init.headers || {} });
  if (service.fail) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 });

  if (path === "/audit" && init.method === "POST") {
    return new Response(JSON.stringify({ token: "story-token-1", state_url: "/audit/story-token-1/state" }), {
      status: 201,
    });
  }
  if (path.endsWith("/state")) {
    return new Response(JSON.stringify({ state: service.state, report_url: null, error: null }), { status: 200 });
  }
  if (path.endsWith("/report")) {
    return new Response(service.reportHtml, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (path.endsWith("/report.pdf")) {
    return new Response(service.pdf, { status: 200, headers: { "content-type": "application/pdf" } });
  }
  return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
};

const resetService = () => {
  service.state = "analyzing";
  service.reportHtml =
    '<html><head><link rel="stylesheet" href="/static/report_v2.css"></head><body>' +
    '<a href="/audit/story-token-1/report.pdf">PDF</a></body></html>';
  service.calls = [];
  service.fail = false;
};

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.startsWith("https://audit.example")) return serviceFetch(target, init);
  return telegramOk(target);
};

const call = (env, path, { method = "GET", body, cookie, origin, ip = "203.0.113.5" } = {}) => {
  const headers = { "cf-connecting-ip": ip };
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const url = new URL(`https://narrativeintelligence.ru${path}`);
  return handleAudit(
    new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env,
    url.pathname,
  );
};

const startBody = (url = "https://example.com") => ({ url });
const freshEnv = async () => ({ ...ENV, AUDIT_KV: makeKv() });
const liveEnv = () => ({
  ...ENV,
  AUDIT_ENGINE: "live",
  AUDIT_SERVICE_URL: "https://audit.example",
  AUDIT_INTERNAL_TOKEN: "internal-secret",
  AUDIT_KV: makeKv(),
});

console.log("валидация URL");

await check("принимает адрес без схемы и с www", () => {
  const parsed = auditInternals.siteUrl("example.com");
  assert(parsed && parsed.hostname === "example.com", "без схемы не принят");
  const withWww = auditInternals.siteUrl("https://www.example.com/path");
  assert(withWww.hostname === "www.example.com", "путь потерялся");
});

await check("отклоняет мусор, localhost и javascript:", () => {
  for (const bad of ["", "не url", "localhost", "http://", "javascript:alert(1)", "https://a b c", "ftp://example.com"]) {
    assert(!auditInternals.siteUrl(bad), `приняли плохой адрес: ${bad}`);
  }
});

console.log("\nтелефон");

await check("телефон нормализуется к +7", () => {
  assert(auditInternals.normalizePhone("+7 999 123-45-67") === "+79991234567", "формат +7");
  assert(auditInternals.normalizePhone("8 (999) 123-45-67") === "+79991234567", "формат 8");
  assert(auditInternals.normalizePhone("9991234567") === "+79991234567", "10 цифр");
  assert(auditInternals.normalizePhone("12345") === null, "короткий принят");
  assert(auditInternals.normalizePhone("") === null, "пустой принят");
});

console.log("\nзапуск (stub)");

await check("валидный адрес → задача и cookie устройства", async () => {
  const env = await freshEnv();
  const res = await call(env, "/api/audit/start", { method: "POST", body: startBody() });
  const data = await res.json();
  assert(res.status === 200 && data.ok, `статус ${res.status} ${JSON.stringify(data)}`);
  assert(/^[a-f0-9]{24}$/.test(data.job.id), `id: ${data.job.id}`);
  assert(res.headers.get("set-cookie").includes("nia_audit_dev="), "нет cookie устройства");
  assert((await env.AUDIT_KV.get(`job:${data.job.id}`)) !== null, "задача не сохранена");
});

await check("повторный запуск с того же устройства → 429", async () => {
  const env = await freshEnv();
  const first = await call(env, "/api/audit/start", { method: "POST", body: startBody() });
  const cookie = first.headers.get("set-cookie").split(";")[0];
  const second = await call(env, "/api/audit/start", {
    method: "POST",
    body: startBody("https://other.example"),
    cookie,
  });
  const data = await second.json();
  assert(second.status === 429, `статус ${second.status}`);
  assert(data.code === "device_used", `code: ${data.code}`);
});

await check("лимит 8 запусков с одного IP", async () => {
  const env = await freshEnv();
  for (let i = 0; i < 8; i += 1) {
    const res = await call(env, "/api/audit/start", { method: "POST", body: startBody(`https://site${i}.example`) });
    assert(res.status === 200, `запуск ${i + 1} упал: ${res.status}`);
  }
  const ninth = await call(env, "/api/audit/start", { method: "POST", body: startBody("https://site9.example") });
  const data = await ninth.json();
  assert(ninth.status === 429 && data.code === "ip_limit", `ожидали ip_limit, получили ${ninth.status} ${data.code}`);
});

await check("мусорный адрес сайта → 400", async () => {
  const env = await freshEnv();
  const res = await call(env, "/api/audit/start", { method: "POST", body: { url: "localhost" } });
  assert(res.status === 400, `статус ${res.status}`);
});

await check("чужой origin → 403", async () => {
  const env = await freshEnv();
  const res = await call(env, "/api/audit/start", {
    method: "POST",
    body: startBody(),
    origin: "https://evil.example",
  });
  assert(res.status === 403, `статус ${res.status}`);
});

console.log("\nстатус (stub)");

await check("неизвестный id → 404", async () => {
  const env = await freshEnv();
  const res = await call(env, "/api/audit/status?id=deadbeefdeadbeefdeadbeef");
  assert(res.status === 404, `статус ${res.status}`);
});

await check("stub: сразу queued, через 45 c — done", async () => {
  const env = await freshEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: startBody() })).json();
  const id = started.job.id;

  const first = await (await call(env, `/api/audit/status?id=${id}`)).json();
  assert(first.job.status === "queued", `сразу: ${first.job.status}`);

  const job = JSON.parse(await env.AUDIT_KV.get(`job:${id}`));
  job.createdAt = Date.now() - 45_000;
  await env.AUDIT_KV.put(`job:${id}`, JSON.stringify(job));

  const second = await (await call(env, `/api/audit/status?id=${id}`)).json();
  assert(second.job.status === "done", `через 45 c: ${second.job.status}`);
  assert(second.job.stub === true, "флаг демо-режима потерялся");
});

console.log("\nконтакты (stub)");

async function readyJob(env) {
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: startBody() })).json();
  const job = JSON.parse(await env.AUDIT_KV.get(`job:${started.job.id}`));
  job.createdAt = Date.now() - 45_000;
  job.status = "done";
  await env.AUDIT_KV.put(`job:${job.id}`, JSON.stringify(job));
  return job.id;
}

await check("до готовности → 409", async () => {
  const env = await freshEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: startBody() })).json();
  const res = await call(env, "/api/audit/reveal", {
    method: "POST",
    body: { id: started.job.id, name: "Иван", email: "a@b.co", phone: "+79991234567", consent: true },
  });
  assert(res.status === 409, `статус ${res.status}`);
});

await check("валидация контактов", async () => {
  const env = await freshEnv();
  const id = await readyJob(env);
  const cases = [
    [{ name: "", email: "a@b.co", phone: "+79991234567", consent: true }, "пустое имя"],
    [{ name: "Иван", email: "плохо", phone: "+79991234567", consent: true }, "плохой email"],
    [{ name: "Иван", email: "a@b.co", phone: "123", consent: true }, "короткий телефон"],
    [{ name: "Иван", email: "a@b.co", phone: "+79991234567", consent: false }, "нет согласия"],
  ];
  for (const [body, label] of cases) {
    const res = await call(env, "/api/audit/reveal", { method: "POST", body: { id, ...body } });
    assert(res.status === 400, `${label}: статус ${res.status}`);
  }
});

await check("успешная выдача контактов + уведомление в Telegram", async () => {
  const env = await freshEnv();
  const id = await readyJob(env);
  telegram.length = 0;
  const res = await call(env, "/api/audit/reveal", {
    method: "POST",
    body: { id, name: "Иван Петров", email: "Client@Example.com", phone: "8 999 123-45-67", consent: true },
  });
  const data = await res.json();
  assert(res.status === 200 && data.ok, `статус ${res.status} ${JSON.stringify(data)}`);
  assert(telegram.length === 1, `уведомлений: ${telegram.length}`);
  const job = JSON.parse(await env.AUDIT_KV.get(`job:${id}`));
  assert(job.contacted.email === "client@example.com", `email не нормализован: ${job.contacted.email}`);
  assert(job.contacted.phone === "+79991234567", `телефон: ${job.contacted.phone}`);
});

await check("повторный запрос с тем же email → 429", async () => {
  const env = await freshEnv();
  const first = await readyJob(env);
  await call(env, "/api/audit/reveal", {
    method: "POST",
    body: { id: first, name: "Иван", email: "same@example.com", phone: "+79991234567", consent: true },
  });

  const second = await readyJob(env);
  const res = await call(env, "/api/audit/reveal", {
    method: "POST",
    body: { id: second, name: "Пётр", email: "SAME@example.com", phone: "+79997654321", consent: true },
  });
  const data = await res.json();
  assert(res.status === 429, `статус ${res.status}`);
  assert(data.code === "email_used", `code: ${data.code}`);
});

await check("повторная отправка по той же задаче → 409", async () => {
  const env = await freshEnv();
  const id = await readyJob(env);
  const body = { id, name: "Иван", email: "once@example.com", phone: "+79991234567", consent: true };
  await call(env, "/api/audit/reveal", { method: "POST", body });
  const res = await call(env, "/api/audit/reveal", { method: "POST", body });
  assert(res.status === 409, `статус ${res.status}`);
});

await check("без KV → 500", async () => {
  const res = await call({ ...ENV, AUDIT_KV: null }, "/api/audit/start", { method: "POST", body: startBody() });
  assert(res.status === 500, `статус ${res.status}`);
});

console.log("\nквота события");

await check("21-я заявка на событие принимается вручную, без движка", async () => {
  const env = await freshEnv();
  for (let i = 0; i < 20; i += 1) {
    const res = await call(env, "/api/audit/start", {
      method: "POST",
      body: { url: `https://site${i}.example`, ev: "event-a" },
      ip: `198.51.100.${i + 1}`,
    });
    assert(res.status === 200, `запуск ${i + 1} упал: ${res.status}`);
  }
  const extra = await call(env, "/api/audit/start", {
    method: "POST",
    body: { url: "https://site99.example", ev: "event-a" },
    ip: "198.51.100.200",
  });
  const data = await extra.json();
  assert(extra.status === 200, `статус ${extra.status}`);
  assert(data.job.status === "manual", `статус задачи: ${data.job.status}`);
});

await check("квота считается по метке события отдельно", async () => {
  const env = await freshEnv();
  for (let i = 0; i < 21; i += 1) {
    await call(env, "/api/audit/start", {
      method: "POST",
      body: { url: "https://x.example", ev: "event-a" },
      ip: `198.51.100.${i + 1}`,
    });
  }
  const other = await call(env, "/api/audit/start", {
    method: "POST",
    body: { url: "https://y.example", ev: "event-b" },
    ip: "203.0.113.99",
  });
  const data = await other.json();
  assert(data.job.status !== "manual", `событие B не должно упираться в квоту A: ${data.job.status}`);
});

console.log("\nstoryaudit (live)");

await check("создание идёт в сервис с внутренним токеном и IP клиента", async () => {
  resetService();
  const env = liveEnv();
  const res = await call(env, "/api/audit/start", {
    method: "POST",
    body: { url: "https://client.example", ev: "e1" },
    ip: "203.0.113.42",
  });
  const data = await res.json();
  assert(res.status === 200 && data.ok, `статус ${res.status} ${JSON.stringify(data)}`);
  const create = service.calls.find((entry) => entry.path === "/audit");
  assert(create, "POST /audit не вызван");
  assert(create.headers["x-internal-token"] === "internal-secret", "нет внутреннего токена");
  assert(create.headers["x-forwarded-for"] === "203.0.113.42", `XFF: ${create.headers["x-forwarded-for"]}`);
  assert(create.headers["x-client-ip"] === "203.0.113.42", `x-client-ip: ${create.headers["x-client-ip"]}`);
  const stored = JSON.parse(await env.AUDIT_KV.get(`job:${data.job.id}`));
  assert(stored.externalId === "story-token-1", `externalId: ${stored.externalId}`);
  assert(stored.status === "queued", `статус: ${stored.status}`);
});

await check("состояния сервиса: analyzing→running, review→review, ready→done", async () => {
  resetService();
  const env = liveEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: { url: "https://a.example" } })).json();
  const id = started.job.id;

  service.state = "analyzing";
  let job = await (await call(env, `/api/audit/status?id=${id}`)).json();
  assert(job.job.status === "running", `analyzing → ${job.job.status}`);

  service.state = "review";
  job = await (await call(env, `/api/audit/status?id=${id}`)).json();
  assert(job.job.status === "review", `review → ${job.job.status}`);

  service.state = "ready";
  job = await (await call(env, `/api/audit/status?id=${id}`)).json();
  assert(job.job.status === "done", `ready → ${job.job.status}`);
});

await check("готовый отчёт забирается и переписывается на наш адрес", async () => {
  resetService();
  const env = liveEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: { url: "https://a.example" } })).json();
  const id = started.job.id;
  service.state = "ready";
  await call(env, `/api/audit/status?id=${id}`);

  const stored = JSON.parse(await env.AUDIT_KV.get(`job:${id}`));
  assert(stored.reportToken, "reportToken не сохранён");
  const report = JSON.parse(await env.AUDIT_KV.get(`report:${stored.reportToken}`));
  assert(report.html.includes(`/r/${stored.reportToken}/report.pdf`), "ссылка на PDF не переписана");
  assert(!report.html.includes("/audit/story-token-1/"), "остались ссылки на домен сервиса");
});

await check("статус не отдаёт ссылку на отчёт до контактов", async () => {
  resetService();
  const env = liveEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: { url: "https://a.example" } })).json();
  service.state = "ready";
  const job = await (await call(env, `/api/audit/status?id=${started.job.id}`)).json();
  assert(job.job.reportUrl === null, `reportUrl просочился: ${job.job.reportUrl}`);
});

await check("reveal отдаёт ссылку /r/<token>/", async () => {
  resetService();
  const env = liveEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: { url: "https://a.example" } })).json();
  const id = started.job.id;
  service.state = "ready";
  await call(env, `/api/audit/status?id=${id}`);

  const res = await call(env, "/api/audit/reveal", {
    method: "POST",
    body: { id, name: "Иван", email: "live@example.com", phone: "+79991234567", consent: true },
  });
  const data = await res.json();
  assert(res.status === 200 && data.ok, `статус ${res.status} ${JSON.stringify(data)}`);
  assert(/^\/r\/[a-f0-9]{32}\/$/.test(data.reportUrl || ""), `reportUrl: ${data.reportUrl}`);
});

await check("страница отчёта отдаётся с noindex и нашей PDF-ссылкой", async () => {
  resetService();
  const env = liveEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: { url: "https://a.example" } })).json();
  service.state = "ready";
  await call(env, `/api/audit/status?id=${started.job.id}`);
  const stored = JSON.parse(await env.AUDIT_KV.get(`job:${started.job.id}`));

  const page = await handleReport(
    new Request(`https://narrativeintelligence.ru/r/${stored.reportToken}/`),
    env,
    `/r/${stored.reportToken}/`,
  );
  assert(page.status === 200, `статус ${page.status}`);
  assert(page.headers.get("x-robots-tag") === "noindex, nofollow", "нет noindex");
  const html = await page.text();
  assert(html.includes(`/r/${stored.reportToken}/report.pdf`), "PDF-ссылка не наша");
});

await check("PDF проксируется из сервиса", async () => {
  resetService();
  const env = liveEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: { url: "https://a.example" } })).json();
  service.state = "ready";
  await call(env, `/api/audit/status?id=${started.job.id}`);
  const stored = JSON.parse(await env.AUDIT_KV.get(`job:${started.job.id}`));

  const pdf = await handleReport(
    new Request(`https://narrativeintelligence.ru/r/${stored.reportToken}/report.pdf`),
    env,
    `/r/${stored.reportToken}/report.pdf`,
  );
  assert(pdf.status === 200, `статус ${pdf.status}`);
  assert(pdf.headers.get("content-type") === "application/pdf", "не PDF");
});

await check("неизвестный токен отчёта → 404", async () => {
  const env = liveEnv();
  const res = await handleReport(
    new Request("https://narrativeintelligence.ru/r/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"),
    env,
    "/r/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
  );
  assert(res.status === 404, `статус ${res.status}`);
});

await check("сбой сервиса не убивает заявку с первого раза", async () => {
  resetService();
  const env = liveEnv();
  const started = await (await call(env, "/api/audit/start", { method: "POST", body: { url: "https://a.example" } })).json();
  const id = started.job.id;
  service.fail = true;
  const first = await (await call(env, `/api/audit/status?id=${id}`)).json();
  assert(first.job.status === "queued", `после одной ошибки статус должен остаться прежним: ${first.job.status}`);
  for (let i = 0; i < 4; i += 1) await call(env, `/api/audit/status?id=${id}`);
  const after = await (await call(env, `/api/audit/status?id=${id}`)).json();
  assert(after.job.status === "failed", `после пяти ошибок: ${after.job.status}`);
});

await check("неизвестный метод API → 404", async () => {
  const env = await freshEnv();
  const res = await call(env, "/api/audit/nope", { method: "POST" });
  assert(res.status === 404, `статус ${res.status}`);
});

globalThis.fetch = realFetch;
console.log(failed === 0 ? "\nвсе проверки прошли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
