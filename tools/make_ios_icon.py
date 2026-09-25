# -*- coding: utf-8 -*-
"""生成 iOS App 图标（1024×1024，不透明，符合 App Store 要求）。

iOS 会自己套圆角遮罩，所以图标必须是满幅不透明正方形。

用法：python tools/make_ios_icon.py
"""
import struct
import sys
import zlib
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUT = Path(__file__).resolve().parent.parent / "ios" / "CanyinDaily" / "Assets.xcassets" \
    / "AppIcon.appiconset" / "icon-1024.png"

BG = (20, 23, 27)
BARS = [(216, 67, 47), (27, 95, 193), (180, 116, 11)]
SS = 4
SIZE = 1024
BAR_SCALE = 0.62


def inside_round_rect(x, y, w, h, r):
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    if r <= 0:
        return True
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size=SIZE):
    bar_w = size * 0.108 * BAR_SCALE
    gap = size * 0.062 * BAR_SCALE
    total = bar_w * 3 + gap * 2
    x0 = (size - total) / 2.0
    h = size * 0.49 * BAR_SCALE
    y0 = size / 2.0 - h / 2.0
    boxes = [(x0 + i * (bar_w + gap), y0, bar_w, h) for i in range(3)]
    bar_r = bar_w / 2.0

    px = bytearray()
    step = 1.0 / SS
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    fx = x + (sx + 0.5) * step
                    fy = y + (sy + 0.5) * step
                    col = BG
                    for idx, b in enumerate(boxes):
                        if inside_round_rect(fx - b[0], fy - b[1], b[2], b[3], bar_r):
                            col = BARS[idx]
                            break
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
            n = SS * SS
            # iOS 图标不能带透明通道，所以输出 RGB 三通道（不用 alpha）
            px += bytes((int(round(acc[0] / n)), int(round(acc[1] / n)),
                         int(round(acc[2] / n))))
    return bytes(px)


def write_png(path, size, rgb):
    raw = b"".join(b"\x00" + rgb[y * size * 3:(y + 1) * size * 3] for y in range(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    path.parent.mkdir(parents=True, exist_ok=True)
    # color_type=2 表示 RGB（无 alpha），App Store 要求如此
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9))
                     + chunk(b"IEND", b""))


if __name__ == "__main__":
    write_png(OUT, SIZE, render())
    print(f"  ✓ {OUT}  {OUT.stat().st_size / 1024:.1f} KB")
