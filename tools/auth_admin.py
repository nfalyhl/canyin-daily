# -*- coding: utf-8 -*-
"""鉴权服务管理：账号同步、线上自检、把服务地址写进站点配置。

鉴权服务（cloud/main.ts，部署在 Deno Deploy）不存明文密码，它只认环境变量
USERS_JSON —— 也就是本机 config/users.json 的原文（只含 PBKDF2 哈希）。
这个脚本负责生成那段内容，并帮你自检线上服务。

用法：
    python tools\\auth_admin.py emit                     # 打印 USERS_JSON（贴进 Deno Deploy 环境变量）
    python tools\\auth_admin.py emit --out dist\\users_env.txt
    python tools\\auth_admin.py test --base https://xxx.deno.dev
    python tools\\auth_admin.py test --base https://xxx.deno.dev --user YYQ --password 你的密码
    python tools\\auth_admin.py set-auth https://xxx.deno.dev   # 写进 public/auth-config.json（开登录门禁）
    python tools\\auth_admin.py set-auth ""                     # 关掉登录门禁
    python tools\\auth_admin.py devices --base https://xxx.deno.dev --token <token>   # 看某账号的设备

加/改账号先本地改，再重新 emit 覆盖环境变量：
    python tools\\setup_users.py --add 用户名 密码
    python tools\\auth_admin.py emit
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
USERS = ROOT / "config" / "users.json"
AUTH_CFG = ROOT / "public" / "auth-config.json"


def load_users() -> dict:
    if not USERS.exists():
        return {"users": []}
    try:
        return json.loads(USERS.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"读不出 {USERS}：{e}")
        sys.exit(1)


def api(base: str, path: str, payload=None, timeout=20):
    base = base.rstrip("/")
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base + path, data=data, method="GET" if payload is None else "POST",
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": "canyin-auth-admin"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": body[:300]}
    except Exception as e:
        return 0, {"error": f"{type(e).__name__}: {e}"}


def cmd_emit(args):
    doc = load_users()
    users = doc.get("users") or []
    if not users:
        print("本机还没有账号，先跑： python tools\\setup_users.py --add 用户名 密码")
        sys.exit(1)
    text = json.dumps({"users": users}, ensure_ascii=False, separators=(",", ":"))
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"已写入 {out}（{len(text)} 字节）")
    print(f"账号 {len(users)} 个：{'、'.join(u['username'] for u in users)}")
    print("把下面整行填到 Deno Deploy → 你的 App → 环境变量 USERS_JSON（选 Secret 更稳妥）：\n")
    print(text)
    print("\n改了账号/密码后重新 emit 一次，并在控制台更新这个环境变量再重新部署。")


def cmd_test(args):
    base = (args.base or "").rstrip("/")
    if not base:
        print("要加 --base https://xxx.deno.dev")
        sys.exit(1)
    st, h = api(base, "/api/health")
    print(f"GET {base}/api/health  →  {st}")
    print(json.dumps(h, ensure_ascii=False, indent=2)[:1200])
    if st != 200:
        print("\n服务本身没通：检查 App 是否部署成功、域名是否写错、网络是否能到 *.deno.dev")
        return
    if h.get("problems"):
        print("\n!! 服务在跑但配置不全：" + "；".join(h.get("problems") or []))
    if not args.user:
        return
    import getpass
    pwd = args.password or getpass.getpass(f"{args.user} 的密码（不显示）: ")
    did = "admin-test-" + uuid.uuid4().hex[:8]
    print(f"\n用临时设备号 {did} 试登录（不会占用正式设备名额）…")
    st, r = api(base, "/api/login", {"username": args.user, "password": pwd,
                                     "deviceId": did, "deviceName": "自检"})
    print(f"POST /api/login  →  {st}")
    print(json.dumps({k: v for k, v in r.items() if k != "token"}, ensure_ascii=False, indent=2))
    if st == 200 and r.get("token"):
        api(base, "/api/logout", {"token": r["token"]})
        print("✓ 登录成功，已自动退出并释放自检设备")
    elif r.get("code") == "device_limit":
        print("设备名额已满——这正是预期行为；可以在站点上先下线一台，或让某台设备退出登录。")
    elif r.get("code") == "no_users":
        print("!! 服务端还没配 USERS_JSON：python tools\\auth_admin.py emit 生成后填入环境变量")


def cmd_set_auth(args):
    base = (args.base or "").strip()
    cfg = {}
    if AUTH_CFG.exists():
        try:
            cfg = json.loads(AUTH_CFG.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
    cfg["authBase"] = base.rstrip("/")
    cfg.setdefault("maxDevices", 3)
    cfg.setdefault("title", "餐饮日报")
    cfg.setdefault("_说明", "静态站点（GitHub Pages / APK）用的鉴权服务地址。留空 = 不做登录门禁。")
    AUTH_CFG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if base:
        print(f"已写入 {AUTH_CFG}：authBase = {base}")
        print("接着重新生成页面并发布：")
        print("  python daily.py --render-only")
        print("  python tools\\publish_site.py")
    else:
        print(f"已清空 authBase（{AUTH_CFG}）：静态站点不再要求登录（本机服务器版照旧要登录）")


def cmd_devices(args):
    if not args.base or not args.token:
        print("要加 --base 和 --token（token 在浏览器 localStorage 的 canyin-auth-token）")
        sys.exit(1)
    st, r = api(args.base, "/api/devices", {"token": args.token})
    print(f"POST /api/devices  →  {st}")
    print(json.dumps(r, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser(description="餐饮日报鉴权服务管理")
    sub = ap.add_subparsers(dest="cmd")

    p1 = sub.add_parser("emit", help="生成 USERS_JSON（填到 Deno Deploy 环境变量）")
    p1.add_argument("--out", help="顺便写到一个文件（例如 dist\\users_env.txt）")
    p1.set_defaults(func=cmd_emit)

    p2 = sub.add_parser("test", help="自检线上鉴权服务")
    p2.add_argument("--base", help="https://xxx.deno.dev")
    p2.add_argument("--user")
    p2.add_argument("--password")
    p2.set_defaults(func=cmd_test)

    p3 = sub.add_parser("set-auth", help="把服务地址写进 public/auth-config.json")
    p3.add_argument("base", nargs="?", default="", help="服务地址；留空 = 关闭门禁")
    p3.set_defaults(func=cmd_set_auth)

    p4 = sub.add_parser("devices", help="查看某个账号当前在线的设备")
    p4.add_argument("--base")
    p4.add_argument("--token")
    p4.set_defaults(func=cmd_devices)

    args = ap.parse_args()
    if not getattr(args, "cmd", None):
        ap.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()
