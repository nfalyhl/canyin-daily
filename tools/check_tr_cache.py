# -*- coding: utf-8 -*-
"""用真实接口核一遍：整期外网文本的缓存命中情况。"""
import http.cookiejar
import json
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
BASE = "http://127.0.0.1:8848"

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                headers={"Content-Type": "application/json"})
    with op.open(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


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

for lang in ("zh", "en", "ja"):
    r = call("POST", "/api/translate/lookup", {"texts": texts, "lang": lang})
    print(f"  {lang}: 共 {r['total']} 条  已缓存 {r['cached']}  待翻译 {r['pending']}")
    if lang == "zh":
        hits = sum(1 for v in r["map"].values() if v)
        print(f"       有译文的条目 {hits}/{len(texts)}")
