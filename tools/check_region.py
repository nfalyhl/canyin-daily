# -*- coding: utf-8 -*-
"""核对内外网分区与要点区域标记是否正确。"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
p = Path(sys.argv[1] if len(sys.argv) > 1 else "public/data/digest-2026-09-25.json")
d = json.loads(p.read_text(encoding="utf-8"))

print("今日要点：")
for b in d["brief"]:
    print(f"  [{b.get('cat')}] [{b.get('region')}] {b.get('source')} :: {b['text'][:44]}")

print("\n每条资讯的区域 vs 来源（检查是否一致）：")
bad = []
for it in d["items"]:
    src, reg = it["source"], it.get("region")
    if src in ("Foodaily每日食品", "红餐网", "餐饮界", "赢商网", "新华网·食品", "每日经济新闻", "界面新闻", "钛媒体", "中国连锁经营协会", "职业餐饮网"):
        if reg != "cn":
            bad.append((src, reg))
    else:
        if reg != "global":
            bad.append((src, reg))
print("  不一致：", bad or "无")

print("\n外网来源分布：")
from collections import Counter
c = Counter(i["source"] for i in d["items"] if i.get("region") == "global")
for k, v in c.most_common():
    print(f"  {k:<28} {v}")
print("\n内网来源分布：")
c = Counter(i["source"] for i in d["items"] if i.get("region") == "cn")
for k, v in c.most_common():
    print(f"  {k:<28} {v}")
