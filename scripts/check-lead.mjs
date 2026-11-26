/**
 * Локальная проверка /api/lead без сети: fetch подменяется заглушкой.
 * Запуск: npm run check
 */

import { handleLead } from "../lib/lead.js";
import worker from "../worker.js";

const calls = [];
const realFetch = globalThis.fetch;

function mockFetch({ telegramStatus = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: telegramStatus === 200 }), { status: telegramStatus });
    }
    return new Response("unexpected", { status: 500 });
  };
}

const ENV = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" };

function post(payload, env = ENV) {
  const isForm = payload instanceof FormData;
  return handleLead(
    new Request("https://narrativeintelligence.ru/api/lead", {
      method: "POST",
      headers: isForm ? {} : { "content-type": "application/json" },
      body: isForm ? payload : JSON.stringify(payload),
    }),
    env,
  );
}

function requestWorker(request) {
  const assets = { fetch: async () => new Response("asset", { status: 200 }) };
  return worker.fetch(request, { ASSETS: assets });
}

let failed = 0;

async function check(name, fn) {
  calls.length = 0;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log("POST /api/lead (Telegram-канал)");

await check("валидная заявка на аудит уходит в Telegram", async () => {
  mockFetch();
  const res = await post({
    kind: "audit",
    email: "client@example.com",
    website: "https://example.com",
    message: "Нужен аудит",
    elapsed: 9000,
  });
  const body = await res.json();
  assert(res.status === 200 && body.ok, `ожидали 200/ok, получили ${res.status} ${JSON.stringify(body)}`);
  assert(calls.length === 1, `ожидали 1 запрос, получили ${calls.length}`);
  const tg = calls[0].body;
  assert(calls[0].url.includes("api.telegram.org"), "запрос должен идти в Telegram API");
  assert(tg.chat_id === "42", "chat_id не совпадает");
  assert(tg.parse_mode === "HTML", "parse_mode должен быть HTML");
  assert(tg.text.includes("Заявка на аудит"), "в уведомлении нет типа заявки");
  assert(tg.text.includes("example.com"), "в уведомлении нет сайта");
  assert(tg.text.includes("client@example.com"), "в уведомлении нет email");
});

await check("HTML в пользовательских данных экранируется", async () => {
  mockFetch();
  await post({ kind: "contact", email: "a@b.co", name: "<b>злой</b>", message: "x", elapsed: 9000 });
  const tg = calls[0].body;
  assert(!tg.text.includes("<b>злой"), "имя попало в разметку без экранирования");
  assert(tg.text.includes("&lt;b&gt;злой"), "ожидали экранированный вариант");
});

await check("некорректный email отклоняется без сети", async () => {
  mockFetch();
  const res = await post({ kind: "contact", email: "не-email", message: "Привет", elapsed: 9000 });
  assert(res.status === 400, `ожидали 400, получили ${res.status}`);
  assert(calls.length === 0, "сеть не должна вызываться");
});

await check("аудит без адреса сайта отклоняется", async () => {
  mockFetch();
  const res = await post({ kind: "audit", email: "a@b.co", elapsed: 9000 });
  assert(res.status === 400, `ожидали 400, получили ${res.status}`);
});

await check("контакт без сообщения отклоняется", async () => {
  mockFetch();
  const res = await post({ kind: "contact", email: "a@b.co", elapsed: 9000 });
  assert(res.status === 400, `ожидали 400, получили ${res.status}`);
});

await check("honeypot отвечает 200 и ничего не отправляет", async () => {
  mockFetch();
  const res = await post({ kind: "contact", email: "a@b.co", message: "x", botcheck: "bot", elapsed: 9000 });
  assert(res.status === 200, `ожидали 200, получили ${res.status}`);
  assert(calls.length === 0, "бот не должен порождать отправку");
});

await check("слишком быстрая отправка игнорируется", async () => {
  mockFetch();
  const res = await post({ kind: "contact", email: "a@b.co", message: "x", elapsed: 200 });
  assert(res.status === 200, `ожидали 200, получили ${res.status}`);
  assert(calls.length === 0, "мгновенную отправку не пересылаем");
});

await check("formData-отправка без JS работает", async () => {
  mockFetch();
  const fd = new FormData();
  fd.set("kind", "contact");
  fd.set("email", "nojs@example.com");
  fd.set("message", "Отправлено без JS");
  const res = await post(fd);
  assert(res.status === 200, `ожидали 200, получили ${res.status}`);
  assert(calls.length === 1, "уведомление должно уйти");
});

await check("без поля elapsed (нет JS) заявка доставляется", async () => {
  mockFetch();
  const res = await post({ kind: "contact", email: "a@b.co", message: "x" });
  const body = await res.json();
  assert(res.status === 200 && body.ok, `ожидали 200/ok, получили ${res.status}`);
});

await check("ошибка Telegram → 502 с понятной причиной", async () => {
  mockFetch({ telegramStatus: 403 });
  const res = await post({ kind: "contact", email: "a@b.co", message: "x", elapsed: 9000 });
  const body = await res.json();
  assert(res.status === 502 && !body.ok, `ожидали 502, получили ${res.status}`);
});

await check("без переменных окружения → 502 и никаких запросов", async () => {
  mockFetch();
  const res = await post({ kind: "contact", email: "a@b.co", message: "x", elapsed: 9000 }, {});
  assert(res.status === 502, `ожидали 502, получили ${res.status}`);
  assert(calls.length === 0, "без токена сеть не нужна");
});

await check("www → apex: 301 с сохранением пути и query", async () => {
  const res = await requestWorker(
    new Request("https://www.narrativeintelligence.ru/insights/?utm_source=x"),
  );
  assert(res.status === 301, `ожидали 301, получили ${res.status}`);
  assert(
    res.headers.get("location") === "https://narrativeintelligence.ru/insights/?utm_source=x",
    `Location: ${res.headers.get("location")}`,
  );
});

await check("apex не редиректится", async () => {
  const res = await requestWorker(new Request("https://narrativeintelligence.ru/audit/"));
  assert(res.status === 200, `ожидали 200, получили ${res.status}`);
});

await check("GET /api/lead → 405", async () => {
  const res = await requestWorker(new Request("https://narrativeintelligence.ru/api/lead"));
  assert(res.status === 405, `ожидали 405, получили ${res.status}`);
});

await check("неизвестный /api/* → 404 JSON, а не 404-страница", async () => {
  const res = await requestWorker(new Request("https://narrativeintelligence.ru/api/unknown"));
  assert(res.status === 404, `ожидали 404, получили ${res.status}`);
  assert((res.headers.get("content-type") || "").includes("application/json"), "ожидали JSON");
});

await check("остальные пути идут в ассеты", async () => {
  const res = await requestWorker(new Request("https://narrativeintelligence.ru/audit/"));
  const text = await res.text();
  assert(res.status === 200 && text === "asset", "запрос должен уйти в env.ASSETS.fetch");
});

await check("POST /api/lead через worker роутится в обработчик", async () => {
  mockFetch();
  const res = await requestWorker(
    new Request("https://narrativeintelligence.ru/api/lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "contact", email: "a@b.co", message: "x", elapsed: 9000 }),
    }),
  );
  assert(res.status === 502, `без секретов ожидали 502, получили ${res.status}`);
});

globalThis.fetch = realFetch;
console.log(failed === 0 ? "\nвсе проверки прошли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
