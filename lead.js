/**
 * lead.js — прогрессивное улучшение форм заявок ([data-nia-lead]).
 *
 * Без JS форма всё равно работает: обычный POST на /api/lead (multipart),
 * функция принимает и JSON, и formData.
 */
(function () {
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

  function setStatus(form, text, isError) {
    var status = form.querySelector("[data-nia-lead-status]");
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("is-error", !!isError);
  }

  function mount(form) {
    if (form.dataset.niaLeadReady === "1") return;
    form.dataset.niaLeadReady = "1";

    var startedAt = Date.now();
    var button = form.querySelector('button[type="submit"]');

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (form.dataset.busy === "1") return;

      var data = new FormData(form);
      var email = String(data.get("email") || "").trim();
      var website = String(data.get("website") || "").trim();
      var message = String(data.get("message") || "").trim();
      var kind = form.getAttribute("data-nia-lead") || "contact";
      var fallback = form.getAttribute("data-nia-fallback") || "niaagency@yandex.com";

      if (!EMAIL_RE.test(email)) {
        setStatus(form, "Проверьте адрес электронной почты.", true);
        return;
      }
      if (kind === "audit" && !website) {
        setStatus(form, "Укажите адрес сайта для аудита.", true);
        return;
      }
      if (kind === "contact" && !message) {
        setStatus(form, "Опишите задачу — хотя бы одним предложением.", true);
        return;
      }

      data.set("kind", kind);
      data.set("page", location.pathname);
      data.set("elapsed", String(Date.now() - startedAt));

      form.dataset.busy = "1";
      if (button) button.disabled = true;
      setStatus(form, "Отправляем…", false);

      var mailto =
        "mailto:" + fallback + "?subject=" + encodeURIComponent("NIA / запрос с сайта") +
        "&body=" +
        encodeURIComponent(
          (message ? message + "\n\n" : "") + "Email: " + email + (website ? "\nСайт: " + website : ""),
        );

      fetch(form.getAttribute("action") || "/api/lead", {
        method: "POST",
        headers: { accept: "application/json" },
        body: data,
      })
        .then(function (res) {
          return res.json().catch(function () {
            return { ok: res.ok };
          });
        })
        .then(function (payload) {
          if (!payload || !payload.ok) throw new Error((payload && payload.error) || "Не удалось отправить");
          form.reset();
          startedAt = Date.now();
          setStatus(form, "Заявка отправлена — ответим на указанный email.", false);
        })
        .catch(function (error) {
          var status = form.querySelector("[data-nia-lead-status]");
          setStatus(form, error.message + " Напишите напрямую: ", true);
          if (status) {
            var link = document.createElement("a");
            link.href = mailto;
            link.textContent = fallback;
            status.appendChild(link);
          }
        })
        .then(function () {
          form.dataset.busy = "0";
          if (button) button.disabled = false;
        });
    });

    // статус не должен теряться при перезагрузке страницы с якорем
    form.addEventListener("input", function () {
      if (form.querySelector("[data-nia-lead-status]")?.classList.contains("is-error")) {
        setStatus(form, "", false);
      }
    });
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll("form[data-nia-lead]"), mount);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
