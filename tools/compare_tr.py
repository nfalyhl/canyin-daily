# -*- coding: utf-8 -*-
"""对比数据里存着的旧译文（免费机翻）与缓存里的新译文（大模型）。"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from translate import _key  # noqa: E402

d = json.loads((ROOT / "public/data/digest-2026-09-25.json").read_text(encoding="utf-8"))
cache = json.loads((ROOT / "config/translations.json").read_text(encoding="utf-8"))

pairs = []
for it in d["items"]:
    if it.get("region") != "global":
        continue
    old = (it.get("tr") or {}).get("zh") or {}
    new_t = cache.get(_key(it["title"], "zh"), "")
    new_s = cache.get(_key(it.get("summary") or "", "zh"), "")
    if old.get("t") and new_t and old["t"] != new_t:
        pairs.append((it["title"], old["t"], new_t, old.get("s", ""), new_s))

print(f"标题译文发生变化的：{len(pairs)} 条\n")
for i, (src, old, new, os_, ns) in enumerate(pairs[:8]):
    print(f"[{i + 1}] EN : {src[:92]}")
    print(f"    旧 : {old[:92]}")
    print(f"    新 : {new[:92]}")
    if ns and os_ and ns != os_:
        print(f"    要点旧: {os_[:86]}")
        print(f"    要点新: {ns[:86]}")
    print()
