# -*- coding: utf-8 -*-
"""自检：登录鉴权、节点设置、采集接口是否正常。

用法：python tools\\test_server.py [端口] [用户名] [密码]
"""
import json
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8848"
USER = sys.argv[2] if len(sys.argv) > 2 else "YYQ"
PWD = sys.argv[3] if len(sys.argv) > 3 else "20000921"
BASE = f"http://127.0.0.1:{PORT}"

cookie = ""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


opener = urllib.request.build_opener(NoRedirect)
ok = fail = 0


def call(method, path, payload=None, raw=False):
    global cookie
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with opener.open(req, timeout=30) as r:
            body = r.read().decode("utf-8", "replace")
            sc = r.headers.get("Set-Cookie")
            if sc:
                cookie = sc.split(";")[0]
            return r.status, body, r.headers.get("Location")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        sc = e.headers.get("Set-Cookie")
        if sc:
            cookie = sc.split(";")[0]
        return e.code, body, e.headers.get("Location")


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ✓ {name}" + (f"   {extra}" if extra else ""))
    else:
        fail += 1
        print(f"  ✗ {name}   {extra}")


print(f"目标：{BASE}\n")

print("[1] 未登录时应当被挡住")
sc, _, loc = call("GET", "/")
check("访问 / 跳转到登录页", sc in (301, 302) and "login" in (loc or ""), f"{sc} -> {loc}")
sc, _, _ = call("GET", "/data/digest-2026-09-25.json")
check("直接抓数据文件被挡", sc in (301, 302, 401), f"HTTP {sc}")
sc, body, _ = call("GET", "/api/settings")
check("未登录调 /api/settings 返回 401", sc == 401, f"HTTP {sc}")

print("\n[2] 登录")
sc, body, _ = call("POST", "/api/login", {"username": USER, "password": "definitely-wrong"})
check("错误密码被拒", sc == 401, f"HTTP {sc} {body[:60]}")
sc, body, _ = call("POST", "/api/login", {"username": USER, "password": PWD})
check(f"{USER} 登录成功", sc == 200 and '"ok": true' in body.replace('"ok":true', '"ok": true'),
      f"HTTP {sc} {body[:80]}")
check("下发了会话 Cookie", bool(cookie), cookie[:24] + "…")

print("\n[3] 登录后")
sc, body, _ = call("GET", "/")
check("可以打开首页", sc == 200 and "餐饮日报" in body, f"HTTP {sc}")
sc, body, _ = call("GET", "/api/session")
check("/api/session 返回已登录", sc == 200 and f'"{USER}"' in body, body[:80])
sc, body, _ = call("GET", "/api/settings")
check("读取节点设置", sc == 200 and "proxy" in body, body[:80])

print("\n[4] 保存节点")
sc, body, _ = call("POST", "/api/settings", {"proxy": "http://127.0.0.1:7897"})
check("保存节点成功", sc == 200 and "7897" in body, body[:80])
sc, body, _ = call("POST", "/api/settings", {"proxy": "不是个地址"})
check("非法节点被拒", sc == 400, f"HTTP {sc} {body[:60]}")
sc, body, _ = call("GET", "/api/settings")
check("节点已持久化", "7897" in body, body[:80])

print("\n[5] 退出")
sc, body, _ = call("POST", "/api/logout")
check("退出成功", sc == 200, f"HTTP {sc}")
sc, _, loc = call("GET", "/")
check("退出后又被挡住", sc in (301, 302), f"{sc} -> {loc}")

print(f"\n结果：通过 {ok}，失败 {fail}")
sys.exit(1 if fail else 0)
