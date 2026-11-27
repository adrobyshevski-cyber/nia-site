/**
 * /demo — стейт-машина экспресс-аудита.
 *   1. форма URL        POST /api/audit/start
 *   2. ожидание         GET  /api/audit/status?id=…  каждые 3 с
 *   3. контакты         POST /api/audit/reveal
 *   4. готово
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("card");
  const eyebrow = $("stage-eyebrow");
  const title = $("stage-title");
  const lead = $("stage-lead");
  const body = $("stage-body");

  const POLL_MS = 3000;
  const TIMEOUT_MS = 10 * 60 * 1000;

  let jobId = null;
  let pollTimer = null;
  let startedAt = 0;

  const api = async (path, options = {}) => {
    const response = await fetch(path, { credentials: "same-origin", ...options });
    const data = await response.json().catch(() => ({ ok: false, error: "Нет ответа от сервера" }));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `Ошибка ${response.status}`);
      error.code = data.code;
      throw error;
    }
    return data;
  };

  const setStage = ({ eyebrow: e, title: t, lead: l }) => {
    if (e !== undefined) eyebrow.textContent = e;
    if (t !== undefined) title.textContent = t;
    if (l !== undefined) lead.innerHTML = l;
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const startOver = () => {
    stopPolling();
    jobId = null;
    renderForm();
  };

  // ---------- 1. форма ----------
  function renderForm(message = "", isError = false) {
    setStage({
      eyebrow: "ЭКСПРЕСС-АУДИТ / NARRATIVE AUDIT",
      title: "Проверим, что мешает понять ценность вашего сайта",
      lead:
        "Вставьте адрес — сервис разберёт публичный нарратив и покажет, где расходятся обещания, " +
        "доказательства и опыт клиента.",
    });
    body.innerHTML = `
      <form class="ask" id="start-form" novalidate>
        <label class="sr-only" for="site">Адрес сайта</label>
        <input id="site" name="site" type="text" inputmode="url" autocomplete="url" spellcheck="false"
               placeholder="example.com" required>
        <button class="btn primary" id="start-button" type="submit">Запустить аудит</button>
      </form>
      <p class="hint${isError ? " error" : ""}" id="start-status" aria-live="polite"></p>
      <p class="fineprint">Один бесплатный аудит на устройство. Аудит идёт 5–7 минут —
        страницу можно закрыть, отчёт откроется по ссылке после того, как вы оставите контакты.</p>`;

    $("start-status").textContent = message;
    $("start-form").addEventListener("submit", onStart);
    $("site").focus();
  }

  async function onStart(event) {
    event.preventDefault();
    const input = $("site");
    const button = $("start-button");
    const status = $("start-status");
    const raw = input.value.trim();
    if (!raw) {
      status.textContent = "Введите адрес сайта.";
      status.classList.add("error");
      return;
    }

    button.disabled = true;
    status.textContent = "Отправляем запрос…";
    status.classList.remove("error");

    try {
      const data = await api("/api/audit/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: raw, ev: new URLSearchParams(location.search).get("ev") || "" }),
      });
      jobId = data.job.id;
      startedAt = Date.now();
      renderWorking(data.job.host || raw);
      poll();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("error");
      button.disabled = false;
    }
  }

  // ---------- 2. ожидание ----------
  function renderWorking(host) {
    setStage({
      eyebrow: "АУДИТ ЗАПУЩЕН",
      title: "Ваш аудит в работе",
      lead: `Разбираем публичный нарратив <strong>${host}</strong>. Обычно 5–7 минут: сервис читает страницы сайта и проверяет утверждения по источникам.`,
    });
    body.innerHTML = `
      <div class="working"><div class="spinner" aria-hidden="true"></div>
        <div><strong>Идёт анализ</strong><br><span class="timer" id="timer">0:00</span>
        <span aria-live="polite" class="hint" id="poll-status"></span></div></div>
      <div class="progress"><span id="bar"></span></div>
      <p class="fineprint">Аудит по открытым источникам. Можно закрыть страницу — аудит продолжится,
        а отчёт мы сохраним и отдадим по ссылке.</p>`;
  }

  function tick() {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const timer = $("timer");
    if (timer) timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const bar = $("bar");
    if (bar) bar.style.width = `${Math.min(92, 8 + (seconds / 150) * 84).toFixed(1)}%`;
  }

  const timerId = setInterval(tick, 1000);

  async function poll() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        stopPolling();
        renderTimeout();
        return;
      }
      try {
        const data = await api(`/api/audit/status?id=${encodeURIComponent(jobId)}`);
        tick();
        if (data.job.status === "done" || data.job.status === "review" || data.job.status === "manual") {
          stopPolling();
          renderGate(data.job);
        } else if (data.job.status === "failed") {
          stopPolling();
          renderForm("Сервис не смог обработать сайт — проверьте адрес или напишите нам, разберёмся вручную.", true);
        } else if (data.job.status === "expired") {
          stopPolling();
          renderForm("Срок этой заявки истёк. Запустите аудит заново.", true);
        }
      } catch (error) {
        const status = $("poll-status");
        if (status) status.textContent = ` ${error.message}`;
      }
    }, POLL_MS);
  }

  function renderTimeout() {
    setStage({ eyebrow: "АУДИТ ЗАДЕРЖАЛСЯ", title: "Сервис не успел за 10 минут", lead: "" });
    body.innerHTML = `
      <p class="lead">Оставьте контакты — пришлём отчёт, как только он будет готов.</p>
      <button class="btn primary" id="retry" type="button">Попробовать снова</button>`;
    $("retry").addEventListener("click", startOver);
  }

  // ---------- 3. контакты ----------
  function renderGate(job) {
    const manual = job && job.status === "manual";
    const review = job && job.status === "review";
    setStage({
      eyebrow: manual ? "МЕСТА НА СТЕНДЕ ЗАКОНЧИЛИСЬ" : review ? "ОТЧЁТ НА ПРОВЕРКЕ" : "АУДИТ ГОТОВ",
      title: manual ? "Оставим заявку и пришлём отчёт" : review ? "Аудит готов, отчёт проверяет аналитик" : "Ваш аудит готов",
      lead: manual
        ? "Квота аудитов на этом мероприятии исчерпана. Оставьте контакты — подготовим отчёт и пришлём его на email в течение суток."
        : review
          ? "Укажите контакты: как только аналитик подтвердит отчёт, ссылка придёт на email."
          : "Укажите, куда отправить отчёт — откроем его на этой странице и пришлём ссылку на email.",
    });
    body.innerHTML = `
      <form class="gate" id="gate-form" novalidate>
        <div class="field"><label for="name">Имя</label>
          <input id="name" name="name" autocomplete="name" maxlength="80" required></div>
        <div class="field"><label for="phone">Телефон</label>
          <input id="phone" name="phone" type="tel" autocomplete="tel" inputmode="tel"
                 placeholder="+7 999 123-45-67" required></div>
        <div class="field wide"><label for="email">Email для отчёта</label>
          <input id="email" name="email" type="email" autocomplete="email" required></div>
        <label class="consent"><input id="consent" name="consent" type="checkbox" required>
          <span>Согласен на обработку персональных данных —
            <a href="/privacy/" target="_blank" rel="noopener">политика</a></span></label>
        <p class="ready-note">Отчёт по открытым источникам не заменяет исследование клиентского опыта.</p>
        <button class="btn primary" id="reveal-button" type="submit">Получить аудит</button>
      </form>
      <p class="hint" id="gate-status" aria-live="polite"></p>`;

    $("gate-form").addEventListener("submit", onReveal);
    $("name").focus();
  }

  async function onReveal(event) {
    event.preventDefault();
    const button = $("reveal-button");
    const status = $("gate-status");
    const payload = {
      id: jobId,
      name: $("name").value.trim(),
      email: $("email").value.trim(),
      phone: $("phone").value.trim(),
      consent: $("consent").checked,
    };

    if (!payload.name) {
      status.textContent = "Укажите имя.";
      status.classList.add("error");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(payload.email)) {
      status.textContent = "Проверьте адрес электронной почты.";
      status.classList.add("error");
      return;
    }
    if (payload.phone.replace(/\D/g, "").length < 10) {
      status.textContent = "Укажите телефон в формате +7 999 123-45-67.";
      status.classList.add("error");
      return;
    }
    if (!payload.consent) {
      status.textContent = "Без согласия на обработку данных мы не можем принять заявку.";
      status.classList.add("error");
      return;
    }

    button.disabled = true;
    status.classList.remove("error");
    status.textContent = "Отправляем…";

    try {
      const data = await api("/api/audit/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      renderDone(data);
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("error");
      button.disabled = false;
    }
  }

  // ---------- 4. готово ----------
  function renderDone(data) {
    setStage({ eyebrow: "ГОТОВО", title: "Спасибо! Заявка принята", lead: "" });
    const reportLine = data.reportUrl
      ? `<p><a class="btn primary" href="${data.reportUrl}" target="_blank" rel="noopener">Открыть отчёт</a></p>
         <p>Ссылка сохранена за вами: если понадобится вернуться к отчёту — напишите нам.</p>`
      : `<p>Отчёт пришлём на указанный email. Если в течение суток ничего не придёт — напишите нам.</p>`;
    body.innerHTML = `
      <div class="done">
        <div class="checkmark" aria-hidden="true">✓</div>
        <h2>Аудит готов, контакты получены</h2>
        ${reportLine}
        ${data.reportUrl ? "" : '<p class="stub-note">Это демонстрационный режим: форма и воронка работают полностью, отчёт на этом стенде не формируется.</p>'}
        <p><a href="/audit/">Полный бесплатный Narrative Audit →</a></p>
      </div>`;
  }

  window.addEventListener("beforeunload", stopPolling);
  renderForm();
  window.NiaDemo = { renderForm, renderWorking, renderGate, renderDone, startOver };
})();
