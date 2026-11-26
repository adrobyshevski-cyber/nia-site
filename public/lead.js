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

  var DIALOG_ID = "nia-service-dialog";

  function closeServiceDialog() {
    var dialog = document.getElementById(DIALOG_ID);
    if (dialog) dialog.remove();
    if (location.search.indexOf("sent=1") !== -1 || location.search.indexOf("lead_error=1") !== -1) {
      var clean = location.pathname + location.hash;
      history.replaceState(null, "", clean);
    }
  }

  function showServiceDialog(options) {
    var existing = document.getElementById(DIALOG_ID);
    if (existing) existing.remove();

    var wrap = document.createElement("div");
    wrap.id = DIALOG_ID;
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", DIALOG_ID + "-title");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;" +
      "padding:20px;background:#050510d9;backdrop-filter:blur(3px);font-family:Inter,Manrope,system-ui,sans-serif;";

    var card = document.createElement("div");
    card.style.cssText =
      "max-width:440px;width:100%;background:#141426;color:#f6f3ff;border:1px solid #4c4573;border-radius:14px;" +
      "padding:26px 24px;box-shadow:0 24px 60px #0009;text-align:center;";

    var icon = document.createElement("div");
    icon.textContent = options.error ? "!" : "✓";
    icon.style.cssText =
      "width:46px;height:46px;margin:0 auto 14px;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
      "font-size:22px;font-weight:700;background:" + (options.error ? "#5a3038" : "#2f6f63") + ";color:" +
      (options.error ? "#ffb3a7" : "#9be9c7") + ";";

    var title = document.createElement("h2");
    title.id = DIALOG_ID + "-title";
    title.textContent = options.title || "Заявка отправлена";
    title.style.cssText = "margin:0 0 10px;font-size:20px;line-height:1.3;letter-spacing:-.02em;";

    var text = document.createElement("p");
    text.textContent = options.text;
    text.style.cssText = "margin:0 0 18px;color:#c1bed4;font-size:14.5px;line-height:1.6;";

    var button = document.createElement("button");
    button.type = "button";
    button.textContent = options.error ? "Понятно" : "Хорошо";
    button.style.cssText =
      "border:0;border-radius:8px;padding:12px 22px;font-size:14px;font-weight:700;cursor:pointer;" +
      "background:#8d7bff;color:#0d0b16;";

    card.append(icon, title, text, button);
    wrap.append(card);
    document.body.append(wrap);

    button.addEventListener("click", closeServiceDialog);
    wrap.addEventListener("click", function (event) {
      if (event.target === wrap) closeServiceDialog();
    });
    document.addEventListener("keydown", function onKey(event) {
      if (event.key !== "Escape") return;
      document.removeEventListener("keydown", onKey);
      closeServiceDialog();
    });
    button.focus();

    return wrap;
  }

  var SUCCESS_TEXT = "Спасибо! Заявка отправлена. В ближайшее время с вами свяжутся для обсуждения проекта.";

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
            setStatus(form, SUCCESS_TEXT, false);
            showServiceDialog({ title: "Заявка отправлена", text: SUCCESS_TEXT });
          } else {
            var fallback = form.getAttribute("data-nia-fallback") || "niaagency@yandex.com";
            var status = setStatus(form, "Не удалось отправить. Напишите напрямую: ", true);
            if (status) {
              var link = document.createElement("a");
              link.href = mailtoFor(form, data);
              link.textContent = fallback;
              status.appendChild(link);
            }
            showServiceDialog({
              error: true,
              title: "Не удалось отправить",
              text:
                "Похоже, связь прервалась. Попробуйте ещё раз или напишите нам напрямую: " + fallback + ".",
            });
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

  function checkNativeResult() {
    var params = new URLSearchParams(location.search);
    if (params.get("sent") === "1") {
      showServiceDialog({ title: "Заявка отправлена", text: SUCCESS_TEXT });
    } else if (params.get("lead_error") === "1") {
      showServiceDialog({
        error: true,
        title: "Не удалось отправить",
        text: "Попробуйте ещё раз или напишите нам напрямую: niaagency@yandex.com.",
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      boot();
      checkNativeResult();
    });
  } else {
    boot();
    checkNativeResult();
  }
})();
