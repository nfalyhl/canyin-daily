# -*- coding: utf-8 -*-
"""iOS 工程自检（在 Windows 上能验的先全验一遍）。

检查项：
  1. Info.plist 能否解析、必需键是否齐全
  2. Assets.xcassets 的 Contents.json 是否合法
  3. App 图标：1024×1024、不能带透明通道（App Store 会拒）
  4. Bundle ID 三处是否一致
  5. project.yml 与工作流 YAML 是否合法
  6. Swift 源码基本结构（@main / 桥接名 / 括号配平）
  7. www/index.html 是否已就位

用法：python tools\\check_ios.py
"""
import json
import plistlib
import re
import struct
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
IOS = ROOT / "ios"
APP = IOS / "CanyinDaily"
BUNDLE_ID = "com.canyindaily.app"

ok, warn, bad = [], [], []


def check(cond, msg_ok, msg_bad, hard=True):
    if cond:
        ok.append(msg_ok)
    else:
        (bad if hard else warn).append(msg_bad)
    return cond


# 1. Info.plist
plist_path = APP / "Info.plist"
try:
    with open(plist_path, "rb") as f:
        pl = plistlib.load(f)
    check(True, "Info.plist 解析通过", "")
    for key in ("CFBundleDisplayName", "CFBundleIdentifier", "CFBundleShortVersionString",
                "CFBundleVersion", "CFBundleIconName", "UILaunchScreen",
                "UISupportedInterfaceOrientations", "NSAppTransportSecurity",
                "ITSAppUsesNonExemptEncryption"):
        check(key in pl, f"  · 含 {key}", f"  · 缺 {key}")
    check(pl.get("CFBundleDisplayName") == "餐饮日报",
          f"  · 应用名 = {pl.get('CFBundleDisplayName')}", "  · 应用名不是「餐饮日报」", False)
    check(pl.get("ITSAppUsesNonExemptEncryption") is False,
          "  · 已声明不使用非豁免加密（省掉上传时的出口合规问答）",
          "  · 缺 ITSAppUsesNonExemptEncryption，上传时会多问一轮", False)
except Exception as e:
    check(False, "", f"Info.plist 解析失败：{e}")

# 2. Assets
for p in APP.glob("Assets.xcassets/**/Contents.json"):
    try:
        json.loads(p.read_text(encoding="utf-8"))
        ok.append(f"  · {p.relative_to(APP)} 合法")
    except Exception as e:
        bad.append(f"  · {p.relative_to(APP)} 非法：{e}")

# 3. 图标
icon = APP / "Assets.xcassets/AppIcon.appiconset/icon-1024.png"
if icon.exists():
    raw = icon.read_bytes()
    w, h = struct.unpack(">II", raw[16:24])
    bit_depth, color_type = raw[24], raw[25]
    check((w, h) == (1024, 1024), f"图标 {w}×{h} ✓", f"图标尺寸不对：{w}×{h}")
    check(color_type == 2, "图标为 RGB（无透明通道）✓",
          f"图标带透明通道（color_type={color_type}），App Store 会拒", False)
else:
    bad.append("缺 AppIcon.appiconset/icon-1024.png（跑 python tools/make_ios_icon.py）")

# 4. Bundle ID 一致性
yml = (IOS / "project.yml").read_text(encoding="utf-8")
check(f"PRODUCT_BUNDLE_IDENTIFIER: {BUNDLE_ID}" in yml,
      f"project.yml 的 Bundle ID = {BUNDLE_ID}", "project.yml 的 Bundle ID 不是 " + BUNDLE_ID)
pd = (APP / "Info.plist").read_bytes().decode("utf-8", "replace")
check("$(PRODUCT_BUNDLE_IDENTIFIER)" in pd or BUNDLE_ID in pd,
      "Info.plist 引用 $(PRODUCT_BUNDLE_IDENTIFIER)", "Info.plist 的 Bundle ID 写法不对")
rd = (IOS / "README.md").read_text(encoding="utf-8")
check(BUNDLE_ID in rd, "README 里记的 Bundle ID 一致", "README 里的 Bundle ID 不一致", False)

# 5. YAML
try:
    import yaml
    for f in (IOS / "project.yml", ROOT / ".github/workflows/ios-testflight.yml"):
        yaml.safe_load(f.read_text(encoding="utf-8"))
        ok.append(f"  · {f.relative_to(ROOT)} YAML 合法")
except ImportError:
    warn.append("没装 pyyaml，跳过 YAML 校验")
except Exception as e:
    bad.append(f"YAML 非法：{e}")

# 6. Swift
for name in ("AppDelegate.swift", "WebViewController.swift"):
    src = (APP / name).read_text(encoding="utf-8")
    check(src.count("{") == src.count("}"),
          f"  · {name} 括号配平（{src.count('{')} 对）", f"  · {name} 括号不配平")
ws = (APP / "WebViewController.swift").read_text(encoding="utf-8")
check("@main" in (APP / "AppDelegate.swift").read_text(encoding="utf-8"),
      "  · AppDelegate 有 @main", "  · AppDelegate 缺 @main")
check("appBridge" in ws, "  · 原生桥接名 appBridge 存在", "  · 找不到 appBridge")
for m in ("isApp", "share", "setRemote", "reload", "setStatusBarColor"):
    check(m in ws, f"  · 桥接方法 {m} 已实现", f"  · 桥接缺方法 {m}", False)
# 页面侧用的接口名必须和 iOS 注入的一致
appjs = (ROOT / "public/app.js").read_text(encoding="utf-8")
for m in ("isApp", "getRemote", "setRemote", "reload", "share", "setStatusBarColor"):
    check(f"AppBridge.{m}" in appjs or f"window.AppBridge" in appjs,
          f"  · 页面调用 AppBridge.{m} 一致", f"  · 页面没调用 AppBridge.{m}", False)

# 7. 内置页面
www = APP / "www/index.html"
if www.exists():
    n = www.stat().st_size
    check(n > 50_000, f"  · www/index.html 已就位（{n // 1024} KB）",
          f"  · www/index.html 太小（{n} 字节）")
else:
    warn.append("www/index.html 还没生成（工作流会自动拷 public/offline.html；"
                "本地也可跑 ios\\prepare.ps1）")

print("=" * 74)
print(f"通过 {len(ok)} 项")
if warn:
    print(f"\n提醒（不影响构建）：")
    for w in warn:
        print("  ⚠ " + w)
if bad:
    print(f"\n必须修的问题：")
    for b in bad:
        print("  ✗ " + b)
print("\n明细：")
for o in ok:
    print("  " + o)
print("=" * 74)
print("结论：" + ("工程结构没问题，可以进 GitHub Actions 构建流程" if not bad
                 else f"还有 {len(bad)} 个问题要先修"))
sys.exit(1 if bad else 0)
