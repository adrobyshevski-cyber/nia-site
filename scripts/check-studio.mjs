/**
 * Тесты /studio: front matter, пароль, сессия, лимит попыток, маршруты.
 * Сеть подменяется заглушкой — GitHub не вызывается.
 *
 * Запуск: node scripts/check-studio.mjs
 */

import { createHash } from "node:crypto";
import { handleStudio } from "../lib/studio.js";
import { parseArticleFile, stringifyArticleFile, validateFrontMatter } from "../lib/frontmatter.js";
import { checkRateLimit, registerFailure, verifyPassword } from "../lib/auth.js";

const PASSWORD = "test-password-123";
const SALT = Buffer.from("0123456789abcdef");
const HASH = createHash("sha256").update(Buffer.concat([SALT, Buffer.from(PASSWORD)])).digest("base64");
const ENV = {
  ADMIN_PASSWORD_HASH: `sha256$${SALT.toString("base64")}$${HASH}`,
  SESSION_SECRET: "test-session-secret",
  GITHUB_TOKEN: "test-github-token",
};

let failed = 0;
const calls = [];

async function check(name, fn) {
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

// ---------- заглушка GitHub ----------
const SAMPLE = `---
title: "Тестовая статья"
slug: "test-article"
description: Описание
  в две строки
lead: "Лид"
category: "Narrative Economics"
date: "2026-12-01"
author: "NIA Editorial"
featured: true
draft: true
practice: "/audit/"
practice_label: "Аудит"
---

Первый абзац.

## Подзаголовок

Текст статьи.`;

const realFetch = globalThis.fetch;
function mockGithub() {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/contents/content/articles") && method === "GET") {
      return new Response(JSON.stringify([{ name: "test-article.md", type: "file", sha: "sha1", size: SAMPLE.length }]), { status: 200 });
    }
    if (url.endsWith("/contents/content/articles/test-article.md") && method === "GET") {
      return new Response(
        JSON.stringify({ content: Buffer.from(SAMPLE, "utf8").toString("base64"), sha: "sha1" }),
        { status: 200 },
      );
    }
    if (method === "PUT") {
      return new Response(JSON.stringify({ content: { sha: "sha2" }, commit: { sha: "commit2" } }), { status: 200 });
    }
    if (method === "DELETE") {
      return new Response(JSON.stringify({ commit: { sha: "commit3" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
}

const cookies = {};
async function studio(path, { method = "GET", body, cookie, origin } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  headers["cf-connecting-ip"] = "203.0.113.10";
  const request = new Request(`https://narrativeintelligence.ru${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await handleStudio(request, ENV, {
    serveAsset: async () => new Response("<html>page</html>", { status: 200 }),
  });
  return response;
}

const login = async (password = PASSWORD) => {
  const response = await studio("/studio/login", { method: "POST", body: { password }, origin: "https://narrativeintelligence.ru" });
  const setCookie = response.headers.get("set-cookie") || "";
  const token = /nia_studio=([^;]*)/.exec(setCookie)?.[1] || "";
  return { response, token, setCookie };
};

console.log("front matter");

await check("разбирает файл с folded-описанием", () => {
  const { frontMatter, body } = parseArticleFile(SAMPLE);
  assert(frontMatter.title === "Тестовая статья", `title: ${frontMatter.title}`);
  assert(frontMatter.description === "Описание в две строки", `description: ${frontMatter.description}`);
  assert(frontMatter.featured === true, "featured должен стать boolean");
  assert(frontMatter.draft === true, "draft должен стать boolean");
  assert(body.startsWith("Первый абзац."), "тело статьи потерялось");
});

await check("round-trip: строки с кавычками и переносами не ломаются", () => {
  const frontMatter = {
    title: 'Статья с "кавычками" и : двоеточием',
    slug: "x-1",
    description: "Описание",
    lead: "Лид",
    category: "C",
    date: "2026-12-01",
    author: "A",
    practice: "/audit/",
    practice_label: "P",
    draft: false,
    featured: true,
  };
  const parsed = parseArticleFile(stringifyArticleFile(frontMatter, "Тело"));
  assert(parsed.frontMatter.title === frontMatter.title, `title: ${parsed.frontMatter.title}`);
  assert(parsed.frontMatter.draft === false, "draft false потерялся");
  assert(parsed.frontMatter.featured === true, "featured true потерялся");
  assert(parsed.body === "Тело", "тело не совпало");
});

await check("валидация ловит пустые поля, кривой slug и дату", () => {
  const errors = validateFrontMatter({ slug: "Плохой Slug", date: "01.12.2026", title: "", description: "x" });
  assert(errors.some((e) => e.includes("slug")), "slug не проверен");
  assert(errors.some((e) => e.includes("date")), "date не проверен");
  assert(errors.some((e) => e.includes("title")), "пустой title не проверен");
});

console.log("\nаутентификация");

await check("верный пароль проходит", async () => {
  assert(await verifyPassword(PASSWORD, ENV.ADMIN_PASSWORD_HASH), "пароль не принят");
});

await check("неверный пароль и мусорный хеш отклоняются", async () => {
  assert(!(await verifyPassword("nope", ENV.ADMIN_PASSWORD_HASH)), "чужой пароль принят");
  assert(!(await verifyPassword(PASSWORD, "sha256$bad")), "битый хеш принят");
  assert(!(await verifyPassword(PASSWORD, "")), "пустой хеш принят");
});

await check("cookie: HttpOnly, Secure, SameSite=Strict, Path=/", async () => {
  mockGithub();
  const { setCookie } = await login();
  assert(/HttpOnly/i.test(setCookie), "нет HttpOnly");
  assert(/Secure/i.test(setCookie), "нет Secure");
  assert(/SameSite=Strict/i.test(setCookie), "нет SameSite=Strict");
  assert(/Path=\//.test(setCookie), "нет Path=/");
});

await check("подделанная подпись сессии не принимается", async () => {
  mockGithub();
  const { token } = await login();
  const [expires, signature] = token.split(".");
  const forged = `${expires}.${signature.slice(0, -2)}xx`;
  const response = await studio("/studio/api/articles", { cookie: `nia_studio=${forged}` });
  assert(response.status === 401, `ожидали 401, получили ${response.status}`);
});

await check("истёкшая сессия не принимается", async () => {
  mockGithub();
  const { token } = await login();
  const [, signature] = token.split(".");
  const expired = `${Date.now() - 1000}.${signature}`;
  const response = await studio("/studio/api/articles", { cookie: `nia_studio=${expired}` });
  assert(response.status === 401, `ожидали 401, получили ${response.status}`);
});

await check("неверный пароль на /studio/login → 401", async () => {
  mockGithub();
  const { response, token } = await login("не тот пароль");
  assert(response.status === 401, `ожидали 401, получили ${response.status}`);
  assert(!token, "не должно быть cookie при ошибке");
});

await check("лимит попыток входа срабатывает", () => {
  const ip = "198.51.100.77";
  for (let i = 0; i < 8; i += 1) registerFailure(ip, Date.now());
  const limit = checkRateLimit(ip, Date.now());
  assert(!limit.allowed, "после 8 попыток должен быть блок");
  assert(limit.retryAfter > 0, "должен быть retryAfter");
});

console.log("\nмаршруты");

await check("без сессии список статей → 401", async () => {
  mockGithub();
  const response = await studio("/studio/api/articles");
  assert(response.status === 401, `ожидали 401, получили ${response.status}`);
});

await check("с сессией список статей отдаётся", async () => {
  mockGithub();
  const { token } = await login();
  const response = await studio("/studio/api/articles", { cookie: `nia_studio=${token}` });
  const data = await response.json();
  assert(response.status === 200, `статус ${response.status}`);
  assert(data.articles.length === 1, `статей: ${data.articles.length}`);
  assert(data.articles[0].slug === "test-article", "slug не тот");
  assert(data.articles[0].draft === true, "draft не распознан");
});

await check("мутация с чужого origin → 403", async () => {
  mockGithub();
  const { token } = await login();
  const response = await studio("/studio/api/article", {
    method: "POST",
    cookie: `nia_studio=${token}`,
    origin: "https://evil.example",
    body: { frontMatter: { title: "x" }, body: "y", action: "draft" },
  });
  assert(response.status === 403, `ожидали 403, получили ${response.status}`);
});

await check("сохранение черновика создаёт коммит с draft: true", async () => {
  mockGithub();
  const { token } = await login();
  const response = await studio("/studio/api/article", {
    method: "POST",
    cookie: `nia_studio=${token}`,
    origin: "https://narrativeintelligence.ru",
    body: {
      frontMatter: {
        title: "Черновик",
        slug: "draft-one",
        description: "Описание",
        lead: "Лид",
        category: "C",
        date: "2026-12-01",
        author: "A",
        practice: "/audit/",
        practice_label: "P",
      },
      body: "Короткий текст черновика.",
      action: "draft",
    },
  });
  const data = await response.json();
  assert(response.status === 200 && data.ok, `статус ${response.status} ${JSON.stringify(data)}`);
  const put = calls.find((c) => c.method === "PUT");
  assert(put, "запрос в GitHub не ушёл");
  assert(put.url.includes("draft-one.md"), "неверный путь файла");
  const content = Buffer.from(put.body.content, "base64").toString("utf8");
  assert(content.includes("draft: true"), "в файле нет draft: true");
  assert(content.includes('title: "Черновик"'), "заголовок не записан");
});

await check("публикация требует текст ≥ 150 символов", async () => {
  mockGithub();
  const { token } = await login();
  const response = await studio("/studio/api/article", {
    method: "POST",
    cookie: `nia_studio=${token}`,
    origin: "https://narrativeintelligence.ru",
    body: {
      frontMatter: {
        title: "Мало текста",
        slug: "too-short",
        description: "Описание",
        lead: "Лид",
        category: "C",
        date: "2026-12-01",
        author: "A",
        practice: "/audit/",
        practice_label: "P",
      },
      body: "коротко",
      action: "publish",
    },
  });
  assert(response.status === 400, `ожидали 400, получили ${response.status}`);
  assert(!calls.some((c) => c.method === "PUT"), "коммит не должен создаваться");
});

await check("переименование slug: новый файл + удаление старого", async () => {
  mockGithub();
  const { token } = await login();
  const response = await studio("/studio/api/article", {
    method: "POST",
    cookie: `nia_studio=${token}`,
    origin: "https://narrativeintelligence.ru",
    body: {
      originalSlug: "test-article",
      frontMatter: {
        title: "Переименованная",
        slug: "renamed-article",
        description: "Описание",
        lead: "Лид",
        category: "C",
        date: "2026-12-01",
        author: "A",
        practice: "/audit/",
        practice_label: "P",
      },
      body: "Достаточно длинный текст для сохранения статьи.",
      action: "draft",
    },
  });
  assert(response.status === 200, `статус ${response.status}`);
  assert(calls.some((c) => c.method === "PUT" && c.url.includes("renamed-article.md")), "новый файл не создан");
  assert(calls.some((c) => c.method === "DELETE" && c.url.includes("test-article.md")), "старый файл не удалён");
});

await check("страница /studio отдаётся ассетом (вход в том же документе)", async () => {
  mockGithub();
  const response = await studio("/studio/");
  const html = await response.text();
  assert(response.status === 200, `статус ${response.status}`);
  assert(html.includes("page"), "ассет не запрошен");
});

await check("/studio редиректит на /studio/", async () => {
  mockGithub();
  const response = await studio("/studio");
  assert(response.status === 301, `статус ${response.status}`);
  assert(response.headers.get("location") === "/studio/", "неверный Location");
});

globalThis.fetch = realFetch;
console.log(failed === 0 ? "\nвсе проверки прошли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
