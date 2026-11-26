/**
 * Тесты /demo: лимиты, валидация, стейт-машина задач, выдача контактов.
 * KV и Telegram подменены — сеть не используется.
 *
 * Запуск: node scripts/check-audit.mjs
 */

import { handleAudit, auditInternals } from "../lib/audit.js";

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
globalThis.fetch = telegramOk;

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

console.log("\nтелефон и email");

await check("телефон нормализуется к +7", () => {
  assert(auditInternals.normalizePhone("+7 999 123-45-67") === "+79991234567", "формат +7");
  assert(auditInternals.normalizePhone("8 (999) 123-45-67") === "+79991234567", "формат 8");
  assert(auditInternals.normalizePhone("9991234567") === "+79991234567", "10 цифр");
  assert(auditInternals.normalizePhone("12345") === null, "короткий принят");
  assert(auditInternals.normalizePhone("") === null, "пустой принят");
});

console.log("\nзапуск аудита");

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

console.log("\nстатус");

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

console.log("\nконтакты");

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

await check("контакты сохраняются даже если Telegram недоступен", async () => {
  const env = await freshEnv();
  const id = await readyJob(env);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 403 });
  const res = await call(env, "/api/audit/reveal", {
    method: "POST",
    body: { id, name: "Иван", email: "offline@example.com", phone: "+79991234567", consent: true },
  });
  globalThis.fetch = telegramOk;
  assert(res.status === 200, `статус ${res.status}`);
  const job = JSON.parse(await env.AUDIT_KV.get(`job:${id}`));
  assert(job.contacted?.email === "offline@example.com", "контакты потерялись");
});

await check("неизвестный метод API → 404", async () => {
  const env = await freshEnv();
  const res = await call(env, "/api/audit/nope", { method: "POST" });
  assert(res.status === 404, `статус ${res.status}`);
});

await check("без KV → 500", async () => {
  const res = await call({ ...ENV, AUDIT_KV: null }, "/api/audit/start", { method: "POST", body: startBody() });
  assert(res.status === 500, `статус ${res.status}`);
});

globalThis.fetch = realFetch;
console.log(failed === 0 ? "\nвсе проверки прошли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
