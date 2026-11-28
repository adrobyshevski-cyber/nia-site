/* NIA CRM — клиент. Все данные через /api/crm/*, вход — /studio/login (один пароль). */
(() => {
  const $ = (id) => document.getElementById(id);
  const STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost", "paused"];
  const SOURCE_LABEL = { demo: "demo · стенд", audit_form: "форма сайта", manual: "вручную" };

  const PAGE_SIZE = 50;
  const state = {
    leads: [],
    total: 0,
    limit: PAGE_SIZE,
    offset: 0,
    currentId: "",
    query: { q: "", status: "", source: "" },
    timer: 0,
    auditTimer: 0,
  };

  const escape = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const say = (text, kind = "") => {
    const el = $("state");
    el.textContent = text;
    el.className = `state ${kind}`;
  };

  const fmt = (iso) => {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return escape(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear()).slice(2)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const pill = (stage) => `<span class="pill ${escape(stage || "new")}">${escape(stage || "new")}</span>`;

  const money = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "—";
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(number);
  };

  class AuthError extends Error {}
  class NotReady extends Error {}

  async function api(path, options = {}) {
    const res = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...options });
    if (res.status === 401) throw new AuthError("Нужен вход.");
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (res.status === 503) throw new NotReady(data.error || "D1 не подключён.");
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function showGate(message = "") {
    $("app").hidden = true;
    $("gate").hidden = false;
    $("gate-status").textContent = message;
  }

  function showApp() {
    $("gate").hidden = true;
    $("app").hidden = false;
  }

  // ---------- вход ----------
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("password").value;
    $("gate-status").textContent = "";
    try {
      const res = await fetch("/studio/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Неверный пароль.");
      $("password").value = "";
      showApp();
      await refresh();
    } catch (error) {
      $("gate-status").textContent = error.message;
    }
  });

  $("logout").addEventListener("click", async () => {
    await fetch("/studio/logout", { method: "GET", credentials: "same-origin" }).catch(() => {});
    showGate();
  });

  // ---------- список ----------
  async function loadLeads() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(state.query)) if (value) params.set(key, value);
    params.set("limit", String(state.limit));
    params.set("offset", String(state.offset));
    const data = await api(`/api/crm/leads?${params}`);
    state.leads = data.items || [];
    state.total = data.total || 0;

    // страница опустела (удалили/сменили фильтр) — вернуться на последнюю с данными
    if (!state.leads.length && state.offset > 0 && state.total > 0) {
      state.offset = Math.max(0, (Math.ceil(state.total / state.limit) - 1) * state.limit);
      return loadLeads();
    }

    renderRows();
    renderPager();
  }

  function renderRows() {
    const rows = $("rows");
    rows.innerHTML = state.leads
      .map((lead) => {
        const parts = [lead.name || "без имени"];
        if (lead.email) parts.push(lead.email);
        if (lead.phone) parts.push(lead.phone);
        if (lead.site) parts.push(lead.site);
        const next = lead.next_at ? `до ${fmt(lead.next_at)}` : lead.deal_stage ? "" : "—";
        return `<tr class="row ${lead.id === state.currentId ? "active" : ""}" data-id="${escape(lead.id)}">
          <td class="mono">${fmt(lead.created_at)}</td>
          <td>${escape(parts[0])}${parts.slice(1).map((p) => `<span class="sub">${escape(p)}</span>`).join("")}</td>
          <td><span class="badge">${escape(SOURCE_LABEL[lead.source] || lead.source)}</span>${lead.event ? `<span class="sub">${escape(lead.event)}</span>` : ""}</td>
          <td>${pill(lead.status)}${lead.deal_count ? `<span class="sub">${lead.deal_count} сделка · ${escape(lead.deal_stage || "")}</span>` : ""}</td>
          <td class="muted">${next || "—"}</td>
        </tr>`;
      })
      .join("");
    $("empty").hidden = state.leads.length > 0;
    for (const row of rows.querySelectorAll("tr.row")) {
      row.addEventListener("click", () => openLead(row.dataset.id));
    }
  }

  function renderPager() {
    const pager = $("pager");
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    const page = Math.floor(state.offset / state.limit) + 1;
    const from = state.total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.leads.length, state.total);

    pager.hidden = state.total <= state.limit;
    $("prev").disabled = state.offset === 0;
    $("next").disabled = page >= pages;
    $("pager-info").textContent = `${from}–${to} из ${state.total} · стр. ${page} / ${pages}`;
  }

  $("prev").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadLeads().catch((error) => say(error.message, "err"));
  });

  $("next").addEventListener("click", () => {
    state.offset += state.limit;
    loadLeads().catch((error) => say(error.message, "err"));
  });

  // ---------- карточка ----------
  async function openLead(id) {
    state.currentId = id;
    renderRows();
    // deeplink: /crm/?lead=<id> — по такой ссылке приходит напоминание из Telegram
    const cardUrl = new URL(location.href);
    cardUrl.searchParams.set("lead", id);
    history.replaceState(null, "", cardUrl);
    try {
      const data = await api(`/api/crm/leads/${encodeURIComponent(id)}`);
      renderCard(data);
    } catch (error) {
      say(error.message, "err");
    }
  }

  function renderCard({ lead, deals, activities }) {
    $("card").hidden = false;
    $("card-source").textContent = `${SOURCE_LABEL[lead.source] || lead.source} · ${fmt(lead.created_at)}`;
    $("card-name").textContent = lead.name || "без имени";
    $("card-id").textContent = lead.id;

    const rows = [
      lead.email ? `<dt>Email</dt><dd><a href="mailto:${escape(lead.email)}">${escape(lead.email)}</a></dd>` : "",
      lead.phone ? `<dt>Телефон</dt><dd><a href="tel:${escape(lead.phone.replace(/[^+\d]/g, ""))}">${escape(lead.phone)}</a></dd>` : "",
      lead.site ? `<dt>Сайт</dt><dd>${/^https?:/.test(lead.site) ? `<a href="${escape(lead.site)}" rel="noopener" target="_blank">${escape(lead.site)}</a>` : escape(lead.site)}</dd>` : "",
      lead.event ? `<dt>Событие</dt><dd>${escape(lead.event)}</dd>` : "",
      lead.report_token ? `<dt>Отчёт</dt><dd><a href="/r/${escape(lead.report_token)}/" rel="noopener" target="_blank">для клиента ↗</a> · <a href="/r/${escape(lead.report_token)}/full/" rel="noopener" target="_blank">полный ↗</a></dd>` : "",
      lead.consent_at ? `<dt>Согласие</dt><dd>${fmt(lead.consent_at)}</dd>` : `<dt>Согласие</dt><dd class="muted">не зафиксировано</dd>`,
    ];
    $("card-contacts").innerHTML = rows.filter(Boolean).join("");
    $("card-notes").value = lead.notes || "";

    $("audit-url").value = lead.site || "";
    stopAuditPolling();
    const auditNote = $("audit-status");
    auditNote.className = "auditnote";
    auditNote.textContent = lead.report_token ? "Отчёт готов — ссылки в контактах." : "";

    $("card-status").innerHTML = STAGES.map(
      (stage) => `<option value="${stage}"${stage === lead.status ? " selected" : ""}>${stage}</option>`,
    ).join("");

    $("deals").innerHTML = deals.length
      ? deals
          .map(
            (deal) => `<div class="deal" data-deal="${escape(deal.id)}">
              <div class="deal-top"><span class="svc">${escape(deal.service)}</span>
                <select class="deal-stage">${STAGES.map((s) => `<option value="${s}"${s === deal.stage ? " selected" : ""}>${s}</option>`).join("")}</select>
                <span class="spacer" style="flex:1"></span>
                <button class="btn small deal-del" type="button">Удалить</button>
              </div>
              <div class="next">${deal.next_step ? escape(deal.next_step) : "шаг не задан"}${deal.next_step_at ? ` · ${fmt(deal.next_step_at)}` : ""}</div>
              <div class="deal-money">
                <input aria-label="Сумма сделки, рублей" class="deal-amount" min="0" placeholder="сумма" step="1000" type="number" value="${deal.amount ? Number(deal.amount) : ""}"/>
                <span>${deal.amount ? money(deal.amount) : "₽"}</span>
              </div>
            </div>`,
          )
          .join("")
      : `<p class="muted" style="font-size:13px;margin:0 0 10px">Сделок пока нет.</p>`;

    for (const box of $("deals").querySelectorAll(".deal")) {
      const dealId = box.dataset.deal;
      box.querySelector(".deal-stage").addEventListener("change", (event) =>
        saveDeal(dealId, { stage: event.target.value }),
      );
      box.querySelector(".deal-del").addEventListener("click", async () => {
        if (!confirm("Удалить сделку?")) return;
        await api(`/api/crm/deals/${encodeURIComponent(dealId)}`, { method: "DELETE" }).catch((e) => say(e.message, "err"));
        openLead(state.currentId);
      });
      const amountInput = box.querySelector(".deal-amount");
      amountInput.addEventListener("change", async () => {
        try {
          await api(`/api/crm/deals/${encodeURIComponent(dealId)}`, {
            method: "PATCH",
            body: JSON.stringify({ amount: amountInput.value === "" ? null : Number(amountInput.value) }),
          });
          say("Сумма сохранена", "ok");
          await refreshStats();
        } catch (error) {
          say(error.message, "err");
        }
      });
    }

    $("acts").innerHTML = activities.length
      ? activities
          .map(
            (act) => `<li><span class="when">${fmt(act.at)} · ${escape(act.kind)}</span>${escape(act.text)}</li>`,
          )
          .join("")
      : `<li class="muted">Заметок нет.</li>`;
  }

  async function saveDeal(id, payload) {
    try {
      await api(`/api/crm/deals/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) });
      await openLead(state.currentId);
      await refreshStats();
    } catch (error) {
      say(error.message, "err");
    }
  }

  // ---------- аудит сайта из карточки ----------
  const AUDIT_LABEL = {
    queued: "в очереди",
    running: "идёт анализ",
    review: "на проверке",
    done: "готов",
    failed: "ошибка",
    expired: "истёк",
    manual: "принят вручную",
  };

  const stopAuditPolling = () => {
    if (state.auditTimer) clearTimeout(state.auditTimer);
    state.auditTimer = 0;
  };

  const pollAudit = async (jobId, leadId) => {
    if (state.currentId !== leadId) return;
    try {
      const data = await api(`/api/audit/status?id=${encodeURIComponent(jobId)}`);
      const status = data.job?.status || "queued";
      $("audit-status").textContent = `Аудит: ${AUDIT_LABEL[status] || status}`;
      if (["done", "failed", "expired"].includes(status)) {
        if (status === "done") {
          $("audit-status").className = "auditnote ok";
          await openLead(leadId); // в карточке появятся ссылки на отчёт
          await refreshStats();
          say("Отчёт готов — ссылки в контактах", "ok");
        } else {
          $("audit-status").className = "auditnote err";
        }
        return;
      }
      state.auditTimer = setTimeout(() => pollAudit(jobId, leadId), 5000);
    } catch (error) {
      $("audit-status").className = "auditnote err";
      $("audit-status").textContent = error.message;
    }
  };

  $("audit-start").addEventListener("click", async () => {
    const url = $("audit-url").value.trim();
    if (!url) {
      $("audit-status").className = "auditnote err";
      $("audit-status").textContent = "Укажите сайт.";
      return;
    }
    const leadId = state.currentId;
    $("audit-start").disabled = true;
    $("audit-status").className = "auditnote";
    $("audit-status").textContent = "Запускаем…";
    try {
      const data = await api("/api/audit/manual", { method: "POST", body: JSON.stringify({ url, leadId }) });
      $("audit-status").textContent = `Аудит: ${AUDIT_LABEL[data.job.status] || data.job.status}`;
      pollAudit(data.job.id, leadId);
    } catch (error) {
      $("audit-status").className = "auditnote err";
      $("audit-status").textContent = error.message;
    } finally {
      $("audit-start").disabled = false;
    }
  });

  $("card-close").addEventListener("click", () => {
    stopAuditPolling();
    $("card").hidden = true;
    state.currentId = "";
    const closed = new URL(location.href);
    closed.searchParams.delete("lead");
    history.replaceState(null, "", closed);
    renderRows();
  });

  $("card-status").addEventListener("change", async (event) => {
    try {
      await api(`/api/crm/leads/${encodeURIComponent(state.currentId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: event.target.value }),
      });
      await openLead(state.currentId);
      await loadLeads();
      await refreshStats();
      say("Стадия обновлена", "ok");
    } catch (error) {
      say(error.message, "err");
    }
  });

  $("note-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("note-text").value.trim();
    if (!text) return;
    try {
      await api(`/api/crm/leads/${encodeURIComponent(state.currentId)}/activities`, {
        method: "POST",
        body: JSON.stringify({ kind: "note", text }),
      });
      $("note-text").value = "";
      await openLead(state.currentId);
      say("Заметка добавлена", "ok");
    } catch (error) {
      say(error.message, "err");
    }
  });

  $("card-notes-save").addEventListener("click", async () => {
    try {
      await api(`/api/crm/leads/${encodeURIComponent(state.currentId)}`, {
        method: "PATCH",
        body: JSON.stringify({ notes: $("card-notes").value.trim() }),
      });
      say("Заметка оператора сохранена", "ok");
    } catch (error) {
      say(error.message, "err");
    }
  });

  // ---------- новый лид вручную ----------
  const leadFields = ["nl-name", "nl-email", "nl-phone", "nl-site", "nl-notes"];
  const closeModal = () => {
    $("lead-modal").hidden = true;
    $("lead-status").textContent = "";
  };

  $("new-lead").addEventListener("click", () => {
    $("lead-modal").hidden = false;
    $("lead-status").textContent = "";
    $("nl-name").focus();
  });
  $("lead-cancel").addEventListener("click", closeModal);
  $("lead-modal").addEventListener("click", (event) => {
    if (event.target === $("lead-modal")) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("lead-modal").hidden) closeModal();
  });

  $("lead-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: $("nl-name").value.trim(),
      email: $("nl-email").value.trim(),
      phone: $("nl-phone").value.trim(),
      site: $("nl-site").value.trim(),
      notes: $("nl-notes").value.trim(),
    };
    if (!payload.email && !payload.phone) {
      $("lead-status").textContent = "Укажите email или телефон — без контакта лид бесполезен.";
      return;
    }
    try {
      const data = await api("/api/crm/leads", { method: "POST", body: JSON.stringify(payload) });
      const id = data.lead && data.lead.id;
      for (const field of leadFields) $(field).value = "";
      closeModal();
      state.offset = 0;
      await refresh();
      if (id) await openLead(id);
      say("Лид добавлен", "ok");
    } catch (error) {
      $("lead-status").textContent = error.message;
    }
  });

  $("deal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const when = $("deal-when").value;
    const rawAmount = $("deal-amount").value;
    const payload = {
      service: $("deal-service").value,
      stage: $("deal-stage").value,
      next_step: $("deal-step").value.trim(),
      next_step_at: when ? new Date(`${when}T09:00:00`).toISOString() : null,
      amount: rawAmount === "" ? null : Number(rawAmount),
    };
    try {
      await api(`/api/crm/leads/${encodeURIComponent(state.currentId)}/deals`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      $("deal-step").value = "";
      $("deal-when").value = "";
      $("deal-amount").value = "";
      await openLead(state.currentId);
      await loadLeads();
      await refreshStats();
      say("Сделка добавлена", "ok");
    } catch (error) {
      say(error.message, "err");
    }
  });

  // ---------- сводка и фильтры ----------
  async function refreshStats() {
    try {
      const data = await api("/api/crm/stats");
      const total = data.totals || {};
      const sources = (data.sources || [])
        .map((row) => `<span class="chip">${escape(SOURCE_LABEL[row.source] || row.source)} <b>${Number(row.n) || 0}</b></span>`)
        .join("");
      const upcoming = (data.upcoming || []).filter((deal) => deal.next_step_at).length;
      const events = (data.events || [])
        .map(
          (row) =>
            `<span class="chip">${escape(row.event)} <b>${Number(row.n) || 0}</b>${row.reports ? ` · отчётов ${Number(row.reports)}` : ""}</span>`,
        )
        .join("");
      $("chips").innerHTML = [
        `<span class="chip">лидов за 30 дней <b>${Number(total.leads30) || 0}</b></span>`,
        `<span class="chip">всего <b>${Number(total.leads) || 0}</b></span>`,
        `<span class="chip">открытых сделок <b>${Number(total.open_deals) || 0}</b></span>`,
        `<span class="chip">won <b>${Number(total.won) || 0}</b></span>`,
        upcoming ? `<span class="chip warn">шагов на неделю <b>${upcoming}</b></span>` : "",
        sources,
        events,
        `<button class="chip" id="retention" title="Проверить, что попадёт под срок хранения (152-ФЗ)" type="button">срок хранения ⏳</button>`,
      ]
        .filter(Boolean)
        .join("");
    } catch (error) {
      if (!(error instanceof NotReady)) return;
      $("chips").innerHTML = `<span class="chip warn">${escape(error.message)}</span>`;
    }
  }

  async function refresh() {
    try {
      await loadLeads();
      await refreshStats();
      say(`Лидов в выборке: ${state.leads.length} из ${state.total}`, "ok");
    } catch (error) {
      if (error instanceof AuthError) return showGate("Сессия истекла — войдите заново.");
      say(error.message, "err");
    }
  }

  const onFilter = () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.query = { q: $("q").value.trim(), status: $("status").value, source: $("source").value };
      state.offset = 0; // новый фильтр — с первой страницы
      refresh();
    }, 220);
  };
  for (const id of ["q", "status", "source"]) $(id).addEventListener("input", onFilter);
  $("reload").addEventListener("click", refresh);

  const downloadCsv = (type) => {
    const params = new URLSearchParams({ type });
    if (type === "leads") {
      for (const [key, value] of Object.entries(state.query)) if (value) params.set(key, value);
    }
    location.href = `/api/crm/export.csv?${params}`;
  };
  $("export-leads").addEventListener("click", () => downloadCsv("leads"));
  $("export-deals").addEventListener("click", () => downloadCsv("deals"));

  $("chips").addEventListener("click", async (event) => {
    if (event.target.closest("#retention") === null) return;
    try {
      const data = await api("/api/crm/retention/run?dry=1", { method: "POST", body: "{}" });
      say(
        `Срок ${data.days} дн.: под обезличивание ${data.leads}, оставить (открытые сделки) ${data.keptOpen}, заметок к удалению ${data.activities}`,
        data.leads ? "" : "ok",
      );
    } catch (error) {
      say(error.message, "err");
    }
  });

  $("remind").addEventListener("click", async () => {
    $("remind").disabled = true;
    try {
      const data = await api("/api/crm/reminders/run", { method: "POST", body: "{}" });
      say(
        Number(data.sent)
          ? `Напоминаний отправлено: ${Number(data.sent)}`
          : data.due
            ? `Не отправлено: ${data.error || data.skipped || "нет канала"}`
            : "Напоминать нечего — шагов на сегодня нет",
        data.sent ? "ok" : "",
      );
      await refreshStats();
    } catch (error) {
      say(error.message, "err");
    } finally {
      $("remind").disabled = false;
    }
  });

  // ---------- старт ----------
  (async () => {
    try {
      const res = await fetch("/studio/api/session", { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!data.authenticated) return showGate();
      showApp();
      await refresh();
      const deep = new URLSearchParams(location.search).get("lead");
      if (deep) await openLead(deep);
    } catch {
      showGate("Сервер недоступен.");
    }
  })();
})();
