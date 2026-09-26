# -*- coding: utf-8 -*-
"""把鉴权服务（cloud/）推到一个独立仓库，供 Deno Deploy 部署。

为什么单独建仓库：Deno Deploy 新平台目前不支持「仓库子目录」作为应用，
所以把 cloud/main.ts + cloud/deno.json 放到干净的 nfalyhl/canyin-auth 里，
用它的 main 分支直接部署最省事。

用法：
    python tools\\publish_auth_service.py --dry-run
    python tools\\publish_auth_service.py
    python tools\\publish_auth_service.py --repo canyin-auth --private

Token 复用 git 里已保存的 GitHub 凭据（和 publish_site.py 一样），
也可以用环境变量 GITHUB_TOKEN 覆盖。
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import publish_github as pg  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
CLOUD = ROOT / "cloud"

# 仓库里的文件名 → 本地文件
FILES = {
    "main.ts": CLOUD / "main.ts",
    "deno.json": CLOUD / "deno.json",
    "README.md": CLOUD / "README.md",
}

REPO_README = """# canyin-daily-auth

餐饮日报的登录鉴权服务（Deno Deploy 应用，入口 `main.ts`）。
源码的原始位置是 `canyin-daily/cloud/`，改动请在那边改完再跑
`python tools\\publish_auth_service.py` 推过来。

接口：`/api/login`、`/api/session`、`/api/logout`、`/api/devices`、
`/api/devices/kick`、`/api/health`。

环境变量：`USERS_JSON`（必填，账号哈希）、`MAX_DEVICES`（默认 3，设备名额上限）、
`DEVICE_TTL_DAYS`、`SESSION_DAYS`、`ALLOW_ORIGIN`、`ADMIN_TOKEN`。

部署要点：App 的 Runtime 选 Dynamic，Entrypoint 填 `main.ts`，
并在 Databases 里给它挂一个 Deno KV 实例（代码用 `Deno.openKv()`）。
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="canyin-auth")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--private", action="store_true", help="默认公开（内容里没有任何密钥）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = []
    for rel, p in FILES.items():
        if not p.exists():
            print(f"缺少文件：{p}")
            sys.exit(1)
        files.append((rel, p))

    print(f"待推送 {len(files)} 个文件 → {args.repo}/{args.branch}")
    for rel, p in files:
        print(f"   {rel:<14} {p.stat().st_size / 1024:>6.1f} KB")
    print("   仓库 README.md    （自动生成）")

    hits = pg.scan(files)
    if hits:
        print("\n!! 安全闸门拦下：")
        for rel, desc, sample in hits:
            print(f"   {rel} {desc} {sample}")
        sys.exit(2)
    print("\n安全检查通过：没有 API Key / 密码哈希 ✓")

    if args.dry_run:
        print("（--dry-run，不实际推送）")
        return

    st, me = pg.api("GET", "/user")
    if st != 200:
        print("Token 验证失败：", st, me)
        sys.exit(1)
    owner = me["login"]

    st, repo = pg.api("GET", f"/repos/{owner}/{args.repo}")
    if st == 404:
        st, repo = pg.api("POST", "/user/repos", {
            "name": args.repo,
            "private": bool(args.private),
            "description": "餐饮日报 · 登录鉴权服务（Deno Deploy，含设备名额限制）",
            "auto_init": True,
        })
        print("  建仓库:", st, repo.get("full_name") or repo.get("message"))
    else:
        print("  仓库已存在:", repo.get("full_name"))

    ok = fail = 0
    for rel, p in files:
        st, r = pg.put_file(owner, args.repo, rel, p, args.branch)
        if st in (200, 201):
            ok += 1
            print(f"   ✓ {rel}")
        else:
            fail += 1
            print(f"   ✗ {rel}: {st} {str(r)[:140]}")

    # 仓库根 README 单独写
    tmp = ROOT / "dist" / "_auth_repo_readme.md"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(REPO_README, encoding="utf-8")
    st, r = pg.put_file(owner, args.repo, "README.md", tmp, args.branch)
    print(f"   {'✓' if st in (200, 201) else '✗'} README.md")

    print(f"\n完成：成功 {ok}，失败 {fail}")
    print(f"仓库：https://github.com/{owner}/{args.repo}")
    print("\n下一步（在浏览器里，5 分钟）：")
    print("  1. 打开 https://console.deno.com 用 GitHub 登录，建一个 organization")
    print("  2. Databases → Provision Database → Deno KV，slug 例如 canyin-kv")
    print("  3. + New App → 选这个仓库 → Runtime 选 Dynamic、Entrypoint 填 main.ts、")
    print("     Dynamic arguments 填 --unstable-kv（Deno KV 仍是 unstable API，不能省）")
    print("  4. App 的 Databases 标签页 → Attach Database → 选刚建的 canyin-kv")
    print("  5. Settings → 环境变量：USERS_JSON（python tools\\auth_admin.py emit 生成）、")
    print("     MAX_DEVICES=3，可选 DEVICE_TTL_DAYS=30 / ALLOW_ORIGIN=https://nfalyhl.github.io")
    print("  6. Deploy，拿到 https://xxx.deno.dev → 回来跑：")
    print("     python tools\\auth_admin.py test --base https://xxx.deno.dev")
    print("     python tools\\auth_admin.py set-auth https://xxx.deno.dev")


if __name__ == "__main__":
    main()
