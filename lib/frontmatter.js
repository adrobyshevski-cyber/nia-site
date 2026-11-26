/**
 * Разбор и сериализация файла статьи (YAML front matter + Markdown).
 *
 * Собственный минимальный парсер вместо YAML-библиотеки: Worker не тянет
 * зависимости, а формат под нашим контролем. Понимает то, что реально
 * встречается в content/articles: скаляры в кавычках и без, переносы
 * (folded) для длинных значений, булевы флаги.
 */

export const REQUIRED_FIELDS = ["title", "slug", "description", "lead", "category", "date", "author", "practice", "practice_label"];
export const OPTIONAL_FIELDS = ["category_ru", "featured", "draft"];
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/** Разбирает файл статьи. Возвращает { frontMatter, body } или бросает ошибку. */
export function parseArticleFile(raw) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("нет YAML front matter между --- и ---");

  const frontMatter = {};
  let lastKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) {
      lastKey = pair[1];
      frontMatter[lastKey] = pair[2];
      continue;
    }
    if (lastKey && /^\s+\S/.test(line)) {
      // folded-перенос: длинное значение на нескольких строках
      frontMatter[lastKey] = `${frontMatter[lastKey]} ${line.trim()}`.trim();
      continue;
    }
    throw new Error(`не удалось разобрать строку front matter: ${line.slice(0, 40)}`);
  }

  const parsed = {};
  for (const [key, value] of Object.entries(frontMatter)) {
    if (value === "true" || value === "false") parsed[key] = value === "true";
    else parsed[key] = unquote(String(value));
  }

  return { frontMatter: parsed, body: match[2].replace(/^\s*\n/, "").trimEnd() };
}

const FIELDS_ORDER = [
  "title",
  "slug",
  "description",
  "lead",
  "category",
  "category_ru",
  "date",
  "author",
  "featured",
  "draft",
  "practice",
  "practice_label",
];

/** Собирает файл статьи. Значения строк кодируются JSON-escaped (валидный YAML). */
export function stringifyArticleFile(frontMatter, body) {
  const lines = ["---"];
  for (const key of FIELDS_ORDER) {
    const value = frontMatter[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "boolean") lines.push(`${key}: ${value}`);
    else lines.push(`${key}: ${JSON.stringify(String(value))}`);
  }
  for (const [key, value] of Object.entries(frontMatter)) {
    if (FIELDS_ORDER.includes(key) || value === undefined || value === null || value === "") continue;
    lines.push(typeof value === "boolean" ? `${key}: ${value}` : `${key}: ${JSON.stringify(String(value))}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${body.trim()}\n`;
}

/** Проверяет поля перед сохранением. Возвращает массив сообщений об ошибках. */
export function validateFrontMatter(frontMatter) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!frontMatter[field] || !String(frontMatter[field]).trim()) errors.push(`Заполните «${field}»`);
  }
  if (frontMatter.slug && !SLUG_RE.test(String(frontMatter.slug))) {
    errors.push("slug: только латинские буквы, цифры и дефисы");
  }
  if (frontMatter.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(frontMatter.date))) {
    errors.push("date: формат YYYY-MM-DD");
  }
  if (frontMatter.title && String(frontMatter.title).length > 120) errors.push("title длиннее 120 символов");
  if (frontMatter.description && String(frontMatter.description).length > 300) {
    errors.push("description длиннее 300 символов — обрежется в поисковой выдаче");
  }
  return errors;
}
