/**
 * Локальная проверка /api/lead без сети: fetch подменяется заглушкой.
 * Запуск: npm run check
 */

import { onRequestPost, onRequest } from "../functions/api/lead.js";

const calls = [];
const realFetch = globalThis.fetch;

function mockFetch({ web3formsStatus = 200, telegramStatus = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.includes("web3forms")) {
      return new Response(JSON.stringify({ success: web3formsStatus === 200 }), { status: web3formsStatus });
    }
    if (url.includes("telegram")) {
      return new Response(JSON.stringify({ ok: telegramStatus === 200 }), { status: telegramStatus });
    }
    return new Response("unexpected", { status: 500 });
  };
}

const ENV = { WEB3FORMS_KEY: "test-key", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" };

function post(payload) {
  const isForm = payload instanceof FormData;
  return onRequestPost({
    request: new Request("https://narrativeintelligence.ru/api/lead", {
      method: "POST",
      headers: isForm
        ? { referer: "https://narrativeintelligence.ru/audit/" }
        : { "content-type": "application/json", referer: "https://narrativeintelligence.ru/audit/" },
      body: isForm ? payload : JSON.stringify(payload),
    }),
    env: ENV,
  });
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

console.log("POST /api/lead");

await check("валидная заявка на аудит уходит в оба канала", async () => {
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
  assert(calls.length === 2, `ожидали 2 канала, получили ${calls.length}`);
  const mail = calls.find((c) => c.url.includes("web3forms")).body;
  assert(mail.replyto === "client@example.com", "replyto должен быть адресом клиента");
  assert(mail.subject.includes("аудит"), "тема письма должна указывать на аудит");
  const tg = calls.find((c) => c.url.includes("telegram")).body;
  assert(tg.chat_id === "42", "chat_id не совпадает");
  assert(tg.text.includes("example.com"), "в уведомлении нет сайта");
});

await check("пустой email отклоняется без отправки", async () => {
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
  assert(calls.length === 2, "должны уйти оба канала");
});

await check("без поля elapsed (нет JS) заявка доставляется", async () => {
  mockFetch();
  const res = await post({ kind: "contact", email: "a@b.co", message: "x" });
  const body = await res.json();
  assert(res.status === 200 && body.ok, `ожидали 200/ok, получили ${res.status}`);
  assert(calls.length === 2, "должны уйти оба канала");
});

await check("падение Web3Forms не теряет заявку (Telegram сработал)", async () => {
  mockFetch({ web3formsStatus: 500 });
  const res = await post({ kind: "contact", email: "a@b.co", message: "x", elapsed: 9000 });
  const body = await res.json();
  assert(res.status === 200 && body.ok, `ожидали успех через Telegram, получили ${res.status}`);
});

await check("оба канала упали → 502", async () => {
  mockFetch({ web3formsStatus: 500, telegramStatus: 403 });
  const res = await post({ kind: "contact", email: "a@b.co", message: "x", elapsed: 9000 });
  const body = await res.json();
  assert(res.status === 502 && !body.ok, `ожидали 502, получили ${res.status}`);
  assert(body.error.includes("niaagency@yandex.com"), "в ошибке должен быть запасной email");
});

await check("без переменных окружения → 502 (форма не врёт об успехе)", async () => {
  mockFetch();
  const res = await onRequestPost({
    request: new Request("https://narrativeintelligence.ru/api/lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "contact", email: "a@b.co", message: "x", elapsed: 9000 }),
    }),
    env: {},
  });
  assert(res.status === 502, `ожидали 502, получили ${res.status}`);
  assert(calls.length === 0, "без ключей сеть не нужна");
});

await check("GET → 405", async () => {
  const res = await onRequest({ request: new Request("https://narrativeintelligence.ru/api/lead") });
  assert(res.status === 405, `ожидали 405, получили ${res.status}`);
});

globalThis.fetch = realFetch;
console.log(failed === 0 ? "\nвсе проверки прошли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
