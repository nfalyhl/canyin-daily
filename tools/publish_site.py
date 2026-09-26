# -*- coding: utf-8 -*-
"""把 public/ 发布成一个公网网址（GitHub Pages）。

GitHub Pages 只认仓库根目录 / 或 /docs 作为站点目录，而本项目的站点在 public/，
所以这里用标准做法：把 public/ 的内容发到独立的 **gh-pages 分支的根目录**，
再用 API 开启 Pages。之后每天采集完重跑一次就更新。

用到的 Git Data API 很少请求（约 20 次），比逐文件上传快得多：
  blobs → tree（无 base_tree，全新树）→ commit（无 parent，孤儿提交）→ ref

用法：
    $env:GITHUB_TOKEN = "ghp_xxx"
    python tools\\publish_site.py --dry-run
    python tools\\publish_site.py
"""
import argparse
import base64
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import publish_github as pg  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
SKIP = ("index.template.html", "data/seen.json", "data/meta.json")


def site_files():
    out = []
    for p in sorted(PUBLIC.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(PUBLIC).as_posix()
        if rel in SKIP or rel.startswith("."):
            continue
        out.append((rel, p))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="canyin-daily")
    ap.add_argument("--branch", default="gh-pages")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = site_files()
    total = sum(p.stat().st_size for _, p in files)
    print(f"站点文件 {len(files)} 个，共 {total / 1024:.0f} KB")
    for rel, p in files:
        print(f"   {rel:<44} {p.stat().st_size / 1024:>7.1f} KB")

    hits = pg.scan(files)
    if hits:
        print("\n!! 安全闸门拦下，站点里疑似有密钥，已中止")
        for rel, desc, sample in hits:
            print(f"   {rel} {desc} {sample}")
        sys.exit(2)
    print("\n安全检查通过 ✓")
    if args.dry_run:
        print("（--dry-run，不实际发布）")
        return

    st, me = pg.api("GET", "/user")
    if st != 200:
        print("Token 验证失败：", st, me)
        sys.exit(1)
    owner = me["login"]

    # 1) 逐个上传 blob
    tree = []
    for i, (rel, p) in enumerate(files, 1):
        content = base64.b64encode(p.read_bytes()).decode()
        st, r = pg.api("POST", f"/repos/{owner}/{args.repo}/git/blobs",
                       {"content": content, "encoding": "base64"})
        if st not in (201, 200) or "sha" not in r:
            print(f"   ✗ blob {rel}: {st} {str(r)[:120]}")
            sys.exit(1)
        tree.append({"path": rel, "mode": "100644", "type": "blob", "sha": r["sha"]})
        if i % 10 == 0:
            print(f"   … blob {i}/{len(files)}")

    # 2) 全新树（不带 base_tree，就是一份干净的站点快照）
    st, t = pg.api("POST", f"/repos/{owner}/{args.repo}/git/trees", {"tree": tree})
    if st not in (201, 200) or "sha" not in t:
        print("建树失败：", st, str(t)[:200])
        sys.exit(1)
    print(f"   tree {t['sha'][:8]}  {len(tree)} 个条目")

    # 3) 孤儿提交 + 4) 更新分支
    st, c = pg.api("POST", f"/repos/{owner}/{args.repo}/git/commits",
                   {"message": f"site: {len(files)} files", "tree": t["sha"]})
    if st not in (201, 200) or "sha" not in c:
        print("提交失败：", st, str(c)[:200])
        sys.exit(1)
    commit = c["sha"]

    st, _ = pg.api("POST", f"/repos/{owner}/{args.repo}/git/refs",
                   {"ref": f"refs/heads/{args.branch}", "sha": commit})
    if st not in (201, 200):
        st, r = pg.api("PATCH", f"/repos/{owner}/{args.repo}/git/refs/heads/{args.branch}",
                       {"sha": commit, "force": True})
        print(f"   分支更新: {st}")
    else:
        print(f"   分支已创建: {args.branch}")

    # 5) 开启 / 切换 Pages 到该分支
    st, r = pg.api("POST", f"/repos/{owner}/{args.repo}/pages",
                   {"source": {"branch": args.branch, "path": "/"}})
    if st in (201, 204):
        print("   Pages 已开启")
    elif st == 409:
        st, r = pg.api("PUT", f"/repos/{owner}/{args.repo}/pages",
                       {"source": {"branch": args.branch, "path": "/"}})
        print(f"   Pages 已切换到 {args.branch}: {st}")

    st, info = pg.api("GET", f"/repos/{owner}/{args.repo}/pages")
    url = info.get("html_url") if isinstance(info, dict) else None
    print(f"\n网址：{url or f'https://{owner}.github.io/{args.repo}/'}")
    print("GitHub 首次构建需要 1–2 分钟，之后每次重跑本脚本就会更新。")


if __name__ == "__main__":
    main()
