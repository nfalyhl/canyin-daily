# -*- coding: utf-8 -*-
"""把 classes.dex 合进 aapt2 产出的 APK，并保证 resources.arsc 未压缩。

Android 11+ 要求 resources.arsc 以「存储」方式打包且 4 字节对齐，否则安装会失败。
用法：python tools/apk_pack.py <base.apk> <classes.dex> <out.apk>
"""
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main():
    base, dex, out = sys.argv[1], sys.argv[2], sys.argv[3]
    with zipfile.ZipFile(base) as zin:
        infos = zin.infolist()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zout:
            for item in infos:
                name = item.filename
                if name == "classes.dex":
                    continue
                data = zin.read(name)
                if name == "resources.arsc":
                    zout.writestr(name, data, compress_type=zipfile.ZIP_STORED)
                else:
                    zout.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
            with open(dex, "rb") as f:
                zout.writestr("classes.dex", f.read(), compress_type=zipfile.ZIP_DEFLATED)

    with zipfile.ZipFile(out) as z:
        arsc = z.getinfo("resources.arsc")
        print(f"  · {out}")
        print(f"    entries={len(z.namelist())}  resources.arsc stored={arsc.compress_type == zipfile.ZIP_STORED}"
              f"  dex={z.getinfo('classes.dex').file_size} bytes")


if __name__ == "__main__":
    main()
