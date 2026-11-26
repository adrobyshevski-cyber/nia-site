/**
 * Точка входа Worker'а: сайт раздаётся из статических ассетов,
 * Worker перехватывает только /api/*.
 */

import { handleLead, json } from "./lib/lead.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/lead") {
      if (request.method === "POST") return handleLead(request, env);
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      return json({ ok: false, error: "Метод не поддерживается." }, 405);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Неизвестный метод API." }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
