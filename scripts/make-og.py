#!/usr/bin/env python3
"""Генерация OG-картинок 1200×630 для соцсетей и мессенджеров.

Запуск: python scripts/make-og.py   (нужен Pillow: pip install Pillow)
Результат: public/og/*.png
"""

import os
from PIL import Image, ImageDraw, ImageFont

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "public", "og")
FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REGULAR = "C:/Windows/Fonts/segoeui.ttf"
FONT_LIGHT = "C:/Windows/Fonts/segoeuil.ttf"

W, H = 1200, 630
BG = (11, 11, 18)
VIOLET = (141, 123, 255)
LAVENDER = (186, 169, 255)
WHITE = (246, 245, 250)
MUTED = (166, 163, 182)

CARDS = [
    {
        "file": "agency.png",
        "eyebrow": "NARRATIVE INTELLIGENCE AGENCY",
        "title": ["Создаём смыслы,", "которые увеличивают", "ценность бизнеса."],
        "footer": "Направления · Методология · Бесплатный аудит",
    },
    {
        "file": "audit.png",
        "eyebrow": "NIA / NARRATIVE AUDIT",
        "title": ["Бесплатный аудит", "публичного нарратива", "вашего бренда."],
        "footer": "Desk research · Противоречия · Рекомендации",
    },
    {
        "file": "brand.png",
        "eyebrow": "NIA / DISSOLVED BRAND",
        "title": ["Бренд, который", "создают и развивают", "ваши клиенты."],
        "footer": "Смысловая архитектура · Механики участия · AI-поддержка",
    },
    {
        "file": "insights.png",
        "eyebrow": "NIA / INSIGHTS",
        "title": ["Как смыслы", "создают", "экономическую ценность."],
        "footer": "Narrative Economics · Brands & Markets",
    },
]


def glow(size, color, center, radius):
    """Мягкое радиальное свечение без внешних зависимостей."""
    mask = Image.radial_gradient("L").resize((radius * 2, radius * 2), Image.BICUBIC)
    mask = mask.point(lambda v: max(0, 255 - v) // 3)
    layer = Image.new("RGB", (radius * 2, radius * 2), color)
    canvas = Image.new("RGB", size, BG)
    canvas.paste(layer, (center[0] - radius, center[1] - radius), mask)
    return canvas


def build(card):
    img = glow((W, H), (58, 46, 110), (900, 120), 700)
    img = Image.blend(img, glow((W, H), (32, 26, 62), (140, 620), 620), 0.55)
    draw = ImageDraw.Draw(img)

    # рамка-акцент
    draw.line([(72, 96), (72, 534)], fill=VIOLET, width=3)

    eyebrow = ImageFont.truetype(FONT_BOLD, 19)
    draw.text((112, 100), card["eyebrow"], font=eyebrow, fill=LAVENDER)

    title_font = ImageFont.truetype(FONT_BOLD, 62)
    y = 158
    for line in card["title"]:
        draw.text((112, y), line, font=title_font, fill=WHITE)
        y += 78

    footer = ImageFont.truetype(FONT_REGULAR, 24)
    draw.text((112, 500), card["footer"], font=footer, fill=MUTED)

    # подпись домена
    domain = ImageFont.truetype(FONT_BOLD, 24)
    text_w = draw.textlength("narrativeintelligence.ru", font=domain)
    draw.text((W - 72 - text_w, 100), "narrativeintelligence.ru", font=domain, fill=LAVENDER)

    # марка NIA в правом нижнем углу
    mark = ImageFont.truetype(FONT_BOLD, 92)
    mark_w = draw.textlength("NIA", font=mark)
    draw.text((W - 72 - mark_w, 470), "NIA", font=mark, fill=(58, 52, 92))

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, card["file"])
    img.save(path, "PNG", optimize=True)
    return path, os.path.getsize(path)


for card in CARDS:
    path, size = build(card)
    print(f"{os.path.relpath(path, REPO)}  {size // 1024} КБ")
