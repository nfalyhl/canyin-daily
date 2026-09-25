# -*- coding: utf-8 -*-
"""把 public/ 发布到 GitHub Pages，得到一个长期可用的公网地址。

不需要装 git / Node：全部走 GitHub REST API（api.github.com 在你的网络下可达）。
发布到「用户主页仓库」<用户名>.github.io，这类仓库推送后会自动上线，不用手动开 Pages。

准备：
    1. 打开 https://github.com/settings/tokens 生成 Token
       · 经典 Token：勾选 repo、workflow 即可
       · 细粒度 Token：Repository permissions 里给 Contents = Read and write、
         Pages = Read and write，Account permissions 给 Administration = Read and write
    2. 设置环境变量后再运行：
         $env:GITHUB_TOKEN = "ghp_xxx"
         python tools\\publish-pages.py

用法：
    python tools\\publish-pages.py                 # 发布最新一期
    python tools\\publish-pages.py --repo my-site  # 用普通仓库（需要 --enable-pages）
    python tools\\publish-pages.py --dry-run       # 只看会传哪些文件
"""
import argparse
import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
API = "https://api.github.com"
CTX = ssl.create_default_context()
UA = "canyin-daily-publisher"

SKIP = {".DS_Store", "Thumbs.db", ".deploy.json"}
# 这些是「联网版」才需要的，单文件版没必要传
SKIP_NAMES = {"index.template.html", "seen.json", "meta.json"}


def api(token, method, path, payload=None):
    url = path if path.startswith("http") else API + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "User-Agent": UA,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90, context=CTX) as r:
            body = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body).get("message", body)
        except Exception:
            msg = body
        return e.code, {"error": msg}


def collect_files():
    out = []
    for p in sorted(PUBLIC.rglob("*")):
        if not p.is_file() or p.name in SKIP or p.name in SKIP_NAMES:
            continue
        if any(part.startswith(".") for part in p.parts):
            continue
        out.append((p.relative_to(PUBLIC).as_posix(), p))
    return out


def upload(token, owner, repo, rel, path, branch):
    with open(path, "rb") as f:
        content = base64.b64encode(f.read()).decode("ascii")
    url = f"/repos/{owner}/{repo}/contents/{rel}"
    code, res = api(token, "GET", url + f"?ref={branch}")
    sha = res.get("sha") if code == 200 else None
    payload = {"message": f"update {rel}", "content": content, "branch": branch}
    if sha:
        payload["sha"] = sha
    code, res = api(token, "PUT", url, payload)
    if code not in (200, 201):
        return False, res.get("error", f"HTTP {code}")
    return True, "更新" if sha else "新增"


def main():
    ap = argparse.ArgumentParser(description="发布到 GitHub Pages")
    ap.add_argument("--token", default=os.environ.get("GITHUB_TOKEN", ""),
                    help="GitHub Token，默认读环境变量 GITHUB_TOKEN")
    ap.add_argument("--repo", default="", help="仓库名，默认 <用户名>.github.io")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = collect_files()
    if not files:
        raise SystemExit("public/ 里没有文件，先运行 python daily.py")
    total = sum(p.stat().st_size for _, p in files)
    print(f"待发布 {len(files)} 个文件，共 {total / 1024:.0f} KB")
    for rel, p in files:
        print(f"   {rel:<38} {p.stat().st_size / 1024:>7.1f} KB")

    if args.dry_run:
        return

    token = args.token.strip()
    if not token:
        raise SystemExit("\n! 缺少 GitHub Token。\n"
                         "  1) 打开 https://github.com/settings/tokens 生成（勾选 repo）\n"
                         "  2) $env:GITHUB_TOKEN = \"ghp_xxx\" 后重新运行")

    code, me = api(token, "GET", "/user")
    if code != 200:
        raise SystemExit(f"! Token 无效或网络不通：{code} {me.get('error')}")
    owner = me["login"]
    repo = args.repo or f"{owner}.github.io"
    print(f"\n账号: {owner}\n仓库: {repo}")

    code, res = api(token, "GET", f"/repos/{owner}/{repo}")
    if code == 404:
        print("  仓库不存在，创建中…")
        code, res = api(token, "POST", "/user/repos", {
            "name": repo, "private": False, "auto_init": True,
            "description": "餐饮日报 · 每日餐饮行业要点（自动生成）",
        })
        if code not in (200, 201):
            raise SystemExit(f"! 创建仓库失败：{code} {res.get('error')}")
        import time
        time.sleep(3)
    elif code != 200:
        raise SystemExit(f"! 读取仓库失败：{code} {res.get('error')}")

    ok = fail = 0
    for rel, p in files:
        good, msg = upload(token, owner, repo, rel, p, args.branch)
        print(f"   {'✓' if good else '✗'} {rel:<38} {msg}")
        ok += 1 if good else 0
        fail += 0 if good else 1

    # 用户主页仓库会自动上线；普通仓库需要显式开 Pages
    if repo != f"{owner}.github.io":
        code, res = api(token, "GET", f"/repos/{owner}/{repo}/pages")
        if code == 404:
            code, res = api(token, "POST", f"/repos/{owner}/{repo}/pages",
                            {"source": {"branch": args.branch, "path": "/"}})
            print(f"   Pages 开启：{code}")
        else:
            print("   Pages 已在运行")

    print(f"\n完成：成功 {ok} 个，失败 {fail} 个")
    print(f"网址：https://{owner}.github.io/" if repo == f"{owner}.github.io"
          else f"网址：https://{owner}.github.io/{repo}/")
    print("首次上线通常要等 1-2 分钟；手机上打开后可用「添加到主屏幕」。")
    if fail:
        raise SystemExit("有文件上传失败，请检查 Token 权限（需要 Contents 写权限）")


if __name__ == "__main__":
    main()
