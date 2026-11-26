#!/usr/bin/env python3
"""Проверка статики перед деплоем: ссылки, редиректы, ассеты и формы заявок.

Запуск: python scripts/check-links.py
Код возврата 1, если найдены проблемы.
"""

import html
import json
import os
import re
import sys
from urllib.parse import unquote, urlparse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(REPO, "public")
problems = []


def fail(message):
    problems.append(message)


# --- _redirects -------------------------------------------------------------
rules = []
redirects_path = os.path.join(ROOT, "_redirects")
if os.path.exists(redirects_path):
    for line in open(redirects_path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#"):
            parts = line.split()
            if len(parts) >= 2:
                rules.append((parts[0], parts[1], parts[2] if len(parts) > 2 else "301"))


def resolve(url_path):
    """Сопоставляет путь сайта файлу на диске с учётом _redirects."""
    for source, target, code in rules:
        if url_path == source:
            return ("redirect", target, code)
    candidates = (
        [url_path + "index.html"] if url_path.endswith("/") else [url_path, url_path + ".html", url_path + "/index.html"]
    )
    for candidate in candidates:
        if os.path.isfile(os.path.join(ROOT, candidate.lstrip("/").replace("/", os.sep))):
            return ("file", candidate, None)
    return ("missing", url_path, None)


def normalize(url_path):
    return url_path if url_path.startswith("/") else "/" + url_path


# --- HTML -------------------------------------------------------------------
pages = []
for base, _, names in os.walk(ROOT):
    if os.sep + ".git" in base or os.sep + "_archive" in base:
        continue
    for name in names:
        if name.endswith(".html"):
            pages.append(os.path.join(base, name))
pages.sort()

LINK_RE = re.compile(r'(?:href|src)\s*=\s*"([^"]*)"', re.I)
ACTION_RE = re.compile(r'<form\b[^>]*>', re.I)
ID_RE = re.compile(r'\sid="([^"]+)"')

checked_links = 0
for page in pages:
    rel = os.path.relpath(page, ROOT).replace(os.sep, "/")
    text = open(page, encoding="utf-8").read()
    base_url = "/" + rel

    for raw in LINK_RE.findall(text):
        url = html.unescape(raw).strip()
        if not url or url.startswith(("mailto:", "tel:", "javascript:", "data:", "http://", "https://", "//")):
            continue
        path = urlparse(url).path
        if not path:
            continue
        target = path if path.startswith("/") else os.path.normpath(
            os.path.join(os.path.dirname(base_url), path)
        ).replace(os.sep, "/")
        kind, value, _ = resolve(normalize(target))
        if kind == "missing":
            fail(f"{rel}: битая ссылка {url} (→ {target})")
        elif kind == "redirect":
            if resolve(normalize(value))[0] == "missing":
                fail(f"{rel}: {url} ведёт на редирект {value}, которого нет")
            else:
                checked_links += 1
        else:
            checked_links += 1

    # формы заявок
    forms = ACTION_RE.findall(text)
    lead_forms = [f for f in forms if "data-nia-lead=" in f]
    if "nia-contact" in text and not lead_forms:
        fail(f"{rel}: есть контактный блок, но нет формы data-nia-lead")
    for form_tag in lead_forms:
        if 'action="/api/lead"' not in form_tag:
            fail(f"{rel}: у формы заявки неверный action")
        if 'name="email"' not in text:
            fail(f"{rel}: в форме заявки нет поля email")
        if 'name="botcheck"' not in text:
            fail(f"{rel}: в форме заявки нет honeypot-поля")
        if "data-nia-lead-status" not in text:
            fail(f"{rel}: нет элемента статуса формы")
        if "/lead.js" not in text:
            fail(f"{rel}: не подключён /lead.js")
    if lead_forms and 'name="kind"' not in text:
        fail(f"{rel}: нет hidden-поля kind (нужно для отправки без JS)")

    # дубли id
    ids = ID_RE.findall(text)
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        fail(f"{rel}: повторяющиеся id: {', '.join(duplicates)}")

# --- _redirects: цели существуют -------------------------------------------
for source, target, code in rules:
    if code not in {"301", "302", "303", "307", "308"}:
        fail(f"_redirects: неподдерживаемый Cloudflare Pages код {code} для {source}")
    if resolve(normalize(target))[0] == "missing":
        fail(f"_redirects: {source} → {target} ведёт в никуда")

# --- articles.json ----------------------------------------------------------
articles = os.path.join(ROOT, "insights", "articles.json")
if os.path.exists(articles):
    for article in json.load(open(articles, encoding="utf-8")):
        if resolve(article["url"])[0] == "missing":
            fail(f"articles.json: {article['url']} не существует")

# --- SEO: sitemap, canonical, OG -------------------------------------------
sitemap = os.path.join(ROOT, "sitemap.xml")
if os.path.exists(sitemap):
    xml = open(sitemap, encoding="utf-8").read()
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    if not locs:
        fail("sitemap.xml: нет ни одного <loc>")
    for loc in locs:
        path = urlparse(loc).path or "/"
        if resolve(path)[0] != "file":
            fail(f"sitemap.xml: {loc} не существует на сайте")
    if "/api/" in xml:
        fail("sitemap.xml: в карту попал /api/")
    robots_txt = open(os.path.join(ROOT, "robots.txt"), encoding="utf-8").read()
    if "Sitemap:" not in robots_txt:
        fail("robots.txt: нет ссылки на sitemap")

for page in pages:
    rel = os.path.relpath(page, ROOT).replace(os.sep, "/")
    text = open(page, encoding="utf-8").read()
    if rel in ("practices/audit.html", "practices/brand.html", "404.html"):
        continue  # заглушки-редиректы и страница ошибки
    # порядок атрибутов произвольный: ищем meta, где есть и robots, и noindex
    noindex = any(
        "noindex" in tag and "robots" in tag for tag in re.findall(r"<meta[^>]*>", text, re.I)
    )
    if noindex:
        # служебные страницы (studio) не индексируются: canonical и OG им не нужны
        if os.path.exists(sitemap) and rel.replace("index.html", "") in open(sitemap, encoding="utf-8").read():
            fail(f"{rel}: страница с noindex присутствует в sitemap.xml")
        continue
    if 'rel="canonical"' not in text:
        fail(f"{rel}: нет canonical")
    if 'property="og:image"' not in text:
        fail(f"{rel}: нет og:image")
    url = "/" if rel == "index.html" else "/" + rel.replace("index.html", "")
    if not noindex and os.path.exists(sitemap) and url not in open(sitemap, encoding="utf-8").read():
        fail(f"{rel}: индексируемой страницы нет в sitemap.xml")
    for image in re.findall(r'property="og:image" content="([^"]+)"', text):
        image_path = urlparse(image).path
        if not os.path.isfile(os.path.join(ROOT, image_path.lstrip("/"))):
            fail(f"{rel}: og:image {image} не найден в репозитории")

# --- studio ----------------------------------------------------------------
studio_dir = os.path.join(ROOT, "studio")
if not os.path.isdir(studio_dir):
    fail("нет каталога public/studio")
else:
    for name in ("index.html", "login.html", "studio.js", "studio.css"):
        path = os.path.join(studio_dir, name)
        if not os.path.exists(path):
            fail(f"нет файла public/studio/{name}")
        elif name.endswith(".html"):
            text = open(path, encoding="utf-8").read()
            if "noindex" not in text:
                fail(f"public/studio/{name}: нет noindex")
    robots = open(os.path.join(ROOT, "robots.txt"), encoding="utf-8").read()
    if "Disallow: /studio/" not in robots:
        fail("robots.txt: нет Disallow: /studio/")
    if os.path.exists(os.path.join(ROOT, "sitemap.xml")):
        if "/studio" in open(os.path.join(ROOT, "sitemap.xml"), encoding="utf-8").read():
            fail("sitemap.xml: /studio не должен попадать в карту")

worker_src = open(os.path.join(REPO, "worker.js"), encoding="utf-8").read()
if "/studio" not in worker_src:
    fail("worker.js: нет маршрута /studio")
if "x-robots-tag" not in worker_src:
    fail("worker.js: нет X-Robots-Tag для /studio")

# --- обязательные файлы -----------------------------------------------------
for required in ("lib/lead.js", "worker.js", "wrangler.jsonc"):
    if not os.path.exists(os.path.join(REPO, required)):
        fail(f"нет файла {required}")
for required in ("404.html", "lead.js", "_redirects", "robots.txt", "sitemap.xml", "index.html"):
    if not os.path.exists(os.path.join(ROOT, required)):
        fail(f"нет файла public/{required}")

# --- функции и клиент -------------------------------------------------------
lead_js = os.path.join(ROOT, "lead.js")
if os.path.exists(lead_js):
    client = open(lead_js, encoding="utf-8").read()
    if "https://api.web3forms.com/submit" not in client:
        fail("lead.js: нет отправки в Web3Forms (email-канал)")
    if '"/api/lead"' not in client:
        fail("lead.js: нет отправки в /api/lead (Telegram-канал)")
    key = re.search(r'WEB3FORMS_KEY = "([^"]*)"', client)
    if not key or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", key.group(1)):
        fail("lead.js: WEB3FORMS_KEY пуст или не похож на access key")
    if re.search(r'WEB3FORMS_KEY = ""', client):
        fail("lead.js: WEB3FORMS_KEY не заполнен — email-канал молча не работает")

lead_lib = os.path.join(REPO, "lib", "lead.js")
if os.path.exists(lead_lib):
    server = open(lead_lib, encoding="utf-8").read()
    if "api.web3forms.com" in server:
        fail("lib/lead.js: Web3Forms нельзя вызывать с сервера (бесплатный тариф блокирует)")
    if "api.telegram.org" not in server:
        fail("lib/lead.js: нет отправки в Telegram")

worker_path = os.path.join(REPO, "worker.js")
if os.path.exists(worker_path):
    w = open(worker_path, encoding="utf-8").read()
    if "/api/lead" not in w:
        fail("worker.js: нет маршрута /api/lead")
    if "ASSETS.fetch" not in w:
        fail("worker.js: не раздаёт статику через env.ASSETS.fetch")

config_path = os.path.join(REPO, "wrangler.jsonc")
if os.path.exists(config_path):
    c = open(config_path, encoding="utf-8").read()
    if '"run_worker_first"' not in c:
        fail("wrangler.jsonc: без run_worker_first Worker не перехватит /api/*")
    if "404-page" not in c:
        fail("wrangler.jsonc: not_found_handling должен быть 404-page")
    if '"directory": "./public"' not in c:
        fail("wrangler.jsonc: ассеты должны раздаваться из корня репозитория")

print(f"страниц: {len(pages)}, внутренних ссылок проверено: {checked_links}, редиректов: {len(rules)}")
if problems:
    print(f"\nпроблемы ({len(problems)}):")
    for problem in problems:
        print("  -", problem)
    sys.exit(1)
print("проблем не найдено")
