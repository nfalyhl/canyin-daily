# -*- coding: utf-8 -*-
"""在终端里查看某一天日报的内容，用于排查采集与分类效果。

用法：
    python tools/peek.py                        # 看最新一期
    python tools/peek.py public/data/digest-2026-09-21.json
"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent

if len(sys.argv) > 1:
    path = Path(sys.argv[1])
else:
    idx = ROOT / "public" / "data" / "index.json"
    latest = json.loads(idx.read_text(encoding="utf-8"))["latest"] if idx.exists() else None
    path = ROOT / "public" / "data" / f"digest-{latest}.json"

d = json.loads(path.read_text(encoding="utf-8"))
print(f"文件: {path}")
print(f"期号: {d.get('issue')} | 日期: {d['date']} | 共 {d['total']} 条")
print(f"HEADLINE: {d['headline']}")
print(f"KEYWORDS: {d.get('keywords')}")
print("\n今日要点:")
for b in d["brief"]:
    print(f"  [{b['cat']:<7}] {b['text']}   —— {b['source']}")
for c in ("product", "trend", "brand"):
    items = [i for i in d["items"] if i["cat"] == c]
    print("\n" + "=" * 78)
    print(f"### {c}  ({len(items)} 条)")
    for it in items:
        print(f"  ({it['score']:>5}) {it['no']:>2}. {it['title'][:62]}")
        print(f"          src={it['source']} tags={it['tags']} pub={it['published'][:16]}")
        if it.get("summary"):
            print(f"          要点: {it['summary'][:112]}")
