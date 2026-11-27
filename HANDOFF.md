# HANDOFF — NIA

Документ для того, кто продолжит работу: что где лежит, как деплоится, что уже проверено, где грабли. Обновляется при каждом значимом изменении.

- Последнее обновление: **2026-11-27** (CRM фаза 1)
- Версия Worker'а: `ba4ec5fc`
- Локальный репозиторий: `C:\work\nia_site`, ветка `main`
- Сервис аудита: `C:\work\narrative_audit` (StoryAudit), `main` = `b63755b`
- Ротация `CLOUDFLARE_API_TOKEN`: 2026-11-26 (Roll в dash), предыдущее значение отозвано (`401`)

**CRM фаза 1 включена и задеплоена (раздел 12). Дальше — фаза 2: напоминания по `next_step_at`, CSV, сводка по событиям.**

---

## 1. Что это

Сайт агентства **narrativeintelligence.ru** — статика на edge + один Worker: приём заявок, редакция статей, демо-аудит с QR и раздача отчётов.

| Параметр | Значение |
|---|---|
| Хостинг | **Cloudflare Workers Static Assets** (не Pages!) |
| Worker | `broad-paper-a8b7` — имя менять нельзя, к нему привязаны домены |
| Домены | `narrativeintelligence.ru`, `www.narrativeintelligence.ru`, `audit.narrativeintelligence.ru` (туннель) |
| Аккаунт Cloudflare | `9c43f65513791f4aaf18522bf44c7d28` (a.drobyshevski@gmail.com) |
| Репозиторий | `github.com/adrobyshevski-cyber/nia-site`, ветка `main` |
| KV `AUDIT_KV` | namespace `nia-audit`, id `d4bb0d870ea84be287c6b7e90bc5376a` |
| D1 `DB` | база `nia-crm`, id `8b00676a-4065-477c-a031-02bfebbbc7bf` (CRM) |
| Сборка | нет, кроме раздела insights (Markdown → HTML) |
| Язык контента | русский, `lang="ru"` |

## 2. Архитектура

```
public/                        ← корень ассетов, отдаётся как есть
  index.html                    лендинг
  404.html                      404 (not_found_handling: 404-page)
  styles.css script.js lead.js  общие стили, меню, обработчик форм заявок
  _redirects robots.txt sitemap.xml site.webmanifest
  favicon.svg favicon-32.png apple-touch-icon.png icon-512.png
  og/                           OG-картинки 1200×630
  audit/index.html              Narrative Audit + форма заявки
  brand/index.html              Dissolved Brand
  insights/                     ← ГЕНЕРИРУЕТСЯ из content/articles
  practices/                    6 страниц; audit.html и brand.html — meta-refresh заглушки
  demo/                         /demo: экспресс-аудит для QR (index.html, demo.css, demo.js)
  privacy/index.html            политика обработки ПД (черновик, плейсхолдеры реквизитов)
  studio/                       админка редакции (index.html, studio.css, studio.js, import.js)
  crm/                          CRM: вход, список лидов, карточка (index.html, crm.css, crm.js)

content/articles/*.md           ← ИСТОЧНИК ПРАВДЫ для insights
templates/insights-article.html шаблон статьи (форма заявки, canonical, OG внутри)

lib/lead.js                     заявки: валидация + Telegram (текст и файлы)
lib/audit.js                    /demo: лимиты, квота события, задачи в KV, /r/<token>/
lib/audit-engine.js             адаптер движка: stub | storyaudit HTTP
lib/crm.js                      CRM на D1: лиды, сделки, активности, /api/crm/*
lib/auth.js                     пароль /studio, подписанная cookie, лимит попыток
lib/frontmatter.js              разбор и сборка файла статьи
lib/github.js                   GitHub Contents API: чтение, коммит, удаление
lib/studio.js                   маршруты /studio/*

worker.js                       роутинг + security-заголовки и политика кэша
wrangler.jsonc                  конфиг Worker'а, ассетов, KV и переменных движка

scripts/build-insights.py       сборка insights из Markdown
scripts/check-lead.mjs          20 тестов заявок
scripts/check-studio.mjs        19 тестов студии
scripts/check-import.mjs        12 тестов импорта статьи
scripts/check-audit.mjs         33 теста /demo
scripts/check-crm.mjs           30 тестов CRM (настоящий SQLite через node:sqlite)
migrations/0001_init.sql        схема D1: leads, deals, activities
scripts/check-links.py          ссылки, формы, SEO, дубли id, контракт клиент↔сервер
scripts/make-og.py              OG-картинки
scripts/make-icons.py           favicon и иконки
scripts/make-qr.py              QR для ивентов
scripts/make-admin-password.py  пароль и хеш для /studio
_archive/                       исходные zip-архивы (в git не попадают)
```

