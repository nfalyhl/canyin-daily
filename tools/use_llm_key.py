# -*- coding: utf-8 -*-
"""把 DeepSeek Key 配进系统：保存 → 拉模型列表 → 试译。

用法：python tools\\use_llm_key.py sk-xxxx
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
KEY = sys.argv[1] if len(sys.argv) > 1 else ""

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


call("POST", "/api/login", {"username": "YYQ", "password": "20000921"})

print("[1] 保存 Key 并切到大模型")
st, r = call("POST", "/api/settings", {
    "provider": "llm",
    "base_url": "https://api.deepseek.com/v1",
    "scope": "all",
    "api_key": KEY,
})
print("   ", st, "provider=", r.get("provider"), "has_key=", r.get("has_key"),
      "hint=", r.get("key_hint"))
print("    接口是否回传 Key 原文:", "是（有问题）" if KEY and KEY in json.dumps(r) else "否 ✓")

print("\n[2] 拉取可用模型列表")
st, r = call("POST", "/api/models", {})
if st == 200:
    models = r.get("models") or []
    print("   ", st, f"共 {len(models)} 个")
    for m in models[:14]:
        print("     -", m)
    guess = [m for m in models if "flash" in m.lower()] or \
            [m for m in models if "chat" in m.lower()] or models
    if guess:
        st2, r2 = call("POST", "/api/settings", {"model": guess[0]})
        print("    已选定模型:", r2.get("model"))
else:
    print("   ", st, r)
    raise SystemExit("拉取模型失败，先看错误信息")

print("\n[3] 试译（大模型）")
st, r = call("POST", "/api/translate/test", {
    "text": "KFC unveils 'Open House' prototype as a centerpiece of its U.S. comeback plan",
    "langs": ["zh", "ja"]})
print("   ", st, "provider =", r.get("provider"))
for x in r.get("results", []):
    print(f"     {x['lang']}: {x['text']}")
for e in r.get("errors", []):
    print("     错误:", e)

print("\n[4] 当前设置")
st, r = call("GET", "/api/settings")
print("   ", {k: r.get(k) for k in ("provider", "model", "base_url", "scope",
                                    "has_key", "key_hint")})
