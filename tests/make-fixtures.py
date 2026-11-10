"""
Genera la imagen de prueba (un documento sobre un escritorio) que usan los
tests del detector.

Uso:
    python tests/make-fixtures.py

Requiere Pillow y numpy. Escribe `tests/doc-scene.png`.
"""

import os

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PNG = os.path.join(HERE, "doc-scene.png")

W, H = 720, 1280
DW, DH = 900, 1273

rng = np.random.default_rng(7)


def build_document():
    doc = Image.new("RGB", (DW, DH), (252, 251, 247))
    draw = ImageDraw.Draw(doc)
    draw.rectangle([0, 0, DW, 118], fill=(24, 58, 100))
    draw.rounded_rectangle([60, 38, 480, 58], radius=8, fill=(255, 255, 255))
    draw.rounded_rectangle([60, 72, 320, 86], radius=6, fill=(220, 230, 245))

    y = 175
    while y < DH - 150:
        width = int(140 + rng.random() * (DW - 240))
        height = 13 if rng.random() > 0.88 else 8
        draw.rounded_rectangle([60, y, 60 + width, y + height], radius=height // 2, fill=(30, 32, 38))
        y += height + 12 + int(rng.random() * 7)
        if rng.random() > 0.86:
            y += 24

    # Sello de color
    draw.ellipse([DW - 235, DH - 265, DW - 100, DH - 130], fill=(178, 32, 48))
    draw.rounded_rectangle([DW - 225, DH - 205, DW - 110, DH - 193], radius=6, fill=(255, 255, 255))

    # Sombra suave sobre el papel
    shadow = Image.new("L", (DW, DH), 0)
    shadow_draw = ImageDraw.Draw(shadow)
    for i in range(0, DW, 6):
        value = int(55 * (abs(i - DW / 2) / (DW / 2)) ** 1.6)
        shadow_draw.rectangle([i, 0, i + 6, DH], fill=value)
    shaded = Image.new("RGB", (DW, DH), (215, 210, 200))
    return Image.composite(shaded, doc, shadow.point(lambda v: int(v * 0.55)))


def build_desk():
    bg = np.zeros((H, W, 3), np.float32)
    for y in range(H):
        t = y / H
        bg[y, :, 0] = 74 - 34 * t
        bg[y, :, 1] = 59 - 28 * t
        bg[y, :, 2] = 45 - 22 * t
    bg += rng.normal(0, 7, (H, W, 1)).astype(np.float32)

    # Vetas de madera
    for _ in range(26):
        yy = int(rng.integers(0, H))
        amp = rng.uniform(1.5, 5)
        xs = np.arange(W)
        offset = (np.sin(xs / rng.uniform(40, 160) + rng.uniform(0, 6)) * amp).astype(int)
        bg[np.clip(yy + offset, 0, H - 1), xs, :] += 6

    return Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8))


def homography(frm, to):
    A = np.zeros((8, 8))
    b = np.zeros(8)
    for i in range(4):
        x, y = frm[i]
        u, v = to[i]
        A[2 * i] = [x, y, 1, 0, 0, 0, -x * u, -y * u]
        b[2 * i] = u
        A[2 * i + 1] = [0, 0, 0, x, y, 1, -x * v, -y * v]
        b[2 * i + 1] = v
    return np.linalg.solve(A, b)


def main():
    quad = np.array([[112, 232], [606, 208], [622, 932], [96, 950]], float)
    src = np.array([[0, 0], [DW, 0], [DW, DH], [0, DH]], float)

    scene = build_desk()
    doc = build_document()

    # PIL aplica la transformación desde las coordenadas de salida a las de entrada.
    coeffs = homography(quad, src)
    warped = doc.transform((W, H), Image.PERSPECTIVE, tuple(coeffs), resample=Image.BICUBIC)

    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).polygon([tuple(p) for p in quad], fill=255)
    scene.paste(warped, (0, 0), mask)

    # Luz, viñeta y ruido
    arr = np.asarray(scene).astype(np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    vignette = 1 - 0.28 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) ** 1.2
    arr *= np.clip(vignette, 0.55, 1)[:, :, None]
    arr += rng.normal(0, 5.5, (H, W, 1))
    scene = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

    scene.save(OUT_PNG)
    print(f"Listo: {OUT_PNG}")


if __name__ == "__main__":
    main()
