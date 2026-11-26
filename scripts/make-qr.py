#!/usr/bin/env python3
"""QR-код на страницу экспресс-аудита для презентаций и офлайн-ивентов.

    python scripts/make-qr.py                                  # /demo по умолчанию
    python scripts/make-qr.py --ev spb-2026 --caption "Ноябрь 2026"
    python scripts/make-qr.py --url "https://narrativeintelligence.ru/demo" --size 1200

Нужен пакет qrcode: pip install "qrcode[pil]"
Результат: qr/demo-<ev>.png и qr/demo-<ev>.svg (если установлен svg-бэкенд)
"""

import argparse
import os
import sys

try:
    import qrcode
    from qrcode.image.pil import PilImage
except ImportError:  # pragma: no cover
    print('нужен пакет: pip install "qrcode[pil]"', file=sys.stderr)
    raise SystemExit(1)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://narrativeintelligence.ru/demo"


def main() -> int:
    parser = argparse.ArgumentParser(description="QR на /demo")
    parser.add_argument("--url", default=BASE, help="адрес страницы")
    parser.add_argument("--ev", default="", help="метка события: добавляется как ?ev=")
    parser.add_argument("--caption", default="", help="подпись под кодом на картинке")
    parser.add_argument("--size", type=int, default=900, help="сторона PNG в пикселях")
    parser.add_argument("--box", type=int, default=10, help="размер модуля (чётный множитель)")
    parser.add_argument("--dark", default="#0b0b12", help="цвет модулей")
    parser.add_argument("--light", default="#ffffff", help="цвет фона")
    args = parser.parse_args()

    url = args.url
    if args.ev:
        url = f"{url}{'&' if '?' in url else '?'}ev={args.ev}"

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=args.box,
        border=4,
    )
    qr.add_data(url)
    qr.make(fit=True)

    image = qr.make_image(image_factory=PilImage, fill_color=args.dark, back_color=args.light)

    if args.caption:
        from PIL import Image, ImageDraw, ImageFont

        base = image.get_image() if hasattr(image, "get_image") else image
        width, height = base.size
        margin = 60
        canvas = Image.new("RGB", (width, height + margin), args.light)
        canvas.paste(base.convert("RGB"), (0, 0))
        draw = ImageDraw.Draw(canvas)
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 34)
        except OSError:
            font = ImageFont.load_default()
        text_width = draw.textlength(args.caption, font=font)
        draw.text(((width - text_width) / 2, height + 14), args.caption, font=font, fill=args.dark)
        base = canvas

    if base.size[0] != args.size:
        from PIL import Image

        ratio = args.size / base.size[0]
        base = base.resize((args.size, max(1, round(base.size[1] * ratio))), Image.LANCZOS)

    out_dir = os.path.join(REPO, "qr")
    os.makedirs(out_dir, exist_ok=True)
    name = f"demo-{args.ev}" if args.ev else "demo"
    png_path = os.path.join(out_dir, f"{name}.png")
    base.convert("RGB").save(png_path, "PNG", optimize=True)

    # векторный вариант — для печати афиш без потери резкости
    svg_path = os.path.join(out_dir, f"{name}.svg")
    qr_svg = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
    qr_svg.add_data(url)
    qr_svg.make(fit=True)
    modules = qr_svg.get_matrix()
    size = len(modules) * 10
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{args.size}" height="{args.size}">',
        f'<rect width="{size}" height="{size}" fill="{args.light}"/>',
    ]
    for row_index, row in enumerate(modules):
        for col_index, value in enumerate(row):
            if value:
                parts.append(f'<rect x="{col_index * 10}" y="{row_index * 10}" width="10" height="10" fill="{args.dark}"/>')
    parts.append("</svg>")
    with open(svg_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(parts))

    print(f"URL: {url}")
    print(f"{os.path.relpath(png_path, REPO)}  ({os.path.getsize(png_path) // 1024} КБ)")
    print(f"{os.path.relpath(svg_path, REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
