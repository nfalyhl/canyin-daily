# -*- coding: utf-8 -*-
"""用无头 Edge 截图自检页面。

Chrome/Edge 的 headless 有最小窗口宽度，直接 --window-size=390 会被强制放大，
所以这里用一个 iframe 容器精确模拟手机视口。
"""
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PROJ = Path(r"C:\Users\Lenovo\Desktop\代码\canyin-daily")
TMP = Path(r"C:\Users\Lenovo\AppData\Local\Temp\cd-shot")

FRAME = """<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{{margin:0;background:#5b6068;font:12px monospace;display:flex;gap:14px;padding:12px}}
  figure{{margin:0}}
  figcaption{{color:#fff;padding:4px 0}}
  iframe{{border:0;background:#fff;display:block}}
</style></head><body>
{blocks}
</body></html>"""


def main():
    sizes = [(390, 1560, "mobile"), (820, 1100, "desktop")]
    if TMP.exists():
        shutil.rmtree(TMP, ignore_errors=True)
    TMP.mkdir(parents=True, exist_ok=True)
    shutil.copytree(PROJ / "public", TMP / "site")

    q = sys.argv[1] if len(sys.argv) > 1 else ""
    blocks = "\n".join(
        f'<figure><figcaption>{w}×{h} {name}</figcaption>'
        f'<iframe src="site/index.html{q}" width="{w}" height="{h}"></iframe></figure>'
        for w, h, name in sizes
    )
    wrapper = TMP / "frame.html"
    wrapper.write_text(FRAME.format(blocks=blocks), encoding="utf-8")

    out = TMP / "shot.png"
    total_w = sum(w for w, _, _ in sizes) + 14 * 3 + 24
    total_h = max(h for _, h, _ in sizes) + 60
    subprocess.run([
        EDGE, "--headless=new", "--disable-gpu", "--no-sandbox",
        f"--user-data-dir={TMP / 'profile'}", "--hide-scrollbars",
        "--force-device-scale-factor=1", "--virtual-time-budget=7000",
        f"--window-size={total_w},{total_h}",
        f"--screenshot={out}",
        "file:///" + str(wrapper).replace("\\", "/"),
    ], capture_output=True, timeout=120)
    print("  ✓" if out.exists() else "  ✗", out)


if __name__ == "__main__":
    main()
