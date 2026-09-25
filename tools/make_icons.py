# -*- coding: utf-8 -*-
"""生成 App 图标（纯标准库 PNG 编码，不依赖 Pillow）。

图形：深色圆角底 + 三根出餐工位色条（对应产品上新 / 行业趋势 / 品牌动作）。
用法：python tools/make_icons.py
"""
import struct
import sys
import zlib
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUT = Path(__file__).resolve().parent.parent / "public"

BG = (20, 23, 27)          # ink
BARS = [(216, 67, 47), (27, 95, 193), (180, 116, 11)]   # 产品上新 / 行业趋势 / 品牌动作
SS = 4                     # 超采样倍数（抗锯齿）


def inside_round_rect(x, y, w, h, r):
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    if r <= 0:
        return True
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def inside_round_bar(x, y, box, r):
    return inside_round_rect(x - box[0], y - box[1], box[2], box[3], r)


def render(size):
    """返回 RGBA bytes。"""
    radius = size * 0.223
    bar_w = size * 0.108
    gap = size * 0.062
    total = bar_w * 3 + gap * 2
    x0 = (size - total) / 2.0
    top = size * 0.255
    height = size * 0.49
    boxes = []
    for i in range(3):
        bx = x0 + i * (bar_w + gap)
        boxes.append((bx, top, bar_w, height))
    bar_r = bar_w / 2.0

    px = bytearray()
    step = 1.0 / SS
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            n = 0
            for sy in range(SS):
                for sx in range(SS):
                    fx = x + (sx + 0.5) * step
                    fy = y + (sy + 0.5) * step
                    n += 1
                    if not inside_round_rect(fx, fy, size, size, radius):
                        continue
                    col = None
                    for b in boxes:
                        if inside_round_bar(fx, fy, b, bar_r):
                            col = BARS[boxes.index(b)]
                            break
                    if col is None:
                        col = BG
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
                    acc[3] += 255.0
            if acc[3] <= 0:
                px += b"\x00\x00\x00\x00"
            else:
                a = acc[3] / n
                w = acc[3] / 255.0
                px += bytes((
                    int(round(acc[0] / w)),
                    int(round(acc[1] / w)),
                    int(round(acc[2] / w)),
                    int(round(a)),
                ))
    return bytes(px)


def write_png(path, width, height, rgba):
    raw = b"".join(
        b"\x00" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height)
    )

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        data = render(size)
        p = OUT / f"icon-{size}.png"
        write_png(p, size, size, data)
        print(f"  ✓ {p}  {p.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
