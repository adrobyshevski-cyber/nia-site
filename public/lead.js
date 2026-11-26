/**
 * lead.js — отправка форм заявок ([data-nia-lead]).
 *
 * Заявка уходит параллельно в два независимых канала:
 *   1) email  — Web3Forms принимает запросы только из браузера, поэтому POST идёт
 *      напрямую в api.web3forms.com; ключ по дизайну публичный (в Web3Forms
 *      включите Allowed domains → narrativeintelligence.ru).
 *   2) Telegram — через собственную Pages Function /api/lead, чтобы токен бота
 *      не попадал в браузер.
 *
 * Достаточно, чтобы сработал любой канал. Без JS форма отправляется обычным POST
 * на /api/lead (только Telegram-канал).
 */
(function () {
  var WEB3FORMS_KEY = "6655e6f0-b22f-4865-9938-533a3ac0d6aa";
  var WEB3FORMS_URL = "https://api.web3forms.com/submit";
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

  function field(data, name) {
    return String(data.get(name) || "").trim();
  }

  function setStatus(form, text, isError) {
    var status = form.querySelector("[data-nia-lead-status]");
    if (!status) return null;
    status.textContent = text;
    status.classList.toggle("is-error", !!isError);
    return status;
  }

  function composeMessage(data, kind) {
    var lines = [];
    var name = field(data, "name");
    var website = field(data, "website");
    if (name) lines.push("Имя: " + name);
    lines.push("Email: " + field(data, "email"));
    if (website) lines.push("Сайт: " + website);
    lines.push("Тип: " + (kind === "audit" ? "заявка на аудит" : "запрос с сайта"));
    lines.push("Страница: " + location.pathname);
    lines.push("");
    lines.push(field(data, "message") || "(сообщение не заполнено)");
    return lines.join("\n");
  }

  function sendEmail(form, data, kind) {
    var payload = new FormData(form);
    payload.set("access_key", WEB3FORMS_KEY);
    payload.set("subject", kind === "audit" ? "NIA / заявка на бесплатный аудит" : "NIA / запрос с сайта");
    payload.set("from_name", "NIA Site");
    payload.set("replyto", field(data, "email"));
    payload.set("message", composeMessage(data, kind));

    return fetch(WEB3FORMS_URL, { method: "POST", headers: { accept: "application/json" }, body: payload })
      .then(function (res) {
        return res.json().catch(function () {
          return { success: false };
        });
      })
      .then(function (payload) {
        if (!payload || payload.success !== true) throw new Error("email: Web3Forms отклонил заявку");
        return true;
      });
  }

  function sendTelegram(form, data) {
    return fetch(form.getAttribute("action") || "/api/lead", {
      method: "POST",
      headers: { accept: "application/json" },
      body: data,
    })
      .then(function (res) {
        return res.json().catch(function () {
          return { ok: false };
        });
      })
      .then(function (payload) {
        if (!payload || payload.ok !== true) throw new Error("telegram: не доставлено");
        return true;
      });
  }

  function mailtoFor(form, data) {
    var fallback = form.getAttribute("data-nia-fallback") || "niaagency@yandex.com";
    var email = field(data, "email");
    var message = field(data, "message");
    var website = field(data, "website");
    var body = (message ? message + "\n\n" : "") + "Email: " + email + (website ? "\nСайт: " + website : "");
    return (
      "mailto:" + fallback +
      "?subject=" + encodeURIComponent("NIA / запрос с сайта") +
      "&body=" + encodeURIComponent(body)
    );
  }

  function mount(form) {
    if (form.dataset.niaLeadReady === "1") return;
    form.dataset.niaLeadReady = "1";

    var startedAt = Date.now();
    var button = form.querySelector('button[type="submit"]');

    form.addEventListener("input", function () {
      var status = form.querySelector("[data-nia-lead-status]");
      if (status && status.classList.contains("is-error")) setStatus(form, "", false);
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (form.dataset.busy === "1") return;

      var kind = form.getAttribute("data-nia-lead") || "contact";
      var data = new FormData(form);
      var email = field(data, "email");
      var website = field(data, "website");
      var message = field(data, "message");

      if (!EMAIL_RE.test(email)) return setStatus(form, "Проверьте адрес электронной почты.", true);
      if (kind === "audit" && !website) return setStatus(form, "Укажите адрес сайта для аудита.", true);
      if (kind === "contact" && !message) return setStatus(form, "Опишите задачу — хотя бы одним предложением.", true);

      data.set("kind", kind);
      data.set("page", location.pathname);
      data.set("elapsed", String(Date.now() - startedAt));

      form.dataset.busy = "1";
      if (button) button.disabled = true;
      setStatus(form, "Отправляем…", false);

      var results = Promise.allSettled([sendEmail(form, data, kind), sendTelegram(form, data)]).then(
        function (outcomes) {
          var delivered = outcomes.some(function (outcome) {
            return outcome.status === "fulfilled" && outcome.value === true;
          });

          if (delivered) {
            form.reset();
            startedAt = Date.now();
            setStatus(form, "Заявка отправлена — ответим на указанный email.", false);
          } else {
            var status = setStatus(form, "Не удалось отправить. Напишите напрямую: ", true);
            if (status) {
              var link = document.createElement("a");
              link.href = mailtoFor(form, data);
              link.textContent = form.getAttribute("data-nia-fallback") || "niaagency@yandex.com";
              status.appendChild(link);
            }
          }
        },
      );

      results.then(function () {
        form.dataset.busy = "0";
        if (button) button.disabled = false;
      });
    });
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll("form[data-nia-lead]"), mount);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
