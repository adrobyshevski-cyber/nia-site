# NIA — Narrative Intelligence Agency

Сайт [narrativeintelligence.ru](https://narrativeintelligence.ru). Хостинг — **Cloudflare Workers Static Assets** (не Pages): статика раздаётся из `public/`, один Worker перехватывает запросы для приёма заявок и добавляет заголовки. Сборки нет.

Рабочее имя Worker'а — `broad-paper-a8b7`, к нему привязаны домены `narrativeintelligence.ru` и `www`. Имя менять нельзя: отвалится домен.

## Структура

```
public/                 ← корень ассетов, отдаётся как есть
  index.html            лендинг
  404.html              страница ошибки (not_found_handling: 404-page)
  styles.css
  script.js             мобильное меню + интерактивный подбор практики
  lead.js               обработчик форм заявок (прогрессивное улучшение)
  _redirects            редиректы (поддерживаются Workers Assets)
  robots.txt
  sitemap.xml
  og/                   OG-картинки 1200×630 (agency, audit, brand, insights)
  audit/index.html      Narrative Audit + форма заявки на аудит
  brand/index.html      Dissolved Brand
  insights/
    index.html          лента публикаций
    articles.json       метаданные статей
    insights.css        тема раздела
    narrative-debt/ narrative-capital/ dissolved-branding/
  practices/            6 страниц направлений; audit.html и brand.html — заглушки с redirect

worker.js               fetch-хендлер: /api/* → функции, остальное → env.ASSETS
lib/lead.js             приём заявки: валидация + уведомление в Telegram
wrangler.jsonc          конфигурация Worker'а и ассетов
scripts/check-lead.mjs  тесты обработчика (без сети)
scripts/check-links.py  ссылки, редиректы, формы, canonical/OG/sitemap, дубли id
scripts/make-og.py      перегенерация OG-картинок (Pillow)
_archive/               исходные zip-архивы (не деплоится, в .gitignore)
```

## Заявки с сайта

Форма есть в контактном блоке каждой страницы и на `/audit/`. Заявка уходит **двумя независимыми запросами из браузера**, достаточно, чтобы сработал любой:

| Канал | Куда | Настройка |
|---|---|---|
| Email | `api.web3forms.com` напрямую из браузера | ключ в `public/lead.js` (`WEB3FORMS_KEY`) |
| Telegram | `POST /api/lead` → `worker.js` → `lib/lead.js` | секреты `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

**Почему email не через сервер:** бесплатный тариф Web3Forms не принимает запросы с серверов — отвечает `This method is not allowed. Use our API in client side or contact support with server IP address (Pro plan is required)`. Поэтому ключ лежит в `lead.js` (он по дизайну публичный), а токен бота — только в секретах Worker'а.

Поведение:

- без JS форма отправляется обычным POST на `/api/lead` — только в Telegram;
- если упали оба канала, форма показывает ошибку и даёт ссылку `mailto` с заполненным текстом;
- недоставленное уведомление пишется в лог Worker'а (`npx wrangler tail`);
- защита от ботов: honeypot-поле `botcheck`, минимальное время заполнения 1.5 с, серверная валидация.

### Секреты

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # токен из @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID     # chat.id из getUpdates
```

Локально — в `.dev.vars` (образец: `.dev.vars.example`, в git не попадает).

Ещё одно, руками в кабинете: **Web3Forms → Allowed domains → `narrativeintelligence.ru`**. Репозиторий публичный, ключ виден всем; без ограничения домена им можно спамить с любого сайта.

## Локальный запуск

```bash
npx wrangler dev        # http://localhost:8788 — статика + /api/lead
```

Чистая статика без Worker'а: `python -m http.server 8080 --directory public`.

## Проверки перед деплоем

```bash
node scripts/check-lead.mjs     # 16 сценариев: валидация, honeypot, роутинг, ошибки каналов
python scripts/check-links.py   # ссылки, редиректы, формы, дубли id, контракт клиент↔сервер
```

## Деплой

```bash
npx wrangler deploy
```

Проверить, что версия живая:

```bash
npx wrangler deployments list
npx wrangler tail            # логи, если заявка не дошла
```

Автодеплой по пушу — два варианта на выбор.

**GitHub Actions (работает сразу после вставки секретов).** В репозитории лежит `.github/workflows/deploy.yml`: на каждый пуш в `main` прогоняет `scripts/check-lead.mjs` и `scripts/check-links.py`, затем `wrangler deploy`. Нужны секреты репозитория (Settings → Secrets and variables → Actions):

| Секрет | Значение |
|---|---|
| `CLOUDFLARE_API_TOKEN` | токен с правом **Workers Scripts: Edit** (dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | `9c43f65513791f4aaf18522bf44c7d28` |

Пока секретов нет, job `check` всё равно выполняется, а деплой пропускается с notice — красных прогонов не будет.

**Cloudflare Workers Builds.** Worker → Settings → Builds → Connect Git (`adrobyshevski-cyber/nia-site`, ветка `main`, deploy command `npx wrangler deploy`). Требует установки Cloudflare GitHub App; через API не подключается — OAuth-токен wrangler не имеет доступа к `builds` API.

Важно: `wrangler.jsonc` содержит `workers_dev: false` — сайт доступен только на своём домене, чтобы копия на `*.workers.dev` не попала в поиск.

## Заголовки, кэш и SEO

`_headers` в Workers Assets не поддерживается, поэтому заголовки ставит `worker.js`:

- `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy`
- `Content-Security-Policy`: `script-src/style-src 'self' 'unsafe-inline'` (на страницах есть инлайновые
  стили и скрипты), `connect-src` и `form-action` разрешают `api.web3forms.com`,
  `base-uri 'none'`, `object-src 'none'`, `frame-ancestors 'self'`.
  `default-src` и `frame-src` не заданы намеренно: модалка с примером отчёта на `/audit/` — iframe `srcdoc`,
  а ограничение `frame-src` ломает `about:srcdoc` в части браузеров
- `Cache-Control`: HTML/CSS/JS — `no-cache` (в именах файлов нет хешей, иначе после правки посетители
  получат старую версию), картинки — неделя, `sitemap.xml`/`robots.txt` — час

Важный нюанс: в `wrangler.jsonc` стоит `run_worker_first: true`. При `["/api/*"]` Cloudflare отдаёт
ассеты **минуя Worker**, и заголовки выше просто не применяются. Цена — инвокация Worker на каждый
запрос (для сайта такого размера несущественно).

SEO-обвязка: `canonical` на всех индексируемых страницах, OG/Twitter-теги с картинками из `public/og/`,
`sitemap.xml` (7 URL) + `Sitemap:` в `robots.txt`. Незапущенные `practices/culture|economics|lab|strategy`
помечены `noindex, follow` и в sitemap не входят — иначе поисковик ранжировал бы заглушки как основные страницы.

## Особенности Workers Assets (в отличие от Pages)

| | Статус |
|---|---|
| `_redirects` | поддерживается |
| `404.html` + `not_found_handling: 404-page` | поддерживается |
| `_headers` | **не поддерживается** — заголовки задаются в `worker.js` |
| Functions в `functions/` | нет, логика живёт в `worker.js` |

## Правила контента

- Язык интерфейса — русский, `lang="ru"`.
- Даты публикаций в `public/insights/articles.json` — ISO `YYYY-MM-DD`.
- Блок `.nia-contact` и стили формы продублированы инлайн в каждой странице: при правке контактов менять во всех 11 файлах.
- Незапущенные страницы `practices/*` — `noindex, follow`.
