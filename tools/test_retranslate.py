# -*- coding: utf-8 -*-
"""验证「换服务重译」：force 重译 2 条，看缓存是否被覆盖。"""
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from translate import _key  # noqa: E402

BASE = "http://127.0.0.1:8848"
CACHE = ROOT / "config" / "translations.json"

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8", "replace") or "{}")


call("POST", "/api/login", {"username": "YYQ", "password": "20000921"})
texts = ["Cracker Barrel names new CEO amid turnaround push",
         "Sweetgreen opens its first automated kitchen in Illinois"]

print("[前] 缓存里有吗:", [bool(json.loads(CACHE.read_text(encoding='utf-8')).get(_key(t, 'zh')))
                          for t in texts])
st, r = call("POST", "/api/translate/start", {"texts": texts, "lang": "zh", "force": True})
print("[启动] ", st, r)
for _ in range(20):
    time.sleep(1.2)
    st, s = call("GET", "/api/translate/status")
    if not s.get("running"):
        print("[结束]  code =", s.get("code"), "force =", s.get("force"))
        for line in s.get("log", []):
            print("        ", line)
        break
st, r = call("POST", "/api/translate/lookup", {"texts": texts, "lang": "zh"})
print("[后] 缓存命中:", r.get("cached"), "/", r.get("total"), " 待翻:", r.get("pending"))
for k, v in r["map"].items():
    print(f"   {k[:50]:<52} → {v}")
