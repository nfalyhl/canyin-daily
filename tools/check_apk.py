# -*- coding: utf-8 -*-
"""检查产出的 APK 内容是否符合预期。"""
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
apk = sys.argv[1]

with zipfile.ZipFile(apk) as z:
    print(f"APK: {apk}")
    print(f"条目数: {len(z.namelist())}\n")
    for info in z.infolist():
        method = "STORED" if info.compress_type == zipfile.ZIP_STORED else "DEFLATE"
        print(f"  {info.filename:<42} {info.file_size:>8} -> {info.compress_size:>7}  {method}")

    print()
    for need in ("AndroidManifest.xml", "resources.arsc", "classes.dex",
                 "assets/index.html"):
        ok = need in z.namelist()
        print(("  ✓ " if ok else "  ✗ ") + need)
    icons = [n for n in z.namelist() if n.endswith("ic_launcher.png")]
    print(("  ✓ " if len(icons) >= 5 else "  ✗ ") + f"启动图标 {len(icons)} 档" +
          (f"（{', '.join(sorted(icons))}）" if icons else ""))

    html = z.read("assets/index.html").decode("utf-8", "replace")
    print(f"\n内置页面: {len(html)} 字符")
    for probe in ('id="boot-data"', 'id="boot-archive"', '"items"',
                  'AppBridge', 'canyin-shift', '<style>'):
        print(f"  {'✓' if probe in html else '✗'} {probe}")
    import re
    m = re.search(r'"date":"(\d{4}-\d{2}-\d{2})".*?"total":(\d+)', html)
    if m:
        print(f"  内置日报日期={m.group(1)} 条数={m.group(2)}")
    arsc = z.getinfo("resources.arsc")
    print(f"\nresources.arsc 是否未压缩: {arsc.compress_type == zipfile.ZIP_STORED}")
    # 4 字节对齐检查
    with open(apk, "rb") as f:
        data = f.read()
    off = arsc.header_offset
    local = data[off:off + 30]
    name_len, extra_len = int.from_bytes(local[26:28], "little"), int.from_bytes(local[28:30], "little")
    data_off = off + 30 + name_len + extra_len
    print(f"resources.arsc 数据偏移: {data_off}  4字节对齐: {data_off % 4 == 0}")
