# -*- coding: utf-8 -*-
"""查看日报里的内外网、品牌与市场格局数据。"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
p = Path(sys.argv[1] if len(sys.argv) > 1 else "public/data/digest-2026-09-25.json")
d = json.loads(p.read_text(encoding="utf-8"))

print(f"日期 {d['date']}  共 {d['total']} 条")
print(f"内外网: {d.get('region_counts')}")
print(f"板块: {d['counts']}")
print(f"高频词: {d.get('keywords')}")

m = d.get("market") or {}
print(f"\n=== 品类综合格局（{m.get('formula')}）===")
print(f"{'品类':<10}{'条数':>5}{'品牌数':>7}{'门店合计':>10}{'热度':>8}{'规模':>8}{'综合':>8}")
for c in (m.get("cats") or [])[:12]:
    print(f"{c['label']:<10}{c['items']:>5}{c['brands']:>7}{c['stores']:>10}"
          f"{c['heat']*100:>7.1f}%{c['stores_share']*100:>7.1f}%{c['composite']*100:>7.1f}%")

print("\n=== 品牌提及 TOP15 ===")
for b in (m.get("brand_top") or [])[:15]:
    print(f"  {b['name']:<16} {b['count']:>2} 次  [{b['cat']}]")

print("\n=== 抽到的规模数字 ===")
for s in (m.get("scales") or [])[:14]:
    print(f"  {s['kind']:<8}{s['value']:<12} {s['brand'] or '(无品牌)':<14} {s['source']}")

print("\n=== 外网样本 ===")
for it in [i for i in d["items"] if i.get("region") == "global"][:5]:
    print(f"  · {it['title'][:76]}")
    print(f"    {it['source']} | {it.get('brands')} | {it.get('bcats')} | {it.get('scales')}")
    if it.get("summary"):
        print(f"    要点: {it['summary'][:100]}")

print("\n=== 内网样本 ===")
for it in [i for i in d["items"] if i.get("region") == "cn"][:4]:
    print(f"  · {it['title'][:60]}")
    print(f"    {it['source']} | {it.get('brands')} | {it.get('bcats')}")
