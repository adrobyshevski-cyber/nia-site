/**
 * Точка входа Worker'а: сайт раздаётся из статических ассетов,
 * Worker перехватывает только /api/* и добавляет заголовки к ответам.
 *
 * `_headers` в Workers Assets не поддерживается (в отличие от Pages),
 * поэтому security-заголовки и политика кэша живут здесь.
 */

import { handleLead, json } from "./lib/lead.js";
import { handleStudio } from "./lib/studio.js";
import { handleAudit, handleReport } from "./lib/audit.js";

const HSTS = "max-age=15552000"; // 180 дней, без includeSubDomains

/**
 * CSP без default-src и frame-src намеренно:
 * - инлайновые <style>/<script> есть на всех страницах (style-src/script-src 'unsafe-inline');
 * - модалка с примером отчёта на /audit/ — iframe srcdoc, а ограничение frame-src
 *   ломает about:srcdoc в части браузеров.
 * Директивы ниже всё равно закрывают внешние скрипты, шрифты и утечки через connect-src.
 */
const CSP = [
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.web3forms.com",
  "form-action 'self' https://api.web3forms.com",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

const BASE_HEADERS = {
  "strict-transport-security": HSTS,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": CSP,
};

function cachePolicy(pathname) {
  // имена без хешей: правки должны доезжать до посетителей сразу
  if (pathname.endsWith(".html") || pathname.endsWith("/")) return "no-cache";
  if (pathname.endsWith(".css") || pathname.endsWith(".js")) return "no-cache";
  if (pathname.endsWith(".png") || pathname.endsWith(".jpg") || pathname.endsWith(".svg") || pathname.endsWith(".ico")) {
    return "public, max-age=604800"; // неделя: картинки меняются редко
  }
  if (pathname.endsWith(".xml") || pathname.endsWith(".txt") || pathname.endsWith(".json")) {
    return "public, max-age=3600";
  }
  return "no-cache";
}

function harden(response, pathname) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BASE_HEADERS)) headers.set(name, value);
  headers.set("cache-control", cachePolicy(pathname));
  if (pathname.startsWith("/studio") || pathname.startsWith("/demo") || pathname.startsWith("/privacy")) {
    headers.set("x-robots-tag", "noindex, nofollow");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // www → без www: иначе два адреса отдают 200 и поисковик видит дубли
    if (url.hostname.startsWith("www.")) {
      const target = new URL(request.url);
      target.hostname = url.hostname.slice(4);
      target.protocol = "https:";
      return new Response(null, {
        status: 301,
        headers: { location: target.toString(), "cache-control": "public, max-age=3600" },
      });
    }

    if (url.pathname === "/api/lead") {
      if (request.method === "POST") {
        const response = await handleLead(request, env);
        // Отправка обычной формой (без JS или до того, как скрипт подписался):
        // вместо JSON человек должен увидеть страницу с сервисным окном.
        const type = request.headers.get("content-type") || "";
        const nativeSubmit =
          type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
        if (!nativeSubmit) return response;

        const referer = request.headers.get("referer");
        let target = "https://narrativeintelligence.ru/";
        try {
          const parsed = new URL(referer || "/", "https://narrativeintelligence.ru/");
          parsed.searchParams.delete("sent");
          parsed.searchParams.delete("lead_error");
          parsed.searchParams.set(response.ok ? "sent" : "lead_error", "1");
          target = parsed.toString();
        } catch {
          /* оставляем главную */
        }
        return new Response(null, {
          status: 303,
          headers: { location: target, "cache-control": "no-store" },
        });
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      return json({ ok: false, error: "Метод не поддерживается." }, 405);
    }

    if (url.pathname.startsWith("/r/")) {
      return handleReport(request, env, url.pathname);
    }

    if (url.pathname.startsWith("/api/audit/")) {
      return handleAudit(request, env, url.pathname);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Неизвестный метод API." }, 404);
    }

    if (url.pathname === "/studio" || url.pathname.startsWith("/studio/")) {
      const response = await handleStudio(request, env, { serveAsset: (req) => env.ASSETS.fetch(req) });
      return harden(response, url.pathname);
    }

    const response = await env.ASSETS.fetch(request);
    return harden(response, url.pathname);
  },
};
