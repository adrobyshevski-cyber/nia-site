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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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

# --- обязательные файлы -----------------------------------------------------
for required in ("functions/api/lead.js", "lead.js", "_redirects", "robots.txt"):
    if not os.path.exists(os.path.join(ROOT, required)):
        fail(f"нет файла {required}")

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

function_js = os.path.join(ROOT, "functions", "api", "lead.js")
if os.path.exists(function_js):
    server = open(function_js, encoding="utf-8").read()
    if "api.web3forms.com" in server:
        fail("functions/api/lead.js: Web3Forms нельзя вызывать с сервера (бесплатный тариф блокирует)")
    if "api.telegram.org" not in server:
        fail("functions/api/lead.js: нет отправки в Telegram")

print(f"страниц: {len(pages)}, внутренних ссылок проверено: {checked_links}, редиректов: {len(rules)}")
if problems:
    print(f"\nпроблемы ({len(problems)}):")
    for problem in problems:
        print("  -", problem)
    sys.exit(1)
print("проблем не найдено")
