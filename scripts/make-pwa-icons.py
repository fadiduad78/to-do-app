#!/usr/bin/env python3
"""scripts/make-pwa-icons.py — (re)generate the PWA icon set.

Draws the same mark as the favicon (white check on indigo #4f46e5 rounded
square): standard icons (192/512, corners baked) plus a MASKABLE 512 variant
(full-bleed square, mark inside the ~80% safe zone) for adaptive launchers.

Run after any brand change:  python3 scripts/make-pwa-icons.py
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public")
BG = (79, 70, 229, 255)          # --accent #4f46e5
WHITE = (255, 255, 255, 255)


def draw_mark(d, size, shrink=1.0):
    """Check polyline scaled from the 100-unit favicon geometry."""
    s = size / 100.0 * shrink
    ox = (size - 100 * s) / 2
    oy = ox
    w = max(2, int(round(10 * s)))
    pts = [(ox + 28 * s, oy + 52 * s), (ox + 44 * s, oy + 68 * s), (ox + 72 * s, oy + 36 * s)]
    # round caps/joints via ellipses at vertices
    for (x, y) in pts:
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=WHITE)
    d.line(pts, fill=WHITE, width=w, joint="curve")


def standard(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    draw_mark(d, size)
    img.save(path)


def maskable(size, path):
    img = Image.new("RGBA", (size, size), BG[:3] + (255,))
    d = ImageDraw.Draw(img)
    draw_mark(d, size, shrink=0.62)  # stay inside the masked safe zone
    img.save(path)


os.makedirs(OUT, exist_ok=True)
standard(192, os.path.join(OUT, "icon-192.png"))
standard(512, os.path.join(OUT, "icon-512.png"))
maskable(512, os.path.join(OUT, "icon-maskable-512.png"))
print("wrote icon-192.png, icon-512.png, icon-maskable-512.png into public/")
