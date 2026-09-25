# -*- coding: utf-8 -*-
"""电脑端整页截图（单个 iframe，尺寸精确）。

用法：python tools/shot_desktop.py [宽] [高] [shift]
"""
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PROJ = Path(__file__).resolve().parent.parent
TMP = Path(r"C:\Users\Lenovo\AppData\Local\Temp\cd-desk")

W = int(sys.argv[1]) if len(sys.argv) > 1 else 1600
H = int(sys.argv[2]) if len(sys.argv) > 2 else 1150
SHIFT = sys.argv[3] if len(sys.argv) > 3 else "day"


def main():
    if TMP.exists():
        shutil.rmtree(TMP, ignore_errors=True)
    TMP.mkdir(parents=True, exist_ok=True)
    shutil.copytree(PROJ / "public", TMP / "site")
    (TMP / "wrap.html").write_text(
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        '<style>body{margin:0}iframe{border:0;display:block;width:%dpx;height:%dpx}'
        '</style></head><body><iframe src="site/index.html?shift=%s"></iframe></body></html>'
        % (W, H, SHIFT), encoding="utf-8")
    out = TMP / "desk.png"
    subprocess.run([
        EDGE, "--headless=new", "--disable-gpu", "--no-sandbox",
        f"--user-data-dir={TMP / 'p'}", "--hide-scrollbars",
        "--force-device-scale-factor=1", "--virtual-time-budget=7000",
        f"--window-size={W},{H}", f"--screenshot={out}",
        "file:///" + str(TMP / "wrap.html").replace("\\", "/"),
    ], capture_output=True, timeout=120)
    print(("  ✓ " if out.exists() else "  ✗ ") + str(out))


if __name__ == "__main__":
    main()
