/**
 * Тесты импорта статьи из файла (public/studio/import.js).
 * Скрипт браузерный, поэтому грузим его в песочницу с заглушкой window.
 *
 * Запуск: node scripts/check-import.mjs
 */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const code = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "studio", "import.js"), "utf8");
const sandbox = { window: {}, console };
vm.runInNewContext(code, sandbox);
const { parseDocument, slugify } = sandbox.window.NiaImport;

const TODAY = "2026-11-26";
let failed = 0;

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

const parse = (text, options = {}) => parseDocument(text, { today: TODAY, ...options });

console.log("импорт из файла");

await check("front matter: всё берётся из файла", () => {
  const md = `---
title: "Готовая статья"
slug: "ready-article"
description: "Описание из файла"
lead: "Лид из файла"
category: "Narrative Economics"
category_ru: "Диагностика"
date: "2026-12-01"
author: "Автор"
featured: true
draft: false
practice: "/audit/"
practice_label: "Аудит"
---

# Готовая статья

Первый абзац текста про нарратив и ценность.

Второй абзац.`;
  const r = parse(md);
  assert(r.frontMatter.title === "Готовая статья", `title: ${r.frontMatter.title}`);
  assert(r.frontMatter.date === "2026-12-01", `date: ${r.frontMatter.date}`);
  assert(r.frontMatter.featured === true, "featured не распознан");
  assert(r.frontMatter.draft === false, "draft не распознан");
  assert(r.sources.title === "file", `source title: ${r.sources.title}`);
  assert(r.body.includes("Первый абзац"), "тело потерялось");
});

await check("паспорт: русские ключи и дата ДД.ММ.ГГГГ", () => {
  const md = `Заголовок: Смысловой долг бренда
Описание: Коротко о том, почему обещания расходятся с опытом.
Лид: Вступление для первого экрана.
Категория: Brands & Markets
Дата: 12.03.2026
Автор: Иван Петров

Основной текст статьи идёт после паспорта. Он достаточно длинный, чтобы пройти проверку минимальной длины: сто пятьдесят символов и больше.

## Подзаголовок

Ещё абзац.`;
  const r = parse(md);
  assert(r.frontMatter.title === "Смысловой долг бренда", `title: ${r.frontMatter.title}`);
  assert(r.frontMatter.date === "2026-03-12", `date: ${r.frontMatter.date}`);
  assert(r.sources.date === "passport", `source date: ${r.sources.date}`);
  assert(r.frontMatter.practice === "/brand/", `practice: ${r.frontMatter.practice}`);
  assert(r.frontMatter.practice_label === "Dissolved Brand", `label: ${r.frontMatter.practice_label}`);
  assert(!r.body.includes("Заголовок:"), "паспорт попал в тело");
  assert(r.body.includes("Основной текст"), "тело потерялось");
});

await check("без метаданных: H1 → заголовок, первый абзац → лид", () => {
  const md = `# Из чего складывается доверие

Доверие к бренду формируется из повторяемого опыта, а не из обещаний. Этот абзац объясняет мысль подробнее.

## Разбор

Второй абзац с аргументами и примерами.`;
  const r = parse(md);
  assert(r.frontMatter.title === "Из чего складывается доверие", `title: ${r.frontMatter.title}`);
  assert(r.frontMatter.lead.startsWith("Доверие к бренду"), `lead: ${r.frontMatter.lead}`);
  assert(!r.body.startsWith("# "), "H1 остался в теле — задвоится с заголовком страницы");
  assert(r.sources.title === "heuristic", "источник заголовка должен быть эвристикой");
});

await check("slug из транслита заголовка", () => {
  const r = parse("# Как компании накапливают смысловой долг\n\nТекст статьи длиной более ста пятидесяти символов, чтобы пройти проверку: " + "слово ".repeat(30));
  assert(r.frontMatter.slug === "kak-kompanii-nakaplivayut-smyslovoy-dolg", `slug: ${r.frontMatter.slug}`);
});

await check("slugify убирает мусор и ограничивает длину", () => {
  const slug = slugify("  Ёжик в тумане: 10 правил — и всё!  ");
  assert(/^[a-z0-9-]+$/.test(slug), `невалидный slug: ${slug}`);
  assert(slug.length <= 60, "длиннее 60 символов");
});

await check("занятый slug получает суффикс и предупреждение", () => {
  const r = parse("# Narrative Debt\n\n" + "текст ".repeat(40), { existingSlugs: ["narrative-debt"] });
  assert(r.frontMatter.slug === "narrative-debt-2", `slug: ${r.frontMatter.slug}`);
  assert(r.warnings.some((w) => w.text.includes("уже занят")), "нет предупреждения о занятом slug");
});

await check("категория угадывается по словам", () => {
  const r = parse("# Бренд и аудитория\n\nКлиенты становятся соавторами бренда, если им дают правила участия. " + "текст ".repeat(30));
  assert(r.frontMatter.category === "Brands & Markets", `category: ${r.frontMatter.category}`);
  assert(r.frontMatter.practice === "/brand/", `practice: ${r.frontMatter.practice}`);
  assert(r.sources.category === "heuristic", "источник категории должен быть эвристикой");
});

await check("короткий текст → ошибка, картинки → предупреждение", () => {
  const r = parse("# Заметка\n\nСлишком коротко. ![схема](/img/x.png)");
  assert(r.warnings.some((w) => w.level === "error" && w.text.includes("150")), "нет ошибки о длине");
  assert(r.warnings.some((w) => w.text.includes("картинки")), "нет предупреждения о картинках");
});

await check("непонятная дата → сегодняшняя и предупреждение", () => {
  const r = parse("Заголовок: Тест\nДата: первого декабря\n\n" + "текст ".repeat(40));
  assert(r.frontMatter.date === TODAY, `date: ${r.frontMatter.date}`);
  assert(r.warnings.some((w) => w.text.includes("Дата не распознана")), "нет предупреждения о дате");
});

await check("описание не длиннее 300 символов", () => {
  const lead = "Очень длинное вступление. ".repeat(20);
  const r = parse(`Заголовок: Длинный лид\nЛид: ${lead}\n\n` + "текст ".repeat(40));
  assert(r.frontMatter.description.length <= 301, `description: ${r.frontMatter.description.length} символов`);
  assert(r.warnings.every((w) => !w.text.includes("Описание длиннее")), "описание обрезано автоматически, ошибки быть не должно");
});

await check("текст без H1 и без точки → заголовок из первой строки", () => {
  const r = parse("Смыслы и деньги\n\nПервый абзац про экономику смыслов. " + "текст ".repeat(30));
  assert(r.frontMatter.title === "Смыслы и деньги", `title: ${r.frontMatter.title}`);
  assert(r.warnings.some((w) => w.text.includes("нет заголовка H1")), "нет предупреждения об отсутствии H1");
});

await check("пустой файл не падает", () => {
  const r = parse("");
  assert(r.frontMatter.draft === true, "по умолчанию должен быть черновик");
  assert(r.warnings.some((w) => w.level === "error"), "нет ошибки о пустом тексте");
});

console.log(failed === 0 ? "\nвсе проверки прошли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