## 3. Заявки с сайта

Форма — в контактном блоке всех 11 страниц и на `/audit/`. Заявка уходит **двумя независимыми запросами из браузера**, достаточно одного:

| Канал | Куда | Ключ |
|---|---|---|
| Email | `api.web3forms.com` напрямую из браузера | `WEB3FORMS_KEY` в `public/lead.js` (публичный по дизайну) |
| Telegram | `POST /api/lead` → Worker | секреты `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

Почему email не через сервер: бесплатный тариф Web3Forms отвечает `This method is not allowed. Use our API in client side or contact support with server IP address (Pro plan is required)`. Проверено реальным запросом.

Ограничения бесплатного Web3Forms: **Restrict to Domain — Pro** (ограничить домен нельзя), серверный антиспам включён, honeypot `botcheck` есть но объявлен устаревшим, hCaptcha бесплатно, лимит 250 заявок/мес.

После отправки показывается сервисное окно «Заявка отправлена. В ближайшее время с вами свяжутся». Если форма ушла обычным POST (JS не успел подписаться), Worker отвечает `303` на `referer?sent=1` — сырой JSON пользователь не увидит.

План при спаме: перевыпустить ключ Web3Forms → заменить константу в `public/lead.js` → деплой. При постоянном потоке — Resend (серверная отправка, ключ в секретах, Turnstile бесплатно).

## 4. Редакционный процесс

Источник правды — `content/articles/*.md`, `public/insights/` генерируется.

```bash
cp content/articles/_example-draft.md content/articles/<slug>.md
# заполнить front matter, draft: false
python scripts/build-insights.py
git commit -am "статья: <название>" && git push     # дальше CI задеплоит
```

Сборка обновляет страницу статьи, каталог, `articles.json`, блок «NIA / INSIGHTS» на главной и `sitemap.xml`. Страницы удалённых статей убираются по метке `<!-- generated by scripts/build-insights.py -->`.

Обязательные поля: `title`, `slug`, `description`, `lead`, `category`, `date` (`YYYY-MM-DD`), `author`, `practice`, `practice_label`. Необязательные: `category_ru`, `featured`, `draft`.

Требования: Python 3.10+, `pip install -r requirements.txt` (mistune, PyYAML, beautifulsoup4).

## 5. Деплой

**Автоматически** — пуш в `main`. GitHub Actions: `check` (сборка актуальна → тесты заявок → студия → импорт → /demo → ссылки/SEO) → `deploy` (`npx wrangler deploy`). Ручной запуск: Actions → Deploy → Run workflow.

**Вручную:**

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=9c43f65513791f4aaf18522bf44c7d28 npx wrangler deploy
```

`wrangler deploy` пишет `No targets deployed` — это нормально: триггеры не routes, а custom domains.

## 6. Секреты и доступы

| Где | Имя | Назначение |
|---|---|---|
| Worker secrets | `TELEGRAM_BOT_TOKEN` | уведомления о заявках и отчёты файлом |
| Worker secrets | `TELEGRAM_CHAT_ID` | `360726431`, личный чат `@droal1111` |
| Worker secrets | `ADMIN_PASSWORD_HASH` | вход в `/studio` и `/demo`-админку: `sha256$salt$hash` |
| Worker secrets | `SESSION_SECRET` | HMAC для cookie сессии и хешей лимитов |
| Worker secrets | `GITHUB_TOKEN` | PAT (fine-grained, Contents: R/W) для публикации статей |
| Worker secrets | `AUDIT_INTERNAL_TOKEN` | `PUBLIC_INTERNAL_TOKEN` из StoryAudit, заголовок `x-internal-token` |
| GitHub Actions | `CLOUDFLARE_API_TOKEN` | деплой из CI (`Account · Workers Scripts · Edit`), ротирован 2026-11-26 |
| GitHub Actions | `CLOUDFLARE_ACCOUNT_ID` | `9c43f65513791f4aaf18522bf44c7d28` |
| `public/lead.js` | `WEB3FORMS_KEY` | email-канал (публичный) |
| `wrangler.jsonc` vars | `AUDIT_ENGINE`, `AUDIT_SERVICE_URL` | режим движка и адрес StoryAudit |

Значений в репозитории нет. Ставить: `npx wrangler secret put <ИМЯ>`.

Телеграм-бот `@niagencybot`, токен в `@BotFather`, `chat_id` — через `https://api.telegram.org/bot<TOKEN>/getUpdates`.

Сменить пароль админки: `python scripts/make-admin-password.py` → `npx wrangler secret put ADMIN_PASSWORD_HASH`.

## 7. Что проверено и чем

| Проверка | Запуск | Покрытие |
|---|---|---|
| Заявки | `node scripts/check-lead.mjs` | 20 сценариев: валидация, honeypot, formData без JS, 303 для нативной отправки, www→apex, ошибки каналов |
| Студия | `node scripts/check-studio.mjs` | 19: пароль, сессия, Origin, коммиты, отчёт |
| Импорт статьи | `node scripts/check-import.mjs` | 12: front matter, «паспорт», эвристики, slug, предупреждения |
| `/demo` | `node scripts/check-audit.mjs` | 33: URL/телефон, лимиты устройства и IP, квота события, маппинг состояний StoryAudit, архив отчёта, HTML-файл в Telegram, деградация при сбоях |
| CRM | `node scripts/check-crm.mjs` | 30: схема на настоящем SQLite (`node:sqlite`), дедуп по `report_token`, поиск/фильтры, сделки, активность стадий, каскад при удалении, 401/403/503/404 API |
| Статика и SEO | `python scripts/check-links.py` | 200+ ссылок, редиректы, формы, canonical/OG, sitemap ↔ noindex, дубли id |
| Сборка актуальна | CI: `build-insights.py` + `git diff --quiet -- public` | забыл пересобрать → красный пуш |

Всего 84 автотеста, гоняются в CI до деплоя. Локальная приёмка: `npx wrangler dev`; проверка на реальном edge с настоящими секретами — `npx wrangler dev --remote`.

## 8. Админка /studio

`/studio/` — редактор статей: вход по паролю, список с черновиками, все поля front matter, Markdown с превью, сохранение черновика, публикация, удаление, переименование slug.

```
lib/auth.js         пароль, cookie-сессия, лимит попыток
lib/frontmatter.js  разбор/сборка файла статьи
lib/github.js       Contents API: чтение, коммит, удаление
lib/studio.js       маршруты /studio/*
public/studio/      вход и приложение; import.js — импорт .md/.txt
```

Публикация = коммит в `content/articles/<slug>.md`, дальше CI собирает и деплоит.

Импорт: front matter → «паспорт» `Ключ: значение` → эвристики (H1, первый абзац, транслит в slug с дедупликацией, дата, категория по ключевым словам). Студия подсвечивает автоматически выведенные поля и показывает предупреждения. `.docx` не поддерживается намеренно (mammoth 405 КБ) — отложено.

Безопасность: `sha256(salt ‖ пароль)` вместо PBKDF2 (лимит 10 мс CPU на free-плане; компенсируется случайным паролем ~99 бит), cookie `HttpOnly; Secure; SameSite=Strict` на 12 ч, 8 попыток за 15 минут на IP, проверка `Origin` на мутации, GitHub-токен только на сервере, `noindex` + `X-Robots-Tag` + `Disallow: /studio/`.

## 9. SEO

Canonical и OG/Twitter на всех индексируемых страницах, JSON-LD (`Organization` + `WebSite` на главной, `Article` + `BreadcrumbList` на статьях), `sitemap.xml` из сборки, `robots.txt` с `Disallow: /api/`, `/studio`, `/demo`, `/privacy`, 301 с `www` на apex в `worker.js`, иконки и `site.webmanifest`, `noindex` на заглушках практик.

Остаётся владельцу:

| Задача | Что нужно |
|---|---|
| Google Search Console | подтвердить домен (TXT или HTML-файл), отправить `sitemap.xml` |
| Яндекс Вебмастер | подтвердить домен, указать регион, отправить sitemap |
| Cloudflare Web Analytics | включить в дашборде зоны — реальные Core Web Vitals без cookie |

## 10. /demo — экспресс-аудит для ивентов

`public/demo/` + `lib/audit.js` + `lib/audit-engine.js`. Публичная воронка: адрес сайта → «аудит в работе» → «аудит готов» → имя, телефон, email, согласие → ссылка на отчёт. Страница `noindex`, canonical на `/audit/`, `Disallow` в robots.

### Лимиты

| Ключ | Правило |
|---|---|
| устройство (cookie на год) | 1 аудит |
| IP без метки события | 8 запусков в час |
| IP с меткой `?ev=` | 30 в час — на ивенте все гости за одним NAT |
| email | 1 отчёт на адрес, 30 дней |
| событие | 20 аудитов на метку `?ev=` (7 дней); при исчерпании заявка создаётся в статусе `manual` без движка |

### Движок

`AUDIT_ENGINE` в `wrangler.jsonc`: `stub` (отладка воронки, отчёта нет) или `live` + `AUDIT_SERVICE_URL=http://audit…`.

StoryAudit работает **локально** и смотрит наружу через Cloudflare Tunnel:

```
сервис      powershell -File scripts\start-public.ps1   (в C:\work\narrative_audit)
туннель     cloudflared tunnel run storyaudit           (protocol: http2, QUIC режется провайдером)
конфиг      C:\Users\User\.cloudflared\config.yml, tunnel 91b9d5f1-…
домен       audit.narrativeintelligence.ru → CNAME на туннель
```

Контракт (реализован в StoryAudit, PR #1–#4):

```
POST /audit (form: website, consent=on)
  заголовки: accept: application/json, x-internal-token, x-forwarded-for, x-client-ip
  → 201 {token, state_url, report_url}
GET /audit/{token}/state   → {state, error}
GET /audit/{token}/report?inline=1[&brief=1] → самодостаточный HTML
```

Состояния сервиса → наши: `ingesting`→queued, `analyzing`→running, `review`→review, `ready`→done, `failed|rejected`→failed, `expired`→expired.

### Отчёты

| Что | Где | Срок |
|---|---|---|
| Короткий отчёт (резюме + 5 находок + 5 рекомендаций, ~19 КБ) | `/r/<token>/` | 30 дней |
| Полный отчёт (17 разделов + приложения A/B, ~100–137 КБ) | `/r/<token>/full/` | 180 дней |
| PDF | `/r/<token>/report.pdf` (прокси) | пока жив сервис |

В коротком отчёте разделы перенумерованы 1–3, есть врезка «Полная версия содержит 17 разделов», методология называется **NIA Narrative Audit v1.1**, кнопки PDF нет. Полный отчёт остаётся продуктом для платных клиентов.

Отчёты отдаём **только как HTML**: при выдаче контактов оператору в Telegram уходит файл `narrative-audit-<домен>.html` — полная версия (sendDocument), в подписи ссылки на короткую и полную версии.

### QR

```bash
python scripts/make-qr.py --ev spb-2026 --caption "Narrative Audit · демо"
# → qr/demo-spb-2026.png и .svg (в git не попадают)
```

## 11. Грабли, на которые уже наступили

| Симптом | Причина | Решение |
|---|---|---|
| `wrangler deploy` не применял заголовки | при `run_worker_first: ["/api/*"]` ассеты отдаёт edge **минуя Worker** | `run_worker_first: true` |
| Формы не отправляли письма | Web3Forms на free не принимает запросы с серверов | email из браузера, Telegram из Worker'а |
| Весь файл в диффе после сборки | `write_text()` на Windows пишет CRLF | `write()` с `newline="\n"`, `.gitattributes` — `* -text` |
| В сгенерированных статьях чужие id и дата | в шаблоне остались значения первой статьи | токены `{{UID}}`, `{{DATE}}` |
| CI: `Missing entry-point` | `wrangler-action@v3` тянул wrangler 2.x, он не читает `wrangler.jsonc` | `npm install wrangler@4` + `npx wrangler deploy` |
| `wrangler whoami` → `10001` | повторный `wrangler login --device` отозвал прежний OAuth-токен | API-токен: `CLOUDFLARE_API_TOKEN=...` |
| `*.workers.dev` дублировал сайт | маршрут включён по умолчанию | `workers_dev: false`, `preview_urls: false` |
| `_headers` не работает | Workers Assets не поддерживает `_headers` | заголовки в `worker.js` |
| Заглушки практик ранжировались | были индексируемыми | `noindex, follow` |
| Вход в `/studio` → `offset is out of bounds` | длина считалась по символам, пароль кодировался в UTF-8 | `encoder.encode(password).length` |
| `check-links.py` не видел `noindex` | в регулярке вместо `\b` оказался символ backspace | разбор meta-тегов через `findall` |
| `/studio/login.html` отдавал 307 | `auto-trailing-slash` редиректит `*.html` | вход и приложение в одном `index.html` |
| В списке студии битая запись `_example-draft` | файлы на `_` не проходят slug-валидатор | файлы на `_` не считаются статьями |
| Вход на проде → `403 чужой origin` | CSRF-проверка сравнивала Origin только с `request.url` | сравнивать с `Host` и белым списком доменов |
| Кириллица в файле превращалась в `�` | так отправлял curl из Windows-шелла | UTF-8 проверять через Python `urllib` |
| Cloudflared: `failed to dial quic` | провайдер режет UDP/7844 | `protocol: http2` в конфиге туннеля |
| `cert.pem` не подхватывался | файл скачался в `Downloads` | положить в `C:\Users\User\.cloudflared\cert.pem` |
| Ссылка на отчёт «не открывается» | фильтрация домена у провайдера, а не ошибка приложения | проверять через edge, отдавать отчёт файлом в Telegram |
| Отчёт в `review` после скана | публикацию закрывает Stage Gate | подтвердить в `/ui/scans` или включить авто-публикацию |

## 12. CRM — /crm на D1

Пароль один: `/crm` закрыт той же cookie `nia_studio` (`SESSION_SECRET`, `ADMIN_PASSWORD_HASH`). Отдельных ролей нет — решено владельцем.

**Фаза 1 готова в коде** (`lib/crm.js`, `public/crm/`, `migrations/0001_init.sql`, `scripts/check-crm.mjs`). Осталось включить хранилище — нужен токен с правом `Account · D1 · Edit`.

### Включено (2026-11-27)

| Что | Значение |
|---|---|
| D1 | `nia-crm`, id `8b00676a-4065-477c-a031-02bfebbbc7bf`, регион EEUR |
| Биндинг | `DB` в `wrangler.jsonc` |
| Миграция | `0001_init.sql` применена (`wrangler d1 migrations apply nia-crm --remote`) |
| Деплой | версия `29b35a7d-7ec7-4d1d-b9f7-fcecc708b30a` |
| Проверено | `/api/crm/leads` без cookie → `401`; тестовая заявка через `/api/lead` легла в `leads` (строка затем удалена) |

Вход в CLI — **OAuth через браузер**, а не конструктор токенов: `npx wrangler login` (браузер открывается сам, права включают `d1:write`). Токен нужен только CI — `CLOUDFLARE_API_TOKEN` в GitHub Secrets; для него в дашборде правится существующий `nia-site-deploy` → `Account · D1 · Edit`.

Полезное:

```powershell
npx wrangler d1 list                                    # список баз
npx wrangler d1 execute nia-crm --remote --json --command "select * from leads limit 5" -y
npx wrangler d1 migrations apply nia-crm --local        # локальная копия для npm run dev
npx wrangler deploy                                     # деплой без CI
```

Грабли: curl из Windows-шелла портит кириллицу в теле запроса (U+FFFD в D1) — проверять через Python `urllib` или из браузера.

### Что уже есть

| Слой | Где | Что делает |
|---|---|---|
| Схема | `migrations/0001_init.sql` | `leads`, `deals`, `activities`, индексы, `report_token UNIQUE` |
| Данные | `lib/crm.js` | `recordLead`, `listLeads`, `getLead`, `updateLead`, `deleteLead`, `addActivity`, `createDeal`, `updateDeal`, `stats` |
| API | `lib/crm.js` → `handleCrm` | `GET/POST /api/crm/leads`, `GET/PATCH/DELETE /api/crm/leads/:id`, `POST …/:id/deals`, `POST …/:id/activities`, `PATCH/DELETE /api/crm/deals/:id`, `GET /api/crm/stats`, `GET /api/crm/health` |
| Экраны | `public/crm/` | вход, сводка, список с поиском и фильтрами, карточка: контакты, отчёт `/r/<token>/`, стадия, сделки, заметки |
| Автозапись | `lib/lead.js`, `lib/audit.js` | `/api/lead` → `audit_form`; `/api/audit/reveal` → `demo` + `report_token`, `event`, `consent_at` |

`source`: `demo` | `audit_form` | `manual`. `service`: audit, brand, culture, economics, strategy, lab. `stage`: new → contacted → qualified → proposal → won | lost (+ paused).

Смена стадии лида и сделки автоматически пишется в `activities` (`kind = stage`) — история не теряется. Дедупликация лидов — по `report_token`: демо-отчёт и последующая форма дают одну запись.

Отказоустойчивость: `recordLead` не бросает исключений и возвращает `null`, если биндинга `DB` нет или D1 вернул ошибку — приём заявок и Telegram от CRM не зависят. `/api/crm/*` без биндинга отвечает `503` с подсказкой.

### Фазы 2–3

- сделки: смена стадии и следующий шаг по услугам, `amount` (в API уже есть, в UI — поле суммы);
- напоминания в Telegram по `next_step_at`: `triggers.crons` в `wrangler.jsonc` + `scheduled` в `worker.js`, дедупликация отправки в `activities`;
- сводка по событиям (`event`), выгрузка CSV, пагинация списка (API умеет `limit`/`offset`, UI берёт 100);
- ручное добавление лида: API `POST /api/crm/leads` есть, в UI — кнопка.

Открытый вопрос: срок хранения (152-ФЗ). Предложение — 180 дней для `leads`/`activities` и cron-чистка; сейчас ретеншена нет, данные живут, пока их не удалят вручную.

## 13. Бэклог

| Задача | Статус |
|---|---|
| MD как источник правды для insights | **готово** (`3dd2d1a`) |
| Автодеплой по пушу | **готово** (`5afb571`) |
| Ротация `CLOUDFLARE_API_TOKEN` | **готово** 2026-11-26 |
| `/studio`: вход, редактор, публикация коммитом | **готово** |
| Импорт статьи из `.md`/`.txt` | **готово** |
| `/demo`: воронка, лимиты, квота события | **готово** |
| `/demo`: живой StoryAudit через туннель | **готово** (2026-11-27) |
| Короткий отчёт на стенде, полный в архив | **готово** |
| NIA-брендинг в отчёте, приложения C/D убраны | **готово** |
| **CRM на D1** — фаза 1 (схема, API, `/crm`, автозапись, тесты) | **готово** 2026-11-27, база `nia-crm` |
| CRM: напоминания, CSV, сводка по событиям | фаза 2–3, см. раздел 12 |
| Авто-публикация отчётов для публичных заявок | решение не принято: сейчас каждый отчёт подтверждается вручную |
| Дедупликация источников в реестре S01/S02 | не начато (дубли одного домена) |
| Конкурентный раздел: до 2 сайтов из `/demo` | не начато |
| Категория и география в паспорте отчёта | сервис не выводит их из корпуса |
| Переезд на VPS (сервис не должен зависеть от домашней сети) | обсуждено, не начато |
| Resend: доставка отчёта клиенту письмом | по необходимости |
| RSS для insights | не начато |
| Импорт `.docx` (mammoth) | отложено |

## 14. Домены и DNS

Зона `narrativeintelligence.ru` на NS Cloudflare. Custom domains Worker'а привязаны через API (`workers/domains`), а не через `routes` — смена имени Worker'а отвалит домены.

`audit.narrativeintelligence.ru` — CNAME на туннель cloudflared; проксирование выключено (серый щелчок), TLS держит Cloudflare Edge для туннеля.

Почты на домене нет (MX и SPF отсутствуют). Для адреса вида `hi@narrativeintelligence.ru` — включить Cloudflare Email Routing и пересылку на `niaagency@yandex.com`; конфликтов не будет.
