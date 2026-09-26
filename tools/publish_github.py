# -*- coding: utf-8 -*-
"""把项目推到 GitHub（建仓库 → 上传源码 → 可选写 Actions Secrets / 开 Pages）。

为什么要用这个脚本而不是 git push：
  1. 你的网络下 GitHub 直连不通，走 API 更稳（api.github.com 可达）
  2. 脚本内置**安全闸门**：上传前会扫一遍文件内容，
     发现 API Key（sk-…）之类的东西就直接中止，绝不把 Key 推上去

用法：
    $env:GITHUB_TOKEN = "ghp_xxx"
    python tools\\publish_github.py --dry-run          # 先看会上传哪些文件
    python tools\\publish_github.py                    # 真的推
    python tools\\publish_github.py --repo canyin-daily --pages

Token 权限（细粒度即可）：
    Contents: Read and write
    Administration: Read and write   （建仓库用）
    Secrets: Read and write          （要写 Actions Secrets 才需要）
    Pages: Read and write            （要开 Pages 才需要）

若要顺便写入 Actions Secrets（给 iOS TestFlight 用），先准备好这两个环境变量：
    $env:ASC_KEY_ID $env:ASC_ISSUER_ID $env:ASC_KEY_P8 $env:APPLE_TEAM_ID
"""
import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
API = "https://api.github.com"

# 绝不外传的目录/文件（和 .gitignore 对应，这里再硬编码一遍防止误传）
EXCLUDE_DIRS = ("config", "logs", "__pycache__", ".git", ".vscode", ".idea",
                "android/keystore", "android/build")
EXCLUDE_FILES = ("public/data/seen.json", "public/data/meta.json", "public/index.template.html")
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".idsig", ".log")

# 上传前的敏感内容扫描：命中就直接中止
SECRET_PATTERNS = [
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "疑似 API Key（sk-…）"),
    (re.compile(r'"api_key"\s*:\s*"[^"]{12,}"'), "settings.json 里的 api_key"),
    (re.compile(r'"hash"\s*:\s*"[0-9a-f]{40,}"'), "账号密码哈希"),
]


def token() -> str:
    """取 GitHub 凭据：优先环境变量，其次用 git 已保存的凭据（不需要你手动填）。"""
    t = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    if t:
        return t
    try:
        import subprocess
        p = subprocess.run(["git", "credential", "fill"],
                           input="protocol=https\nhost=github.com\n\n",
                           capture_output=True, text=True, timeout=20)
        for line in (p.stdout or "").splitlines():
            if line.startswith("password="):
                t = line.split("=", 1)[1].strip()
                if t:
                    print("（使用 git 里已保存的 GitHub 凭据）")
                    return t
    except Exception:
        pass
    print("没有找到 GitHub 凭据。两种办法：")
    print("  1. 设置环境变量：$env:GITHUB_TOKEN = 'ghp_xxx'")
    print("  2. 或者让 git 记住一次：git config --global credential.helper manager")
    sys.exit(1)


def api(method, path, payload=None, raw=None, ctype="application/json", tries=3):
    """调 GitHub API。网络不稳定，超时/SSL 中断自动重试。"""
    url = path if path.startswith("http") else API + path
    data = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, method=method,
                                    headers={"Authorization": "Bearer " + token(),
                                             "Accept": "application/vnd.github+json",
                                             "User-Agent": "canyin-publish",
                                             "Content-Type": ctype})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read().decode("utf-8", "replace")
                return r.status, (json.loads(body) if body.strip() else {})
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if e.code >= 500 and attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
                last = (e.code, {"message": body[:200]})
                continue
            try:
                return e.code, json.loads(body)
            except Exception:
                return e.code, {"message": body[:300]}
        except Exception as e:
            last = (0, {"message": f"{type(e).__name__}: {e}"})
            if attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
    return last


def remote_sizes(owner, repo, branch):
    """取远端已存在的文件及其大小，用来跳过已上传的。"""
    st, t = api("GET", f"/repos/{owner}/{repo}/git/trees/{branch}?recursive=1")
    if st != 200 or not isinstance(t, dict):
        return {}
    return {e["path"]: e.get("size") for e in t.get("tree", []) if e.get("type") == "blob"}


def collect_files():
    out = []
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT).as_posix()
        if any(rel == d or rel.startswith(d + "/") for d in EXCLUDE_DIRS):
            continue
        if rel in EXCLUDE_FILES or rel.endswith(EXCLUDE_SUFFIX):
            continue
        if rel.startswith("dist/") and not rel.endswith(".apk"):
            continue
        out.append((rel, p))
    return out


def scan(files):
    hits = []
    for rel, p in files:
        if p.stat().st_size > 2_000_000:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for pat, desc in SECRET_PATTERNS:
            for m in pat.finditer(text):
                hits.append((rel, desc, m.group(0)[:14] + "…"))
    return hits


