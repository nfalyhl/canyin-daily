# -*- coding: utf-8 -*-
"""给已有的日报补翻译（不重新采集）。

把外网板块的标题/要点翻成指定语言，写回 digest JSON 的 item["tr"] 与
sections.global["tr"]，同时填充翻译缓存（config/translations.json）。
页面打开时如果后端缓存里有，就不用再翻一次。

用法：
    python tools\\translate_digest.py --lang zh
    python tools\\translate_digest.py --lang zh,ja --date 2026-09-25
    python tools\\translate_digest.py --lang zh --only-global-brief
"""
import argparse
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from translate import Translator, LANGS  # noqa: E402

DATA = ROOT / "public" / "data"
LANG_IDS = [k for k, _ in LANGS]
LANG_LABEL = dict(LANGS)


def main():
    ap = argparse.ArgumentParser(description="给已有日报补翻译")
    ap.add_argument("--lang", required=True, help="目标语言，逗号分隔：zh,zh-TW,en,ja,ko")
    ap.add_argument("--date", help="哪一期，默认最新一期")
    ap.add_argument("--only-global-brief", action="store_true",
                    help="只翻外网板块的今日要点（省额度）")
    args = ap.parse_args()

    langs = [x.strip() for x in args.lang.split(",") if x.strip()]
    bad = [x for x in langs if x not in LANG_IDS]
    if bad:
        raise SystemExit(f"不支持的语言：{bad}，可选：{LANG_IDS}")

    idx = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    date = args.date or idx["latest"]
    path = DATA / f"digest-{date}.json"
    if not path.exists():
        raise SystemExit(f"找不到 {path}")
    digest = json.loads(path.read_text(encoding="utf-8"))

    overseas = [i for i in digest["items"] if i.get("region") == "global"]
    sections = digest.get("sections") or {}
    gsec = sections.get("global") or {}
    briefs = [b["text"] for b in (gsec.get("brief") or []) if b.get("text")]
    print(f"期号 {digest.get('issue')}  {date}  外网 {len(overseas)} 条")

    tr = Translator()

    for lang in langs:
        texts = list(briefs)
        if not args.only_global_brief:
            for it in overseas:
                texts.append(it["title"])
                if it.get("summary"):
                    texts.append(it["summary"])
        texts = list(dict.fromkeys([t for t in texts if t]))
        print(f"\n→ {LANG_LABEL.get(lang, lang)}：{len(texts)} 条文本")
        got = tr.translate_many(texts, lang)
        m = dict(zip(texts, got))
        if not args.only_global_brief:
            for it in overseas:
                rec = it.setdefault("tr", {})
                rec[lang] = {"t": m.get(it["title"], it["title"]),
                             "s": m.get(it.get("summary") or "", it.get("summary") or "")}
        if briefs:
            gsec.setdefault("tr", {})[lang] = [m.get(b, b) for b in briefs]
        changed = sum(1 for a, b in zip(texts, got) if a != b)
        print(f"   完成：{changed}/{len(texts)} 条发生变化，本次联网 {tr.used_network} 次")
        if tr.errors:
            print(f"   警告：{tr.errors[:3]}")

    tr.save()
    path.write_text(json.dumps(digest, ensure_ascii=False), encoding="utf-8")
    print(f"\n已写回 {path}")
    print("（页面会直接从翻译缓存读，不用再翻）")


if __name__ == "__main__":
    main()
