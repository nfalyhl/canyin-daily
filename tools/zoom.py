# -*- coding: utf-8 -*-
"""放大查看页面局部（用于检查票据撕口一类的细节）。"""
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PROJ = Path(r"C:\Users\Lenovo\Desktop\代码\canyin-daily")
TMP = Path(r"C:\Users\Lenovo\AppData\Local\Temp\cd-zoom")

W = 390
SCALE = 1.9
TOP = int(sys.argv[1]) if len(sys.argv) > 1 else 640
HEIGHT = int(sys.argv[2]) if len(sys.argv) > 2 else 420
SHIFT = sys.argv[3] if len(sys.argv) > 3 else "day"


def main():
    if TMP.exists():
        shutil.rmtree(TMP, ignore_errors=True)
    TMP.mkdir(parents=True, exist_ok=True)
    shutil.copytree(PROJ / "public", TMP / "site")
    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{{margin:0;background:#333;overflow:hidden}}
  .clip{{position:relative;width:{int(W*SCALE)}px;height:{int(HEIGHT*SCALE)}px;overflow:hidden}}
  .clip iframe{{position:absolute;left:0;top:{-int(TOP*SCALE)}px;width:{W}px;height:2400px;
    border:0;transform:scale({SCALE});transform-origin:0 0}}
</style></head><body>
<div class="clip"><iframe src="site/index.html?shift={SHIFT}"></iframe></div>
</body></html>"""
    p = TMP / "zoom.html"
    p.write_text(html, encoding="utf-8")
    out = TMP / "zoom.png"
    subprocess.run([
        EDGE, "--headless=new", "--disable-gpu", "--no-sandbox",
        f"--user-data-dir={TMP / 'profile'}", "--hide-scrollbars",
        "--force-device-scale-factor=1", "--virtual-time-budget=7000",
        f"--window-size={int(W*SCALE)},{int(HEIGHT*SCALE)}",
        f"--screenshot={out}", "file:///" + str(p).replace("\\", "/"),
    ], capture_output=True, timeout=120)
    print("  ✓" if out.exists() else "  ✗", out)


if __name__ == "__main__":
    main()
