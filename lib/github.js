/**
 * Тонкий клиент GitHub Contents API для редакции.
 * Токен живёт только в секретах Worker'а и никогда не уходит в браузер.
 */

const OWNER = "adrobyshevski-cyber";
const REPO = "nia-site";
const BRANCH = "main";
const DIR = "content/articles";

const api = (path) => `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

const headers = (env) => ({
  authorization: `Bearer ${env.GITHUB_TOKEN}`,
  accept: "application/vnd.github+json",
  "user-agent": "nia-studio",
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
});

const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBase64 = (value) => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function request(env, url, init = {}) {
  const response = await fetch(url, { ...init, headers: headers(env) });
  if (response.status === 404) return null;
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.message || text.slice(0, 200) || `HTTP ${response.status}`;
    throw new Error(`GitHub: ${message}`);
  }
  return payload;
}

/** Список файлов статей: [{ name, slug, sha, size }] */
export async function listArticleFiles(env) {
  const entries = await request(env, api(DIR));
  if (!Array.isArray(entries)) return [];
  return entries
    // файлы на _ — шаблоны и выключенные заготовки, в редакции не показываем
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".md") && !entry.name.startsWith("_"))
    .map((entry) => ({
      name: entry.name,
      slug: entry.name.replace(/\.md$/, ""),
      sha: entry.sha,
      size: entry.size,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Содержимое файла: { content, sha } или null, если файла нет. */
export async function readArticleFile(env, slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("Некорректный slug");
  const payload = await request(env, api(`${DIR}/${slug}.md`));
  if (!payload) return null;
  return { content: fromBase64(payload.content || ""), sha: payload.sha };
}

/** Создаёт или обновляет файл. Возвращает { sha, commit }. */
export async function writeArticleFile(env, slug, content, message, sha) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("Некорректный slug");
  const payload = await request(env, api(`${DIR}/${slug}.md`), {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: toBase64(content),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  return { sha: payload?.content?.sha || "", commit: payload?.commit?.sha || "" };
}

/** Удаляет файл. */
export async function deleteArticleFile(env, slug, message, sha) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("Некорректный slug");
  const payload = await request(env, api(`${DIR}/${slug}.md`), {
    method: "DELETE",
    body: JSON.stringify({ message, sha, branch: BRANCH }),
  });
  return { commit: payload?.commit?.sha || "" };
}

/** Переименование = создать новый файл и удалить старый. */
export async function renameArticleFile(env, fromSlug, toSlug, content, sha, message) {
  await writeArticleFile(env, toSlug, content, message, undefined);
  await deleteArticleFile(env, fromSlug, `chore: ${fromSlug}.md → ${toSlug}.md`, sha);
}
