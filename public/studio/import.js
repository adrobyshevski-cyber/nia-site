/**
 * Импорт статьи из файла: .md / .markdown / .txt.
 *
 * Порядок приоритета для каждого поля:
 *   1. YAML front matter   — берём как есть
 *   2. «Паспорт» в начале  — строки «Ключ: значение» (русские или английские)
 *   3. Эвристики           — H1, первый абзац, транслит заголовка, дата сегодня
 *
 * Возвращает { frontMatter, body, sources, warnings, stats }.
 * Ничего не сохраняет — заполняет форму, публикацию подтверждает человек.
 */
(function () {
  var CATEGORIES = [
    { name: "Narrative Economics", ru: "Диагностика", practice: "/practices/economics.html", label: "Narrative Economics", re: /экономик|капитал|довери|долг|ценност[ьи]|нарратив/i },
    { name: "Brands & Markets", ru: "Бренды", practice: "/brand/", label: "Dissolved Brand", re: /бренд|рынк|клиент|аудитор|позиционир/i },
    { name: "Strategy & Organizations", ru: "Стратегия", practice: "/practices/strategy.html", label: "Narrative Strategy", re: /стратег|решени|организац|команд/i },
    { name: "Culture & Organizations", ru: "Культура", practice: "/practices/culture.html", label: "Narrative Culture", re: /культур|ценности компани|сотрудник|лидер/i },
  ];

  var TRANSLIT = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };

  function slugify(text) {
    return String(text || "")
      .toLowerCase()
      .split("")
      .map(function (char) {
        return TRANSLIT[char] !== undefined ? TRANSLIT[char] : char;
      })
      .join("")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  // ключи «паспорта»: русские и английские
  var PASSPORT_KEYS = {
    "заголовок": "title", "название": "title", "title": "title",
    "slug": "slug", "адрес": "slug", "ссылка": "slug",
    "описание": "description", "аннотация": "description", "description": "description", "summary": "description",
    "лид": "lead", "вступление": "lead", "lead": "lead", "intro": "lead",
    "категория": "category", "category": "category",
    "подпись": "category_ru", "подпись карточки": "category_ru", "category_ru": "category_ru",
    "дата": "date", "date": "date",
    "автор": "author", "author": "author",
    "практика": "practice", "practice": "practice",
    "кнопка": "practice_label", "подпись кнопки": "practice_label", "practice_label": "practice_label",
    "рекомендуемая": "featured", "featured": "featured",
    "черновик": "draft", "draft": "draft",
  };

  function normalizeKey(key) {
    return String(key).toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  }

  function unquote(value) {
    var text = String(value).trim();
    if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
      try {
        return JSON.parse(text);
      } catch (error) {
        return text.slice(1, -1);
      }
    }
    if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
      return text.slice(1, -1).replace(/''/g, "'");
    }
    return text;
  }

  function asBool(value) {
    if (typeof value === "boolean") return value;
    return /^(true|да|yes|1)$/i.test(String(value).trim());
  }

  function parseFrontMatter(raw) {
    var match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
    if (!match) return null;

    var data = {};
    var lastKey = null;
    match[1].split("\n").forEach(function (line) {
      if (!line.trim()) return;
      var pair = /^([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё-]*)\s*:\s*(.*)$/.exec(line);
      if (pair) {
        lastKey = normalizeKey(pair[1]);
        data[lastKey] = pair[2];
        return;
      }
      if (lastKey && /^\s+\S/.test(line)) {
        data[lastKey] = (data[lastKey] + " " + line.trim()).trim();
      }
    });

    var result = {};
    Object.keys(data).forEach(function (key) {
      result[key] = unquote(data[key]);
    });
    return { data: result, body: match[2] };
  }

  /** Читает блок «Ключ: значение» в начале документа. */
  function parsePassport(raw) {
    var lines = raw.split("\n");
    var data = {};
    var recognised = 0;
    var consumed = 0;

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (!line.trim()) {
        if (recognised === 0) {
          consumed = i + 1;
          continue; // пустые строки до паспорта допустимы
        }
        break; // паспорт закончился
      }

      var pair = /^\s*([^:]{1,40}):\s*(.+)$/.exec(line);
      if (!pair) {
        if (recognised === 0) return null; // это не паспорт, а обычный текст
        break;
      }

      var field = PASSPORT_KEYS[normalizeKey(pair[1])];
      if (!field) {
        if (recognised === 0) return null;
        break;
      }

      data[field] = pair[2].trim();
      recognised += 1;
      consumed = i + 1;
    }

    if (recognised < 2) return null; // одна строка «Ключ: значение» — ещё не паспорт
    return { data: data, body: lines.slice(consumed).join("\n") };
  }

  function normalizeDate(value) {
    var text = String(value).trim();
    var iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (iso) return text;

    var dotted = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(text);
    if (dotted) {
      var day = dotted[1].padStart(2, "0");
      var month = dotted[2].padStart(2, "0");
      return dotted[3] + "-" + month + "-" + day;
    }
    return "";
  }

  function stripInline(text) {
    return String(text)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function firstSentence(text, limit) {
    var clean = stripInline(text);
    if (clean.length <= limit) return clean;
    var cut = clean.slice(0, limit);
    var end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (end > 60) return cut.slice(0, end + 1);
    return cut.replace(/\s+\S*$/, "") + "…";
  }

  function blocks(markdown) {
    return markdown
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map(function (block) {
        return block.trim();
      })
      .filter(Boolean);
  }

  function guessCategory(text) {
    for (var i = 0; i < CATEGORIES.length; i += 1) {
      if (CATEGORIES[i].re.test(text)) return CATEGORIES[i];
    }
    return null;
  }

  function categoryByName(name) {
    for (var i = 0; i < CATEGORIES.length; i += 1) {
      if (CATEGORIES[i].name.toLowerCase() === String(name).toLowerCase()) return CATEGORIES[i];
    }
    return null;
  }

  /**
   * @param {string} raw — содержимое файла
   * @param {{fileName?: string, existingSlugs?: string[], today?: string}} options
   */
  function parseDocument(raw, options) {
    var opts = options || {};
    var existing = (opts.existingSlugs || []).map(function (slug) {
      return String(slug).toLowerCase();
    });
    var today = opts.today || new Date().toISOString().slice(0, 10);
    var warnings = [];
    var sources = {};
    var values = {};
    var text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

    // --- 1. front matter
    var front = parseFrontMatter(text);
    var body = text;
    if (front) {
      body = front.body;
      Object.keys(front.data).forEach(function (key) {
        var value = front.data[key];
        if (value === "" || value === undefined) return;
        values[key] = typeof value === "boolean" ? value : String(value);
        sources[key] = "file";
      });
    } else {
      // --- 2. паспорт
      var passport = parsePassport(text);
      if (passport) {
        body = passport.body;
        Object.keys(passport.data).forEach(function (key) {
          values[key] = passport.data[key];
          sources[key] = "passport";
        });
      }
    }

    body = body.replace(/^\n+/, "").trimEnd();

    // --- 3. эвристики
    var list = blocks(body);
    var titleBlock = list.filter(function (block) {
      return /^#\s+/.test(block);
    })[0];

    if (!values.title) {
      if (titleBlock) {
        values.title = stripInline(titleBlock.replace(/^#\s+/, ""));
        sources.title = "heuristic";
      } else if (list[0] && stripInline(list[0]).length <= 120 && !/[.!?]$/.test(stripInline(list[0]))) {
        values.title = stripInline(list[0]);
        sources.title = "heuristic";
      } else if (opts.fileName) {
        values.title = opts.fileName.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ");
        sources.title = "heuristic";
        warnings.push({ level: "warn", text: "Заголовок взят из имени файла — проверьте." });
      }
    }

    // H1 не должен дублировать заголовок страницы — вырезаем из тела
    var h1 = /^#\s+([^\n]*)\n*/.exec(body);
    if (h1 && stripInline(h1[1]) === stripInline(values.title)) {
      body = body.slice(h1[0].length).trimStart();
      list = blocks(body);
    }

    var leadBlock = list.filter(function (block) {
      return !/^#/.test(block) && !/^[-*]\s/.test(block) && !/^>/.test(block);
    })[0];

    if (!values.lead && leadBlock) {
      values.lead = firstSentence(leadBlock, 400);
      sources.lead = "heuristic";
    }
    if (!values.description && values.lead) {
      values.description = firstSentence(values.lead, 200);
      sources.description = "heuristic";
    }

    var guess = null;
    if (!values.category) {
      guess = guessCategory([values.title, values.lead, body.slice(0, 800)].join(" "));
      values.category = guess ? guess.name : "Narrative Economics";
      sources.category = guess ? "heuristic" : "default";
      if (!guess) warnings.push({ level: "warn", text: "Категория не определена — выставлена по умолчанию." });
    }
    var matched = categoryByName(values.category) || guess;

    if (!values.category_ru) {
      values.category_ru = matched ? matched.ru : values.category;
      sources.category_ru = "default";
    }
    if (!values.practice) {
      values.practice = matched ? matched.practice : "/audit/";
      sources.practice = "default";
    }
    if (!values.practice_label) {
      values.practice_label = matched ? matched.label : "Narrative Audit";
      sources.practice_label = "default";
    }
    if (!values.author) {
      values.author = "NIA Editorial";
      sources.author = "default";
    }

    if (values.date) {
      var date = normalizeDate(values.date);
      if (date) {
        values.date = date;
        sources.date = sources.date || "file";
      } else {
        warnings.push({ level: "warn", text: "Дата не распознана (ожидается YYYY-MM-DD или ДД.ММ.ГГГГ) — поставлена сегодняшняя." });
        values.date = today;
        sources.date = "default";
      }
    } else {
      values.date = today;
      sources.date = "default";
    }

    // slug: из файла или транслит; при совпадении добавляем суффикс
    var baseSlug = slugify(values.slug || values.title);
    var slug = baseSlug || "article";
    if (existing.indexOf(slug) !== -1) {
      var index = 2;
      while (existing.indexOf(slug + "-" + index) !== -1) index += 1;
      warnings.push({ level: "warn", text: "Slug «" + slug + "» уже занят — предложен «" + slug + "-" + index + "»." });
      slug = slug + "-" + index;
    }
    values.slug = slug;
    if (!sources.slug) sources.slug = "heuristic";

    values.featured = values.featured === undefined ? false : asBool(values.featured);
    values.draft = values.draft === undefined ? true : asBool(values.draft);

    // --- проверки содержимого
    var words = body.split(/\s+/).filter(Boolean).length;
    if (!titleBlock && !front) warnings.push({ level: "warn", text: "В тексте нет заголовка H1 — заголовок выведен из первого абзаца." });
    if (body.trim().length < 150) warnings.push({ level: "error", text: "Текст короче 150 символов — публикация будет недоступна." });
    if (values.title && String(values.title).length > 120) warnings.push({ level: "error", text: "Заголовок длиннее 120 символов." });
    if (values.description && String(values.description).length > 300) warnings.push({ level: "error", text: "Описание длиннее 300 символов." });
    if (/!\[[^\]]*\]\([^)]*\)/.test(body)) warnings.push({ level: "warn", text: "В тексте есть картинки — они не импортируются, добавьте их отдельно." });
    if (/^\s*\|.*\|\s*$/m.test(body)) warnings.push({ level: "warn", text: "В тексте есть таблица — проверьте, как она отрисуется." });
    if (values.category && !categoryByName(values.category)) {
      warnings.push({ level: "warn", text: "Нестандартная категория «" + values.category + "» — в каталоге появится новый фильтр." });
    }

    return {
      frontMatter: values,
      body: body,
      sources: sources,
      warnings: warnings,
      stats: { words: words, minutes: Math.max(1, Math.ceil(words / 190)), chars: body.trim().length },
    };
  }

  window.NiaImport = {
    parseDocument: parseDocument,
    slugify: slugify,
    CATEGORIES: CATEGORIES,
  };
})();
