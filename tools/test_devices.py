# -*- coding: utf-8 -*-
"""本机 server.py 的「设备名额」自检：起一个临时服务，走真实 HTTP 跑一遍。

验的是：三台设备依次登录 → 第四台被拦（并列出设备）→ 带 kick 登录腾名额
→ 被踢设备的会话立即失效 → 退出登录释放名额 → 密码错误 401。

默认用一个**临时账号**跑（跑完自动删掉），不会占用你正式账号的设备名额。
想直接测正式账号加 --user / --password（要确认那个账号当前没被别的设备占着）。

用法：
    python tools\\test_devices.py
    python tools\\test_devices.py --user YYQ --password 你的密码
"""
import argparse
import http.cookiejar
import json
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
FAILS = []


def check(label, cond, detail=""):
    print(("  [OK] " if cond else "  [XX] ") + label + (("  " + detail) if detail else ""))
    if not cond:
        FAILS.append(label)


def setup_users(*argv):
    return subprocess.run([sys.executable, str(ROOT / "tools" / "setup_users.py"), *argv],
                          cwd=str(ROOT), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def new_session(base):
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def call(base, opener, path, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base + path, data=data, method=method or ("POST" if payload is not None else "GET"),
        headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=25) as r:
            body = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(body or "{}")
            except Exception:
                return r.status, {"raw": body[:200]}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body or "{}")
        except Exception:
            return e.code, {"raw": body[:200]}
    except Exception as e:
        return 0, {"error": f"{type(e).__name__}: {e}"}


def main():
    ap = argparse.ArgumentParser(description="本机服务 · 设备名额自检")
    ap.add_argument("--port", type=int, default=8849)
    ap.add_argument("--user")
    ap.add_argument("--password")
    args = ap.parse_args()

    temp_user = ""
    if args.user:
        user, pwd = args.user, args.password or ""
        if not pwd:
            import getpass
            pwd = getpass.getpass(f"{user} 的密码（不显示）: ")
        base = f"http://127.0.0.1:{args.port}"
        print(f"用现有账号 {user} 自检（该账号当前不能有别的设备占着名额）")
    else:
        temp_user = "selftest-" + secrets.token_hex(3)
        pwd = "self-" + secrets.token_urlsafe(9)
        r = setup_users("--add", temp_user, pwd)
        if r.returncode != 0:
            print("建临时账号失败：", (r.stdout or "") + (r.stderr or ""))
            sys.exit(1)
        user = temp_user
        print(f"用临时账号 {user} 自检（跑完自动删除）")

    base = f"http://127.0.0.1:{args.port}"
    prefix = f"dev-{int(time.time())}"
    print(f"启动 server.py：{base}")
    proc = subprocess.Popen([sys.executable, "server.py", "--port", str(args.port),
                             "--host", "127.0.0.1"],
                            cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")
    time.sleep(4)

    def login(opener, dev, kick=None):
        return call(base, opener, "/api/login",
                    {"username": user, "password": pwd,
                     "deviceId": f"{prefix}-{dev}", "deviceName": "自检 " + str(dev),
                     "kick": f"{prefix}-{kick}" if kick else None})

    try:
        anon, _ = new_session(base)
        st, r = call(base, anon, "/api/session")
        check("未登录时 logged_in=false", st == 200 and r.get("logged_in") is False, str(st))

        sessions = {}
        for i in range(1, 4):
            op, jar = new_session(base)
            st, r = login(op, i)
            check(f"第 {i} 台登录成功", st == 200 and r.get("ok"), f"{st} {r.get('error','')}")
            sessions[i] = (op, jar)
            n = len(r.get("devices") or [])
            check(f"第 {i} 台看到 {i} 台设备", n == i, f"{n} 台")

        print("\n超出上限（第 4 台）")
        op4, _ = new_session(base)
        st, r = login(op4, 4)
        check("第 4 台 403 device_limit", st == 403 and r.get("code") == "device_limit",
              f"{st} {r.get('code')} {r.get('error','')}")
        check("返回 3 台设备供选择", len(r.get("devices") or []) == 3)
        st, r = call(base, sessions[1][0], "/api/session")
        check("被拦下时老设备照旧有效", r.get("logged_in") is True, str(st))

        print("\n带 kick 登录（腾名额）")
        st, r = login(op4, 4, kick=1)
        check("kick 后可登录", st == 200 and r.get("ok"), f"{st} {r.get('error','')}")
        st, r = call(base, sessions[1][0], "/api/session")
        check("被踢设备的会话立即失效", r.get("logged_in") is False, str(r.get("logged_in")))
        st, r = login(op4, "bad-kick", kick=99)
        check("kick 不存在的设备 → 400", st == 400, f"{st} {r.get('error','')}")

        print("\n设备列表 / 主动踢下线")
        st, r = call(base, op4, "/api/session")
        devs = r.get("devices") or []
        check("能标出当前设备", any(d.get("current") for d in devs))
        other = [d for d in devs if not d.get("current")]
        check("有 2 台别的设备", len(other) == 2, f"{len(other)} 台")
        if other:
            st, r = call(base, op4, "/api/devices/kick", {"deviceId": other[0]["id"]})
            check("踢掉别的设备", st == 200 and len(r.get("devices") or []) == len(devs) - 1,
                  f"{st} {len(r.get('devices') or [])} 台")
        st, r = call(base, op4, "/api/devices/kick", {"deviceId": "不存在的设备"})
        check("踢不存在的设备不报错（幂等）", st == 200, f"{st} {r.get('error','')}")

        print("\n退出释放名额 + 密码错误")
        st, _ = call(base, op4, "/api/logout", {})
        check("退出成功", st == 200, str(st))
        op5, _ = new_session(base)
        st, r = login(op5, 5)
        check("退出后立刻能再登一台", st == 200, f"{st} {r.get('error','')}")
        opw, _ = new_session(base)
        st, r = call(base, opw, "/api/login", {"username": user, "password": "wrong-xyz",
                                               "deviceId": f"{prefix}-bad"})
        check("密码错误 401", st == 401, f"{st} {r.get('error','')}")
    finally:
        proc.terminate()
        time.sleep(1)
        if proc.poll() is None:
            proc.kill()
        if temp_user:
            setup_users("--del", temp_user)
            # 顺手把 devices.json 里这个临时账号的设备记录也清掉
            dev_file = ROOT / "config" / "devices.json"
            try:
                doc = json.loads(dev_file.read_text(encoding="utf-8")) if dev_file.exists() else {}
                if doc.pop(temp_user, None) is not None:
                    dev_file.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
            except Exception as e:
                print(f"（清理设备记录失败，可忽略：{e}）")
            print(f"\n已删除临时账号 {temp_user}")

    print("\n" + ("全部通过 ✓" if not FAILS else f"失败 {len(FAILS)} 项：" + "；".join(FAILS)))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
