# NIA — Narrative Intelligence Agency

Статический сайт [narrativeintelligence.ru](https://narrativeintelligence.ru). Хостинг — Cloudflare Pages (Git integration). Сборки нет: файлы из корня репозитория отдаются как есть, формы обслуживает одна Pages Function.

## Структура

```
index.html              лендинг
styles.css              общие стили
script.js               мобильное меню + интерактивный подбор практики
lead.js                 обработчик форм заявок (прогрессивное улучшение)
_redirects              редиректы Cloudflare Pages
robots.txt

audit/index.html        Narrative Audit + форма заявки на аудит
brand/index.html        Dissolved Brand
insights/
  index.html            лента публикаций
  articles.json         метаданные статей
  insights.css          тема раздела
  narrative-debt/index.html
  narrative-capital/index.html
  dissolved-branding/index.html
practices/              6 страниц направлений; audit.html и brand.html — заглушки с redirect

functions/api/lead.js   POST /api/lead — приём заявок
scripts/check-lead.mjs  тесты функции (без сети)
scripts/check-links.py  проверка ссылок, редиректов и форм
_archive/               исходные zip-архивы (не деплоится, в .gitignore)
```

## Заявки с сайта

Форма есть в контактном блоке каждой страницы и на `/audit/`. Заявка уходит **двумя независимыми запросами из браузера**, и достаточно, чтобы сработал любой:

| Канал | Куда | Настройка |
|---|---|---|
| Email | `api.web3forms.com` напрямую из браузера | ключ в `lead.js` (`WEB3FORMS_KEY`) |
| Telegram | `POST /api/lead` → `functions/api/lead.js` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

**Почему email не через функцию:** бесплатный тариф Web3Forms не принимает запросы с серверов — на `fetch` из Worker отвечает `This method is not allowed. Use our API in client side or contact support with server IP address (Pro plan is required)`. Поэтому ключ лежит в `lead.js` (он по дизайну публичный), а токен бота — только на сервере, в переменных окружения.

Подробности поведения:

- без JS форма отправляется обычным POST на `/api/lead` — то есть только в Telegram;
- если упали оба канала, форма показывает ошибку и сразу даёт ссылку `mailto` с заполненным текстом;
- недоставленное уведомление попадает в лог воркера (`wrangler pages deployment tail`);
- защита от ботов: honeypot-поле `botcheck`, минимальное время заполнения 1.5 с, серверная валидация email/полей.

### Что настроить

1. **Web3Forms** — https://web3forms.com, ключ уже прописан в `lead.js`. В кабинете включите *Allowed domains → narrativeintelligence.ru*, чтобы ключом не спамили с чужих сайтов. Заявки приходят на email, к которому привязан ключ (`niaagency@yandex.com`).
2. **Telegram-бот** — `@BotFather` → `/newbot` → токен; затем напишите боту любое сообщение и откройте `https://api.telegram.org/bot<TOKEN>/getUpdates` — там `chat.id`.
3. **Cloudflare** — Pages → проект → Settings → Environment variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (Production и Preview), затем Retry deployment.

Локально те же переменные кладутся в `.dev.vars` (образец — `.dev.vars.example`, в git не попадает).

## Локальный запуск

Для страниц достаточно статики: абсолютные ссылки (`/insights/`, `/audit/`) требуют HTTP-сервера, `file://` не подойдёт.

```bash
python -m http.server 8080     # только статика, /api/lead отвечать не будет
```

Полная среда с работающей функцией:

```bash
npx wrangler pages dev .       # http://localhost:8788
```

## Проверки перед деплоем

```bash
node scripts/check-lead.mjs     # 12 сценариев Telegram-канала, без сети
python scripts/check-links.py   # ссылки, редиректы, формы, дубли id
```

## Деплой

Автоматически при пуше в `main` через Cloudflare Pages Git integration.

| Параметр проекта Pages | Значение |
|---|---|
| Framework preset | None |
| Build command | *(пусто)* |
| Build output directory | `/` |

Ручной деплой без git: `npx wrangler pages deploy . --project-name <project>`.

## Правила контента

- Язык интерфейса — русский, `lang="ru"`.
- Даты публикаций в `insights/articles.json` — ISO `YYYY-MM-DD`.
- Блок `.nia-contact` и стили формы продублированы инлайн в каждой странице: при правке контактов менять во всех 11 файлах.
- Незапущенные страницы `practices/*` — `noindex, follow`.
