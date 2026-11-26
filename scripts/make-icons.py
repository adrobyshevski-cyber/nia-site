#!/usr/bin/env python3
"""Иконки сайта: favicon, apple-touch-icon, иконка для манифеста.

Запуск: python scripts/make-icons.py   (нужен Pillow)
Результат: public/favicon-32.png, public/apple-touch-icon.png, public/icon-512.png, public/favicon.svg
"""

import os

from PIL import Image, ImageDraw, ImageFont

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "public")
BOLD = "C:/Windows/Fonts/segoeuib.ttf"

BG = (11, 11, 18)
VIOLET = (141, 123, 255)


def render(size: int, radius_ratio: float = 0.22) -> Image.Image:
    scale = 4  # рисуем крупно и уменьшаем — так края ровнее
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = int(big * radius_ratio)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=BG)

    # «NIA» крупно по центру; на малых размерах остаётся читаемая «N»
    text = "NIA" if size >= 48 else "N"
    font_size = int(big * (0.40 if text == "NIA" else 0.58))
    font = ImageFont.truetype(BOLD, font_size)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    x = (big - (right - left)) / 2 - left
    y = (big - (bottom - top)) / 2 - top
    draw.text((x, y), text, font=font, fill=VIOLET)

    return img.resize((size, size), Image.LANCZOS)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="NIA">
  <rect width="64" height="64" rx="14" fill="#0b0b12"/>
  <text x="32" y="43" text-anchor="middle" font-family="Segoe UI,Inter,Manrope,system-ui,sans-serif"
        font-size="28" font-weight="700" fill="#8d7bff">NIA</text>
</svg>
"""

targets = [(32, "favicon-32.png"), (180, "apple-touch-icon.png"), (512, "icon-512.png")]
for size, name in targets:
    path = os.path.join(OUT, name)
    render(size).save(path, "PNG", optimize=True)
    print(f"{name:24} {size}×{size}  {os.path.getsize(path) // 1024} КБ")

with open(os.path.join(OUT, "favicon.svg"), "w", encoding="utf-8", newline="\n") as handle:
    handle.write(SVG)
print("favicon.svg              64×64 (векторный)")
