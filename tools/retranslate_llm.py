# -*- coding: utf-8 -*-
"""用大模型把本期外网内容重译一遍，并打印前后对比。"""
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


def call(method, path, payload=None, timeout=300):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                headers={"Content-Type": "application/json"})
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8", "replace") or "{}")


call("POST", "/api/login", {"username": "YYQ", "password": "20000921"})

d = json.loads((ROOT / "public/data/digest-2026-09-25.json").read_text(encoding="utf-8"))
g = d["sections"]["global"]
texts = [b["text"] for b in g["brief"] if b.get("text")]
for it in d["items"]:
    if it.get("region") == "global":
        texts.append(it["title"])
        if it.get("summary"):
            texts.append(it["summary"])
texts = list(dict.fromkeys(texts))

old_cache = json.loads(CACHE.read_text(encoding="utf-8"))
before = {t: old_cache.get(_key(t, "zh"), "") for t in texts}

print(f"待重译 {len(texts)} 条（用大模型，覆盖旧译文）")
st, r = call("POST", "/api/translate/start", {"texts": texts, "lang": "zh", "force": True})
print("启动:", st, r)
t0 = time.time()
while time.time() - t0 < 600:
    time.sleep(4)
    st, s = call("GET", "/api/translate/status")
    if not s.get("running"):
        print(f"结束（{int(time.time() - t0)} 秒）code =", s.get("code"))
        for line in s.get("log", []):
            print("   ", line)
        break
    print(f"   进度 {s.get('done')}/{s.get('total')}", flush=True)

after = json.loads(CACHE.read_text(encoding="utf-8"))
print("\n===== 前后对比（免费机翻 → 大模型）=====")
shown = 0
for t in texts:
    a, b = before.get(t, ""), after.get(_key(t, "zh"), "")
    if a and b and a != b:
        print(f"\n  EN : {t[:88]}")
        print(f"  旧 : {a[:88]}")
        print(f"  新 : {b[:88]}")
        shown += 1
    if shown >= 6:
        break

changed = sum(1 for t in texts if before.get(t) and after.get(_key(t, "zh"))
              and before[t] != after.get(_key(t, "zh")))
print(f"\n共 {len(texts)} 条，其中 {changed} 条译文发生变化")
