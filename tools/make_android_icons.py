# -*- coding: utf-8 -*-
"""生成 Android 启动图标（传统图标 + 自适应图标前景），纯标准库写 PNG。

传统图标：深色圆角底 + 三根工位色条
自适应前景：只有三根色条，画在 108dp 画布的 66dp 安全区内

用法：python tools/make_android_icons.py
"""
import struct
import sys
import zlib
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android" / "res"

BG = (20, 23, 27)
BARS = [(216, 67, 47), (27, 95, 193), (180, 116, 11)]
SS = 4

# 传统图标尺寸（px）
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# 自适应图标画布 = 108dp
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def inside_round_rect(x, y, w, h, r):
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    if r <= 0:
        return True
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def bar_boxes(size, scale, cy_ratio=0.5):
    bar_w = size * 0.108 * scale
    gap = size * 0.062 * scale
    total = bar_w * 3 + gap * 2
    x0 = (size - total) / 2.0
    h = size * 0.49 * scale
    y0 = size * cy_ratio - h / 2.0
    return [(x0 + i * (bar_w + gap), y0, bar_w, h) for i in range(3)], bar_w / 2.0


def render(size, rounded_bg, bar_scale):
    """rounded_bg=True 时时画出圆角底色（传统图标）；否则背景透明。"""
    boxes, bar_r = bar_boxes(size, bar_scale)
    radius = size * 0.223 if rounded_bg else 0
    px = bytearray()
    step = 1.0 / SS
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            n = SS * SS
            for sy in range(SS):
                for sx in range(SS):
                    fx = x + (sx + 0.5) * step
                    fy = y + (sy + 0.5) * step
                    if rounded_bg and not inside_round_rect(fx, fy, size, size, radius):
                        continue
                    col = None
                    for b in boxes:
                        if inside_round_rect(fx - b[0], fy - b[1], b[2], b[3], bar_r):
                            col = BARS[boxes.index(b)]
                            break
                    if col is None:
                        if not rounded_bg:
                            continue
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
                px += bytes((int(round(acc[0] / w)), int(round(acc[1] / w)),
                             int(round(acc[2] / w)), int(round(a))))
    return bytes(px)


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9))
                     + chunk(b"IEND", b""))


def main():
    for name, size in LEGACY.items():
        data = render(size, True, 1.0)
        write_png(RES / f"mipmap-{name}" / "ic_launcher.png", size, data)
        write_png(RES / f"mipmap-{name}" / "ic_launcher_round.png", size, data)
        print(f"  ✓ mipmap-{name}/ic_launcher.png  {size}px")
    for name, size in ADAPTIVE.items():
        data = render(size, False, 0.62)   # 0.62 让色条落在 66dp 安全区内
        write_png(RES / f"mipmap-{name}" / "ic_launcher_fg.png", size, data)
        print(f"  ✓ mipmap-{name}/ic_launcher_fg.png  {size}px")


if __name__ == "__main__":
    main()
