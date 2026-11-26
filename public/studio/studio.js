/* NIA Studio — клиент редактора. Все изменения идут через /studio/api/*. */
(() => {
  const $ = (id) => document.getElementById(id);
  const fields = ["title", "slug", "description", "lead", "category", "category_ru", "author", "practice", "practice_label"];
  const stateEl = $("state");

  let articles = [];
  let current = null; // { slug, raw }
  let dirty = false;
  let filter = "all";

  let showGate = () => {};
  let showApp = async () => {};

  const say = (text, kind = "") => {
    stateEl.textContent = text;
    stateEl.className = `state ${kind}`;
  };

  const api = async (path, options = {}) => {
    const res = await fetch(path, { credentials: "same-origin", ...options });
    if (res.status === 401) {
      showGate("Сессия истекла — войдите заново.");
      throw new Error("Сессия истекла, войдите заново.");
    }
    const data = await res.json().catch(() => ({ ok: false, error: "Нет ответа от сервера" }));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  // ---------- Markdown-превью (минимальный рендер без зависимостей) ----------
  const escapeHtml = (text) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>');

  function renderMarkdown(markdown) {
    const out = [];
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    let list = null;
    let quote = [];

    const flushList = () => {
      if (list) {
        out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
        quote = [];
      }
    };

    for (const line of lines) {
      const text = line.trimEnd();
      const bullet = /^\s*[-*]\s+(.*)$/.exec(text);
      const numbered = /^\s*\d+\.\s+(.*)$/.exec(text);
      const quoted = /^\s*>\s?(.*)$/.exec(text);

      if (!text.trim()) {
        flushList();
        flushQuote();
        continue;
      }
      if (/^#{1,6}\s/.test(text)) {
        flushList();
        flushQuote();
        const level = Math.min(6, text.match(/^#+/)[0].length);
        out.push(`<h${level}>${inline(text.replace(/^#+\s*/, ""))}</h${level}>`);
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(text.trim())) {
        flushList();
        flushQuote();
        out.push("<hr/>");
        continue;
      }
      if (bullet) {
        flushQuote();
        if (!list || list.tag !== "ul") {
          flushList();
          list = { tag: "ul", items: [] };
        }
        list.items.push(bullet[1]);
        continue;
      }
      if (numbered) {
        flushQuote();
        if (!list || list.tag !== "ol") {
          flushList();
          list = { tag: "ol", items: [] };
        }
        list.items.push(numbered[1]);
        continue;
      }
      if (quoted) {
        flushList();
        quote.push(quoted[1]);
        continue;
      }
      flushList();
      flushQuote();
      out.push(`<p>${inline(text)}</p>`);
    }
    flushList();
    flushQuote();
    return out.join("\n") || '<p class="muted">Пока пусто</p>';
  }

  // ---------- состояние формы ----------
  const formValues = () => {
    const frontMatter = {};
    for (const name of fields) frontMatter[name] = $(name).value.trim();
    frontMatter.featured = $("featured").checked;
    frontMatter.draft = $("draft").checked;
    return { frontMatter, body: $("body").value };
  };

  const setValues = (frontMatter = {}, body = "") => {
    for (const name of fields) $(name).value = frontMatter[name] === undefined ? "" : String(frontMatter[name]);
    $("featured").checked = Boolean(frontMatter.featured);
    $("draft").checked = frontMatter.draft === undefined ? true : Boolean(frontMatter.draft);
    $("body").value = body;
    if (!frontMatter.practice) $("practice").value = "/practices/strategy.html";
    updatePreview();
    updateMeta();
  };

  const updatePreview = () => {
    $("preview").innerHTML = renderMarkdown($("body").value);
  };

  const updateMeta = () => {
    $("slug-hint").textContent = `латиница, цифры, дефисы — станет адресом /insights/${$("slug").value || "<slug>"}/`;
    $("desc-hint").textContent = `${$("description").value.length} / 300 символов`;
    const slug = $("slug").value.trim();
    $("viewLink").href = slug ? `/insights/${slug}/` : "/insights/";
    $("viewLink").style.visibility = current || slug ? "visible" : "hidden";
    $("remove").disabled = !current;
    $("draft").checked ? ($("save").textContent = "Сохранить черновик") : ($("save").textContent = "Сохранить изменения");
  };

  const markDirty = () => {
    if (!dirty) {
      dirty = true;
      say("Есть несохранённые изменения");
    }
  };

  // ---------- список ----------
  const renderList = () => {
    const list = $("list");
    list.innerHTML = "";
    const visible = articles.filter((a) =>
      filter === "all" ? true : filter === "draft" ? a.draft : !a.draft,
    );

    if (!visible.length) {
      const li = document.createElement("li");
      li.className = "side-empty";
      li.textContent = filter === "all" ? "Статей пока нет" : "Пусто";
      list.append(li);
      return;
    }

    for (const article of visible) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = "#";
      link.dataset.slug = article.slug;
      if (current && current.slug === article.slug) link.className = "current";
      const title = document.createElement("span");
      title.textContent = article.title;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${article.date || "без даты"} · ${article.words || 0} слов`;
      if (article.draft) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "черновик";
        meta.append(badge);
      }
      link.append(title, meta);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openArticle(article.slug);
      });
      li.append(link);
      list.append(li);
    }
  };

  const loadList = async () => {
    const data = await api("/studio/api/articles");
    articles = data.articles || [];
    renderList();
  };

  // ---------- открытие / создание ----------
  const parseRaw = (raw) => {
    const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(raw);
    if (!match) return { frontMatter: {}, body: raw };
    const frontMatter = {};
    let lastKey = null;
    for (const line of match[1].split(/\r?\n/)) {
      const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (pair) {
        lastKey = pair[1];
        let value = pair[2].trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          try {
            value = JSON.parse(value);
          } catch {
            value = value.slice(1, -1);
          }
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        frontMatter[lastKey] = value;
        continue;
      }
      if (lastKey && /^\s+\S/.test(line)) frontMatter[lastKey] = `${frontMatter[lastKey]} ${line.trim()}`.trim();
    }
    for (const [key, value] of Object.entries(frontMatter)) {
      if (value === "true" || value === "false") frontMatter[key] = value === "true";
    }
    return { frontMatter, body: match[2].trim() };
  };

  const openArticle = async (slug) => {
    if (dirty && !confirm("Несохранённые изменения будут потеряны. Продолжить?")) return;
    say("Загружаем…");
    try {
      const data = await api(`/studio/api/article?slug=${encodeURIComponent(slug)}`);
      const parsed = parseRaw(data.raw);
      current = { slug, raw: data.raw };
      setValues(parsed.frontMatter, parsed.body);
      dirty = false;
      say(`Открыта «${parsed.frontMatter.title || slug}»`);
      renderList();
    } catch (error) {
      say(error.message, "err");
    }
  };

  const newArticle = () => {
    if (dirty && !confirm("Несохранённые изменения будут потеряны. Продолжить?")) return;
    current = null;
    const today = new Date().toISOString().slice(0, 10);
    setValues(
      {
        date: today,
        author: "NIA Editorial",
        category: "Narrative Economics",
        category_ru: "Диагностика",
        practice: "/practices/strategy.html",
        practice_label: "Narrative Strategy",
        draft: true,
        featured: false,
      },
      "",
    );
    dirty = false;
    say("Новая статья — заполните поля и сохраните");
    renderList();
    $("title").focus();
  };

  // ---------- сохранение ----------
  const save = async (publish) => {
    const { frontMatter, body } = formValues();
    if (!frontMatter.title) return say("Заполните заголовок", "err");
    if (!frontMatter.slug) frontMatter.slug = slugify(frontMatter.title);
    if (publish && !frontMatter.draft && body.trim().length < 150) {
      return say("Для публикации текст должен быть не короче 150 символов", "err");
    }
    if (publish && !confirm(`Опубликовать «${frontMatter.title}»? Изменения уйдут коммитом и попадут на сайт после сборки.`)) {
      return;
    }

    say(publish ? "Публикуем…" : "Сохраняем…");
    try {
      const data = await api("/studio/api/article", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frontMatter, body, action: publish ? "publish" : "draft", originalSlug: current?.slug || "" }),
      });
      current = { slug: data.slug, raw: "" };
      $("slug").value = data.slug;
      $("draft").checked = data.draft;
      dirty = false;
      await loadList();
      updateMeta();
      say(
        data.published
          ? "Опубликовано: коммит создан, сайт обновится через минуту-две"
          : "Черновик сохранён коммитом",
        "ok",
      );
    } catch (error) {
      say(error.message, "err");
    }
  };

  const remove = async () => {
    if (!current) return;
    if (!confirm(`Удалить статью «${$("title").value || current.slug}»? Файл будет удалён коммитом.`)) return;
    say("Удаляем…");
    try {
      await api(`/studio/api/article?slug=${encodeURIComponent(current.slug)}`, { method: "DELETE" });
      const removedSlug = current.slug;
      current = null;
      await loadList();
      newArticle();
      say(`Статья ${removedSlug} удалена`, "ok");
    } catch (error) {
      say(error.message, "err");
    }
  };

  const slugify = (text) =>
    text
      .toLowerCase()
      .replace(/[а-яё]/g, (char) => {
        const map = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
        return map[char] ?? "";
      })
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);

  // ---------- события ----------
  for (const id of [...fields, "body", "featured", "draft"]) {
    $(id).addEventListener("input", () => {
      markDirty();
      if (id === "body") updatePreview();
      if (id === "slug" || id === "date" || id === "practice") updateMeta();
      if (id === "title") {
        $("slug-hint").textContent = `латиница, цифры, дефисы — станет адресом /insights/${$("slug").value || slugify($("title").value) || "<slug>"}/`;
      }
    });
    $(id).addEventListener("change", markDirty);
  }

  $("slug").addEventListener("blur", () => {
    if (!$("slug").value.trim() && $("title").value.trim()) {
      $("slug").value = slugify($("title").value);
      updateMeta();
    }
  });

  $("save").addEventListener("click", () => save(false));
  $("publish").addEventListener("click", () => save(true));
  $("remove").addEventListener("click", remove);
  $("new").addEventListener("click", newArticle);
  $("reload").addEventListener("click", () => loadList().then(() => say("Список обновлён", "ok")));
  $("logout").addEventListener("click", async () => {
    await fetch("/studio/logout", { method: "POST" });
    location.href = "/";
  });

  document.querySelectorAll(".side-filters button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".side-filters button").forEach((b) => b.classList.toggle("active", b === button));
      filter = button.dataset.filter;
      renderList();
    });
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      save(false);
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (dirty) event.preventDefault();
  });

  // ---------- вход ----------
  const gate = $("gate");
  const shell = $("app");

  showGate = (message = "") => {
    gate.hidden = false;
    shell.hidden = true;
    $("gate-status").textContent = message;
    document.body.classList.remove("app");
    $("password").focus();
  };

  showApp = async () => {
    gate.hidden = true;
    shell.hidden = false;
    document.body.classList.add("app");
    await loadList();
    if (articles.length) await openArticle(articles[0].slug);
    else newArticle();
  };

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = $("gate-status");
    const button = event.target.querySelector("button");
    const password = $("password").value;
    if (!password) {
      status.textContent = "Введите пароль.";
      return;
    }
    button.disabled = true;
    status.textContent = "Проверяем…";
    try {
      const res = await fetch("/studio/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "Нет ответа от сервера" }));
      if (!data.ok) throw new Error(data.error || "Не удалось войти.");
      $("password").value = "";
      await showApp();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });

  // ---------- старт ----------
  (async () => {
    try {
      const session = await api("/studio/api/session");
      if (!session.authenticated) {
        showGate();
        return;
      }
      await showApp();
    } catch (error) {
      showGate(error.message);
    }
  })();
})();