def put_file(owner, repo, rel, path, branch="main"):
    """先直接 PUT（新仓库 1 次请求就够）；若文件已存在（422）再取 sha 重传。"""
    with open(path, "rb") as f:
        content = base64.b64encode(f.read()).decode()
    payload = {"message": f"add {rel}", "content": content, "branch": branch}
    st, r = api("PUT", f"/repos/{owner}/{repo}/contents/{rel}", payload)
    if st in (200, 201):
        return st, r
    st2, existing = api("GET", f"/repos/{owner}/{repo}/contents/{rel}?ref={branch}")
    if st2 == 200 and isinstance(existing, dict) and existing.get("sha"):
        payload["sha"] = existing["sha"]
        payload["message"] = f"update {rel}"
        return api("PUT", f"/repos/{owner}/{repo}/contents/{rel}", payload)
    return st, r


def set_secret(owner, repo, name, value):
    st, key = api("GET", f"/repos/{owner}/{repo}/actions/secrets/public-key")
    if st != 200:
        return st, key
    try:
        from nacl import encoding, public  # type: ignore
        pk = public.PublicKey(key["key"].encode(), encoding.Base64Encoder())
        sealed = base64.b64encode(public.SealedBox(pk).encrypt(value.encode())).decode()
    except ImportError:
        return 0, {"message": "需要 PyNaCl 才能加密 Secret（pip install pynacl）"}
    return api("PUT", f"/repos/{owner}/{repo}/actions/secrets/{name}",
               {"encrypted_value": sealed, "key_id": key["key_id"]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="canyin-daily")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--private", action="store_true",
                    help="默认公开（公开仓库的 macOS Actions 免费额度才够用）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pages", action="store_true", help="顺便开启 GitHub Pages")
    ap.add_argument("--skip-existing", action="store_true",
                    help="跳过远端已存在且大小一致的文件（续传用）")
    ap.add_argument("--secrets", action="store_true", help="写入 iOS 用的 4 个 Actions Secrets")
    args = ap.parse_args()

    files = collect_files()
    total = sum(p.stat().st_size for _, p in files)
    print(f"待上传 {len(files)} 个文件，共 {total / 1024:.0f} KB")
    for rel, p in files:
        print(f"   {rel:<46} {p.stat().st_size / 1024:>7.1f} KB")

    hits = scan(files)
    if hits:
        print("\n!! 安全闸门拦下：以下文件里疑似有密钥，已中止")
        for rel, desc, sample in hits:
            print(f"   {rel}  {desc}  {sample}")
        print("请把这些内容移出上传范围（通常在 config/ 下，本就不该上传）")
        sys.exit(2)
    print("\n安全检查通过：待上传文件里没有 API Key / 密码哈希 ✓")

    if args.dry_run:
        print("\n（--dry-run，不实际推送）")
        return

    st, me = api("GET", "/user")
    if st != 200:
        print("Token 验证失败：", st, me)
        sys.exit(1)
    owner = me["login"]
    print(f"\n已登录：{owner}")

    st, repo = api("GET", f"/repos/{owner}/{args.repo}")
    if st == 404:
        st, repo = api("POST", "/user/repos", {
            "name": args.repo,
            "private": bool(args.private),
            "description": "餐饮日报 · 每日餐饮行业情报（内网/外网双板块）",
            "auto_init": True,   # 先建一个初始提交，确保 main 分支存在
        })
        print("  建仓库:", st, repo.get("full_name") or repo.get("message"))
    else:
        print("  仓库已存在:", repo.get("full_name"))

    ok = fail = skip = 0
    known = remote_sizes(owner, args.repo, args.branch) if args.skip_existing else {}
    if known:
        print(f"  远端已有 {len(known)} 个文件，将跳过内容一致的")
    for i, (rel, p) in enumerate(files, 1):
        if known.get(rel) == p.stat().st_size:
            skip += 1
            continue
        st, r = put_file(owner, args.repo, rel, p, args.branch)
        if st in (200, 201):
            ok += 1
        else:
            fail += 1
            print(f"   ✗ {rel}: {st} {str(r)[:120]}")
        if i % 20 == 0:
            print(f"   … {i}/{len(files)}")
    print(f"\n上传完成：新增/更新 {ok}，跳过 {skip}，失败 {fail}")
    print(f"仓库地址：https://github.com/{owner}/{args.repo}")

    if args.secrets:
        names = ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8", "APPLE_TEAM_ID")
        have = {n: os.environ.get(n, "") for n in names}
        if not any(have.values()):
            print("\n没发现 ASC_* / APPLE_TEAM_ID 环境变量，跳过 Secrets")
        else:
            for n, v in have.items():
                if not v:
                    print(f"   ⚠ {n} 为空，跳过")
                    continue
                st, r = set_secret(owner, args.repo, n, v)
                print(f"   {'✓' if st in (201, 204) else '✗'} {n}: {st} "
                      f"{'' if st in (201, 204) else str(r)[:100]}")

    if args.pages:
        st, r = api("POST", f"/repos/{owner}/{args.repo}/pages",
                    {"source": {"branch": args.branch, "path": "/public"}})
        if st in (201, 204, 409):
            print(f"\nPages 已开启：https://{owner}.github.io/{args.repo}/")
            print("（GitHub 首次构建需要 1–2 分钟）")
        else:
            print(f"\nPages 开启返回 {st}：{str(r)[:200]}")
            print("（可到仓库 Settings → Pages 手动选：分支 main，目录 /public）")


if __name__ == "__main__":
    main()
