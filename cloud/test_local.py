# -*- coding: utf-8 -*-
"""鉴权服务（cloud/main.ts）自检：用本地 Deno + 本地 KV 起一个实例，把登录 / 名额 /
踢下线 / 退出释放 / 限流全跑一遍。部署到 Deno Deploy 之前先跑这个，能省下 1–2 轮返工。

前提：本机装了 Deno（https://deno.com ，单文件可执行程序）。
    set DENO_BIN=C:\\path\\to\\deno.exe      # 不设则用 PATH 里的 deno
    python cloud\\test_local.py

用法：
    python cloud\\test_local.py
    python cloud\\test_local.py --user YYQ --password 你的密码
"""
import argparse
import hashlib
import http.cookiejar  # noqa: F401  (占位，保持导入风格一致)
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
USERS = ROOT / "config" / "users.json"
ADMIN = "local-test-admin"
FAILS = []


def check(label, cond, detail=""):
    print(("  [OK] " if cond else "  [XX] ") + label + (("  " + detail) if detail else ""))
    if not cond:
        FAILS.append(label)


def call(base, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base + path, data=data, method="GET" if payload is None else "POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")
    except Exception as e:
        return 0, {"error": f"{type(e).__name__}: {e}"}


def find_password(user):
    doc = json.loads(USERS.read_text(encoding="utf-8"))
    for name, pwd in [(user, os.environ.get("AUTH_TEST_PASSWORD", "")), ("YYQ", "20000921"),
                      ("管理员", "YHL20081006yhl")]:
        if not pwd:
            continue
        for u in doc.get("users", []):
            if u["username"] != name:
                continue
            calc = hashlib.pbkdf2_hmac("sha256", pwd.encode(), bytes.fromhex(u["salt"]),
                                       int(u.get("iterations", 150000))).hex()
            if calc == u["hash"]:
                return name, pwd
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--user", default="YYQ")
    ap.add_argument("--password", default="")
    ap.add_argument("--max", type=int, default=3)
    args = ap.parse_args()

    deno = os.environ.get("DENO_BIN") or shutil.which("deno")
    if not deno or not Path(deno).exists():
        print("没找到 deno：装一个（https://deno.com）或设置 DENO_BIN 环境变量")
        sys.exit(1)

    user, pwd = find_password(args.user)
    if args.password:
        user, pwd = args.user, args.password
    if not pwd:
        print("读不到密码：请加 --password 你的密码")
        sys.exit(1)

    base = f"http://127.0.0.1:{args.port}"
    kvfile = Path(os.environ.get("TEMP", ".")) / f"canyin-auth-test-{uuid.uuid4().hex[:8]}.sqlite"
    env = dict(os.environ)
    env.update({
        "USERS_JSON": USERS.read_text(encoding="utf-8"),
        "MAX_DEVICES": str(args.max), "PORT": str(args.port),
        "ADMIN_TOKEN": ADMIN, "KV_URL": str(kvfile),
    })
    print(f"启动鉴权服务：{base}（账号 {user}，设备上限 {args.max}，KV {kvfile.name}）")
    proc = subprocess.Popen([deno, "run", "--unstable-kv", "--allow-net", "--allow-env",
                             "--allow-read", "--allow-write", "main.ts"],
                            cwd=str(ROOT / "cloud"), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")
    time.sleep(6)

    def login(dev, kick=None):
        return call(base, "/api/login", {"username": user, "password": pwd, "deviceId": dev,
                                         "deviceName": "自检 " + dev, "kick": kick})

    def bad_login(dev, password="no-such-password"):
        return call(base, "/api/login", {"username": user, "password": password,
                                         "deviceId": dev, "deviceName": "自检"})

    try:
        st, r = call(base, "/api/health")
        check("/api/health 200 且 KV 已连接", st == 200 and r.get("kv"),
              json.dumps(r, ensure_ascii=False)[:200])
        check("设备上限与配置一致", r.get("maxDevices") == args.max, str(r.get("maxDevices")))

        # 归零，避免上一次自检残留
        call(base, "/api/admin/purge", {"adminToken": ADMIN, "user": user})

        st, r = bad_login("selfcheck")
        check("密码错误 401", st == 401, f"{st} {r.get('code')}")

        tokens = {}
        for i in range(1, args.max + 1):
            did = f"check-device-{i}"
            st, r = login(did)
            check(f"第 {i} 台登录成功", st == 200 and r.get("ok"), f"{st} {r.get('error','')}")
            tokens[did] = r.get("token")
            n = len(r.get("devices") or [])
            check(f"第 {i} 台看到 {i} 台设备", n == i, f"{n} 台")

        st, r = login(f"check-device-{args.max + 1}")
        check(f"第 {args.max + 1} 台 403 device_limit",
              st == 403 and r.get("code") == "device_limit", f"{st} {r.get('code')}")
        check(f"返回 {args.max} 台设备列表", len(r.get("devices") or []) == args.max)

        st, r = login(f"check-device-{args.max + 1}", kick=tokens and "check-device-1")
        check("带 kick 登录成功", st == 200 and r.get("ok"), f"{st} {r.get('error','')}")
        st, _ = call(base, "/api/session", {"token": tokens["check-device-1"]})
        check("被踢设备的 token 立即失效", st == 401, str(st))

        st, r = call(base, "/api/devices/kick", {"token": r.get("token"), "deviceId": "check-device-2"})
        check("主动踢下线", st == 200, f"{st} {r.get('error','')}")
        st, _ = call(base, "/api/session", {"token": tokens["check-device-2"]})
        check("被踢设备 token 失效", st == 401, str(st))

        st, _ = call(base, "/api/logout", {"token": r.get("token")})
        check("退出登录", st == 200, str(st))
        st, rr = login("check-device-after-logout")
        check("退出后名额释放，可再登一台", st == 200, f"{st} {rr.get('error','')}")

        for _ in range(6):
            bad_login("check-device-bad", "still-wrong")
        st, r = login("check-device-bad2")
        check("连错 6 次后被锁（429）", st == 429 and r.get("code") == "locked",
              f"{st} {r.get('code')}")

        call(base, "/api/admin/purge", {"adminToken": ADMIN, "user": user})
        print("\n已清空自检残留（设备 / 令牌 / 限流）")
    finally:
        proc.terminate()
        time.sleep(1)
        if proc.poll() is None:
            proc.kill()
        try:
            kvfile.unlink(missing_ok=True)
        except Exception:
            pass

    print("\n" + ("全部通过 ✓" if not FAILS else f"失败 {len(FAILS)} 项：" + "；".join(FAILS)))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
