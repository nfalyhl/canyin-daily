# -*- coding: utf-8 -*-
"""自检翻译接口：缓存查询、测试翻译、启动翻译任务。"""
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8848"
BASE = f"http://127.0.0.1:{PORT}"

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:200]}


st, r = call("POST", "/api/login", {"username": "YYQ", "password": "20000921"})
print("登录:", st, r.get("user"))

print("\n[1] 语言列表")
st, r = call("GET", "/api/translate/languages")
print(" ", st, [x["label"] for x in r.get("langs", [])])

print("\n[2] 设置（不回传 Key）")
st, r = call("GET", "/api/settings")
print(" ", st, {k: r.get(k) for k in ("provider", "scope", "has_key", "key_hint")})

print("\n[3] 缓存查询（尚无译文）")
texts = ["McDonald's is testing a new value menu to win back customers",
         "Starbucks announced Thursday it's closing about 250 North American stores"]
st, r = call("POST", "/api/translate/lookup", {"texts": texts, "lang": "zh"})
print(" ", st, "pending/cached =", r.get("pending"), "/", r.get("cached"))

print("\n[4] 试翻译一句（走当前 provider）")
st, r = call("POST", "/api/translate/test", {"text": texts[0], "langs": ["zh", "ja"]})
print(" ", st, r.get("provider"))
for x in r.get("results", []):
    print(f"    {x['lang']}: {x['text']}")

print("\n[5] 启动翻译任务（2 条 → 中文）")
st, r = call("POST", "/api/translate/start", {"texts": texts, "lang": "zh"})
print(" ", st, r)
for _ in range(20):
    time.sleep(1.5)
    st, s = call("GET", "/api/translate/status")
    if not s.get("running"):
        print("  结束:", s.get("code"), s.get("log"))
        break
    print(f"  进行中 {s.get('done')}/{s.get('total')}")

print("\n[6] 再查缓存")
st, r = call("POST", "/api/translate/lookup", {"texts": texts, "lang": "zh"})
print(" ", st, "pending/cached =", r.get("pending"), "/", r.get("cached"))
for k, v in r.get("map", {}).items():
    print(f"    {k[:46]:<48} → {v[:44]}")
