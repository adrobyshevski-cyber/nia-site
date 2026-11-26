# NIA — Narrative Intelligence Agency

Статический сайт [narrativeintelligence.ru](https://narrativeintelligence.ru). Хостинг — Cloudflare Pages (Git integration), сборки нет: файлы в корне репозитория отдаются как есть.

## Структура

```
_redirects              редиректы Cloudflare Pages
robots.txt
index.html              лендинг
styles.css              общие стили
script.js               мобильное меню + интерактивный подбор практики
404.html                (планируется) брендированная страница ошибки
_headers                (планируется) security-заголовки и кэш
sitemap.xml             (планируется)

audit/index.html        Narrative Audit
brand/index.html        Dissolved Brand
insights/
  index.html            лента публикаций
  articles.json         метаданные статей
  insights.css          тема раздела
  narrative-debt/index.html
  narrative-capital/index.html
  dissolved-branding/index.html
practices/              6 страниц направлений; audit.html и brand.html — заглушки с redirect
_archive/               исходные zip-архивы (не деплоится, в .gitignore)
```

## Локальный запуск

Абсолютные ссылки (`/insights/`, `/audit/`) в разделе `insights` требуют HTTP-сервера, `file://` не подойдёт:

```bash
python -m http.server 8080
# http://localhost:8080
```

## Деплой

Автоматически при пуше в `main` через Cloudflare Pages Git integration.

Настройки проекта в Cloudflare Pages:

| Параметр | Значение |
|---|---|
| Framework preset | None |
| Build command | *(пусто)* |
| Build output directory | `/` |

Ручной деплой без git:

```bash
npx wrangler pages deploy . --project-name <project>
```

## Правила контента

- Язык интерфейса — русский, `lang="ru"`.
- Даты публикаций в `insights/articles.json` — ISO `YYYY-MM-DD`.
- Блок `.nia-contact` встроен инлайн-стилями в каждую страницу; при правке контактов менять во всех файлах.
- Незапущенные страницы `practices/*` — `noindex, follow`.
