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

Форма есть в контактном блоке каждой страницы и на `/audit/`. Она отправляет `POST /api/lead`, функция `functions/api/lead.js` доставляет заявку по двум каналам одновременно:

| Канал | Переменные окружения |
|---|---|
| Email через Web3Forms (заявки приходят на `niaagency@yandex.com`) | `WEB3FORMS_KEY` |
| Уведомление в Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

Каналы независимы: если Web3Forms недоступен, заявка всё равно уйдёт в Telegram, и наоборот. Если не сработали оба — форма показывает ошибку и предлагает написать на email, а сама заявка попадает в логи воркера (`wrangler pages deployment tail`). Без заданных переменных форма честно сообщает об ошибке, а не врёт об успехе.

Защита от ботов: honeypot-поле `botcheck`, минимальное время заполнения 1.5 с, серверная валидация email/полей.

### Настройка секретов

1. Ключ Web3Forms: https://web3forms.com → создать Access Key на `niaagency@yandex.com`
2. Бот Telegram: `@BotFather` → `/newbot` → токен; узнать `chat_id` можно через `https://api.telegram.org/bot<TOKEN>/getUpdates` после любого сообщения боту
3. Cloudflare Pages → проект → Settings → Environment variables → добавить три переменные (Production и Preview)
4. Передеплоить: Deployments → Retry deployment, либо `git commit --allow-empty -m "redeploy"`

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
node scripts/check-lead.mjs     # 11 сценариев приёма заявок, без сети
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
