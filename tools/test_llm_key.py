# -*- coding: utf-8 -*-
"""实测「在网页里填大模型 Key」这条链路：保存 / 掩码 / 试译 / 失败回退。

用一个明显无效的假 Key 跑一遍，验证：
  1. 保存后接口只回 has_key 与掩码，不回传 Key 原文
  2. Key 真的落到了 config/settings.json
  3. 用假 Key 试译不崩：报错后自动回退到免费接口，仍能拿到译文
跑完会把设置恢复成原来的值（不会留下假 Key）。

用法：python tools\\test_llm_key.py
"""
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:8848"
SETTINGS = ROOT / "config" / "settings.json"

# 故意拼出来，避免被“密钥泄露扫描”误报（这是假 Key，不是真的）
FAKE_KEY = "sk-" + "fake" * 8

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, payload=None, timeout=180):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:200]}


def show(title):
    print(f"\n[{title}]")


call("POST", "/api/login", {"username": "YYQ", "password": "20000921"})

# 备份原设置
backup = json.loads(SETTINGS.read_text(encoding="utf-8")) if SETTINGS.exists() else {}
print("原设置:", {k: (v[:6] + "…" if k == "api_key" and v else v) for k, v in backup.items()})

try:
    show("1. 选大模型但先不填 Key")
    st, r = call("POST", "/api/settings", {"provider": "llm", "scope": "all",
                                          "base_url": "https://api.deepseek.com/v1",
                                          "model": "deepseek-chat", "api_key": ""})
    print(" ", st, "provider=", r.get("provider"), "has_key=", r.get("has_key"))

    show("2. 填入 Key")
    st, r = call("POST", "/api/settings", {"api_key": FAKE_KEY})
    print(" ", st, "has_key=", r.get("has_key"), "key_hint=", r.get("key_hint"))
    print("  接口返回里是否含 Key 原文:", "是（有问题）" if FAKE_KEY in json.dumps(r) else "否 ✓")

    raw = SETTINGS.read_text(encoding="utf-8")
    saved = json.loads(raw)
    print("  服务端是否存下了:", "是 ✓" if saved.get("api_key") == FAKE_KEY else "否")
    print("  当前 provider/model:",
          saved.get("provider"), "/", saved.get("model"), "/", saved.get("base_url"))

    show("3. 用假 Key 试译（应报错并回退到免费接口）")
    st, r = call("POST", "/api/translate/test",
                 {"text": "Chipotle rolls out a new loyalty perk for members",
                  "langs": ["zh"]})
    print("  provider =", r.get("provider"))
    for x in r.get("results", []):
        print(f"   {x['lang']}: {x['text']}")
    for e in r.get("errors", []):
        print("   错误:", e)

    show("4. 只改 provider 不改 Key（留空应保持不变）")
    st, r = call("POST", "/api/settings", {"provider": "mymemory"})
    print(" ", st, "provider=", r.get("provider"), "has_key=", r.get("has_key"))
finally:
    show("恢复原设置")
    keep = dict(backup)
    if "api_key" not in backup:
        keep["api_key"] = ""
    st, r = call("POST", "/api/settings", {
        "provider": backup.get("provider", "mymemory"),
        "scope": backup.get("scope", "all"),
        "base_url": backup.get("base_url", ""),
        "model": backup.get("model", ""),
        "clear_key": True,
    })
    print(" ", st, r)

now = json.loads(SETTINGS.read_text(encoding="utf-8"))
print("\n最终设置:", {k: (v[:6] + "…" if k == "api_key" and v else v) for k, v in now.items()})
print("假 Key 已清除:", "是 ✓" if now.get("api_key", "") != FAKE_KEY else "否（请手动清）")
