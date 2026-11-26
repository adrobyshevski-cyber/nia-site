/**
 * /studio — редактор статей. Все изменения уходят коммитами в GitHub,
 * дальше GitHub Actions собирает и деплоит.
 */

import {
  checkRateLimit,
  clearSessionCookie,
  createSessionToken,
  isAuthenticated,
  isSameOrigin,
  registerFailure,
  resetFailures,
  sessionCookie,
  verifyPassword,
} from "./auth.js";
import { deleteArticleFile, listArticleFiles, readArticleFile, renameArticleFile, writeArticleFile } from "./github.js";
import { parseArticleFile, stringifyArticleFile, validateFrontMatter, SLUG_RE } from "./frontmatter.js";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const clientIp = (request) => request.headers.get("cf-connecting-ip") || "";

let cache = { at: 0, items: [] };
const CACHE_MS = 30_000;

async function loadArticles(env) {
  if (Date.now() - cache.at < CACHE_MS && cache.items.length) return cache.items;

  const files = await listArticleFiles(env);
  const items = [];
  for (const file of files) {
    try {
      const read = await readArticleFile(env, file.slug);
      if (!read) continue;
      const { frontMatter, body } = parseArticleFile(read.content);
      items.push({
        slug: String(frontMatter.slug || file.slug),
        fileName: file.name,
        title: String(frontMatter.title || file.slug),
        date: String(frontMatter.date || ""),
        category: String(frontMatter.category || ""),
        draft: Boolean(frontMatter.draft),
        size: file.size,
        words: body.split(/\s+/).filter(Boolean).length,
      });
    } catch (error) {
      items.push({
        slug: file.slug,
        fileName: file.name,
        title: `${file.slug} — ошибка разбора`,
        date: "",
        category: "",
        draft: true,
        broken: String(error.message || error),
      });
    }
  }

  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)));
  cache = { at: Date.now(), items };
  return items;
}

export async function handleStudio(request, env, { serveAsset }) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/studio") {
    return new Response(null, { status: 301, headers: { location: "/studio/" } });
  }

  if (path === "/studio/login") {
    if (request.method !== "POST") return json({ ok: false, error: "Метод не поддерживается." }, 405);
    if (!isSameOrigin(request)) return json({ ok: false, error: "Запрос с чужого origin." }, 403);

    const ip = clientIp(request);
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      return json({ ok: false, error: `Слишком много попыток. Повторите через ${limit.retryAfter} с.` }, 429);
    }

    let password = "";
    try {
      password = String((await request.json()).password || "");
    } catch {
      return json({ ok: false, error: "Некорректный запрос." }, 400);
    }

    const valid = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
    if (!valid) {
      registerFailure(ip);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return json({ ok: false, error: "Неверный пароль." }, 401);
    }

    resetFailures(ip);
    const token = await createSessionToken(env);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(token) });
  }

  if (path === "/studio/logout") {
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }

  if (path === "/studio/api/session") {
    return json({ authenticated: await isAuthenticated(request, env) });
  }

  // всё ниже требует авторизации
  const authenticated = await isAuthenticated(request, env);
  if (path.startsWith("/studio/api/")) {
    if (!authenticated) return json({ ok: false, error: "Требуется вход." }, 401);
    if (request.method !== "GET" && !isSameOrigin(request)) {
      return json({ ok: false, error: "Запрос с чужого origin." }, 403);
    }
    return handleApi(request, env, url);
  }

  // страница
  if (!authenticated) {
    return serveAsset(new Request(new URL("/studio/login.html", url), request));
  }
  return serveAsset(request);
}

async function handleApi(request, env, url) {
  const path = url.pathname;

  try {
    if (path === "/studio/api/articles" && request.method === "GET") {
      return json({ ok: true, articles: await loadArticles(env) });
    }

    if (path === "/studio/api/article" && request.method === "GET") {
      const slug = url.searchParams.get("slug") || "";
      if (!SLUG_RE.test(slug)) return json({ ok: false, error: "Некорректный slug." }, 400);
      const file = await readArticleFile(env, slug);
      if (!file) return json({ ok: false, error: "Статья не найдена." }, 404);
      return json({ ok: true, slug, raw: file.content });
    }

    if (path === "/studio/api/article" && request.method === "POST") {
      return await saveArticle(request, env);
    }

    if (path === "/studio/api/article" && request.method === "DELETE") {
      const slug = url.searchParams.get("slug") || "";
      if (!SLUG_RE.test(slug)) return json({ ok: false, error: "Некорректный slug." }, 400);
      const file = await readArticleFile(env, slug);
      if (!file) return json({ ok: false, error: "Статья не найдена." }, 404);
      await deleteArticleFile(env, slug, `content: удалена статья ${slug}`, file.sha);
      cache.at = 0;
      return json({ ok: true });
    }

    return json({ ok: false, error: "Неизвестный метод API." }, 404);
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 502);
  }
}

async function saveArticle(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Некорректный запрос." }, 400);
  }

  const frontMatter = { ...(payload.frontMatter || {}) };
  const body = String(payload.body || "");
  const publish = payload.action === "publish";
  const originalSlug = payload.originalSlug ? String(payload.originalSlug) : "";

  frontMatter.draft = !publish;

  const errors = validateFrontMatter(frontMatter);
  if (errors.length) return json({ ok: false, error: errors.join("; ") }, 400);

  const slug = String(frontMatter.slug);
  if (publish && body.trim().length < 150) {
    return json({ ok: false, error: "Для публикации текст должен быть не короче 150 символов." }, 400);
  }

  const content = stringifyArticleFile(frontMatter, body);
  const message = publish
    ? `content: опубликована статья «${frontMatter.title}»`
    : `content: черновик «${frontMatter.title}»`;

  const existing = await readArticleFile(env, slug);

  if (originalSlug && originalSlug !== slug) {
    const source = await readArticleFile(env, originalSlug);
    if (!source) return json({ ok: false, error: "Исходная статья не найдена." }, 404);
    await renameArticleFile(env, originalSlug, slug, content, source.sha, message);
  } else {
    await writeArticleFile(env, slug, content, message, existing?.sha);
  }

  cache.at = 0;
  return json({ ok: true, slug, draft: frontMatter.draft, published: publish });
}
