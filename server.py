#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""餐饮日报 · 本地服务

职责：
  1. 登录鉴权（页面与数据全部需要登录后才能访问）
  2. 保存「外网节点」（代理），并可按节点立即重新采集
  3. 托管 public/ 静态页面

启动：
    python server.py                 # 默认 0.0.0.0:8848
    python server.py --port 9000
    python server.py --host 127.0.0.1

账号管理（只存哈希，不存明文）：
    python tools\\setup_users.py --add 用户名 密码
    python tools\\setup_users.py --list
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
CONFIG = ROOT / "config"
USERS_FILE = CONFIG / "users.json"
SETTINGS_FILE = CONFIG / "settings.json"
SECRET_FILE = CONFIG / "secret.key"

COOKIE = "canyin_session"
SESSION_DAYS = 30
TZ_OFFSET = timedelta(hours=8)

# 设备名额：每个账号最多几台设备同时在线（超出要踢掉一台才能再登）
MAX_DEVICES = 3
DEVICE_TTL_DAYS = 30          # 超过这么多天没上线的设备自动释放名额

# 登录失败限流：连续错 6 次锁 3 分钟
LOGIN_FAILS: dict = {}
LOGIN_LOCK = threading.Lock()

COLLECT = {"running": False, "started": "", "finished": "", "code": None, "log": []}
COLLECT_LOCK = threading.Lock()

# 翻译任务状态
TRANSLATE = {"running": False, "started": "", "finished": "", "code": None,
             "log": [], "done": 0, "total": 0, "lang": ""}
TRANSLATE_LOCK = threading.Lock()

# 用来「测试节点」的海外源（都是直连可达、但走代理也通）
PROXY_TEST_URLS = [
    ("QSR Magazine", "https://www.qsrmagazine.com/rss.xml"),
    ("Restaurant Dive", "https://www.restaurantdive.com/feeds/news/"),
    ("Retail Dive", "https://www.retaildive.com/feeds/news/"),
]

from translate import Translator, LANGS, _key as tr_key  # noqa: E402

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


# --------------------------------------------------------------------------
# 账号与密钥
# --------------------------------------------------------------------------
def now_str() -> str:
    return (datetime.utcnow() + TZ_OFFSET).strftime("%Y-%m-%d %H:%M:%S")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def load_users() -> list:
    return (load_json(USERS_FILE, {}) or {}).get("users", [])


def check_password(username: str, password: str) -> bool:
    for u in load_users():
        if u.get("username") != username:
            continue
        try:
            salt = bytes.fromhex(u["salt"])
            iters = int(u.get("iterations", 150000))
            digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iters)
            return hmac.compare_digest(digest.hex(), u["hash"])
        except Exception:
            return False
    return False


# --------------------------------------------------------------------------
# 设备名额（每个账号最多 MAX_DEVICES 台）
# --------------------------------------------------------------------------
DEVICES_FILE = CONFIG / "devices.json"
DEV_LOCK = threading.Lock()


def _now_ts() -> int:
    return int(time.time())


def load_devices() -> dict:
    return load_json(DEVICES_FILE, {}) or {}


def save_devices(doc: dict) -> None:
    save_json(DEVICES_FILE, doc)


def _prune_devices(doc: dict, user: str) -> bool:
    """丢掉太久没上线的设备，释放名额。"""
    changed = False
    cutoff = _now_ts() - DEVICE_TTL_DAYS * 86400
    devs = doc.get(user) or {}
    for did in list(devs):
        if int(devs[did].get("last") or 0) < cutoff:
            devs.pop(did, None)
            changed = True
    if devs:
        doc[user] = devs
    elif user in doc:
        doc.pop(user, None)
        changed = True
    return changed


def _device_list(devs: dict) -> list:
    out = [dict(v, id=k) for k, v in devs.items()]
    out.sort(key=lambda d: int(d.get("last") or 0), reverse=True)
    return out


def list_devices(user: str) -> list:
    with DEV_LOCK:
        doc = load_devices()
        if _prune_devices(doc, user):
            save_devices(doc)
        devs = dict(doc.get(user) or {})
    return _device_list(devs)


def register_device(user: str, device_id: str, name: str, ua: str, ip: str,
                    kick: str = "") -> dict:
    """登记 / 更新设备。名额满了且没指定要踢的设备时，返回 device_limit + 设备列表。"""
    device_id = device_id or ("legacy-" + hashlib.sha1(
        (ip + ua).encode("utf-8")).hexdigest()[:12])
    with DEV_LOCK:
        doc = load_devices()
        _prune_devices(doc, user)
        devs = dict(doc.get(user) or {})
        cur = devs.get(device_id)
        if not cur and len(devs) >= MAX_DEVICES:
            if not kick:
                return {"ok": False, "code": "device_limit", "devices": _device_list(devs)}
            if kick not in devs:
                return {"ok": False, "code": "bad_kick", "devices": _device_list(devs)}
            devs.pop(kick, None)
        now = _now_ts()
        rec = dict(cur or {"id": device_id, "first": now})
        rec.update({"name": (name or "未知设备")[:60], "ua": ua[:160],
                    "ip": ip, "last": now})
        devs[device_id] = rec
        doc[user] = devs
        save_devices(doc)
        return {"ok": True, "device_id": device_id, "devices": _device_list(devs)}


def touch_device(user: str, device_id: str) -> bool:
    """心跳：设备还在（没被踢掉、没过期）返回 True。"""
    with DEV_LOCK:
        doc = load_devices()
        pruned = _prune_devices(doc, user)
        devs = dict(doc.get(user) or {})
        rec = devs.get(device_id)
        if not rec:
            if pruned:
                save_devices(doc)
            return False
        now = _now_ts()
        if now - int(rec.get("last") or 0) > 600:
            rec = dict(rec, last=now)
            devs[device_id] = rec
            doc[user] = devs
            save_devices(doc)
    return True


def drop_device(user: str, device_id: str) -> None:
    with DEV_LOCK:
        doc = load_devices()
        devs = dict(doc.get(user) or {})
        if device_id in devs:
            devs.pop(device_id, None)
            if devs:
                doc[user] = devs
            else:
                doc.pop(user, None)
            save_devices(doc)


def public_devices(user: str, current_id: str = "") -> list:
    return [{
        "id": d.get("id"),
        "name": d.get("name") or "未知设备",
        "ip": d.get("ip", ""),
        "first": fmt_ts(d.get("first")),
        "last": fmt_ts(d.get("last")),
        "lastTs": int(d.get("last") or 0),
        "current": d.get("id") == current_id,
    } for d in list_devices(user)]


def server_secret() -> bytes:
    if SECRET_FILE.exists():
        try:
            return bytes.fromhex(SECRET_FILE.read_text(encoding="utf-8").strip())
        except Exception:
            pass
    key = secrets.token_bytes(32)
    CONFIG.mkdir(parents=True, exist_ok=True)
    SECRET_FILE.write_text(key.hex(), encoding="utf-8")
    try:
        os.chmod(SECRET_FILE, 0o600)
    except Exception:
        pass
    return key


def fmt_ts(ts) -> str:
    try:
        return (datetime.utcfromtimestamp(int(ts)) + TZ_OFFSET).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


def make_token(username: str, device_id: str = "") -> str:
    exp = int(time.time()) + SESSION_DAYS * 86400
    raw = f"{username}|{device_id}|{exp}".encode("utf-8")
    body = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    sig = hmac.new(server_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}.{sig}"


def verify_token(token: str):
    """校验 Cookie 签名，返回 (username, device_id, legacy)；失败返回 None。

    legacy=True 表示是旧格式 Cookie（没有设备号），调用方会自动给它补一个设备身份。
    """
    if not token or "." not in token:
        return None
    body, _, sig = token.rpartition(".")
    expect = hmac.new(server_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        pad = "=" * (-len(body) % 4)
        raw = base64.urlsafe_b64decode(body + pad).decode("utf-8")
        parts = raw.rsplit("|", 2)
        if len(parts) == 3:
            username, device_id, exp = parts
            legacy = False
        elif len(parts) == 2:            # 兼容升级前的旧 Cookie
            username, exp = parts
            device_id, legacy = "", True
        else:
            return None
        if int(exp) < time.time():
            return None
        return username, device_id, legacy
    except Exception:
        return None


# --------------------------------------------------------------------------
# 设置（外网节点）
# --------------------------------------------------------------------------
def load_settings() -> dict:
    doc = load_json(SETTINGS_FILE, {}) or {}
    doc.setdefault("proxy", "")
    doc.setdefault("provider", "mymemory")     # mymemory | llm
    doc.setdefault("api_key", "")
    doc.setdefault("base_url", "https://api.deepseek.com/v1")
    doc.setdefault("model", "deepseek-chat")
    doc.setdefault("scope", "all")             # all=标题+要点  title=仅标题
    doc.setdefault("mymemory_email", "")
    return doc


def public_settings(doc: dict) -> dict:
    """给前端的设置：永远不回传 API Key 原文。"""
    key = (doc.get("api_key") or "").strip()
    return {
        "proxy": doc.get("proxy", ""),
        "provider": doc.get("provider", "mymemory"),
        "base_url": doc.get("base_url", ""),
        "model": doc.get("model", ""),
        "scope": doc.get("scope", "all"),
        "mymemory_email": doc.get("mymemory_email", ""),
        "has_key": bool(key),
        "key_hint": (key[:3] + "****" + key[-2:]) if len(key) > 8 else ("已设置" if key else ""),
        "updated_at": doc.get("updated_at", ""),
    }


def start_translate(texts: list, lang: str, force: bool = False) -> tuple:
    """后台翻译一批文本；force=True 先清掉这些文本的旧译文再翻。"""
    if not texts:
        return False, "没有需要翻译的内容"
    with TRANSLATE_LOCK:
        if TRANSLATE["running"]:
            return False, "已经有一个翻译任务在跑"
        TRANSLATE.update({"running": True, "started": now_str(), "finished": "",
                          "code": None, "log": [], "done": 0,
                          "total": len(texts), "lang": lang, "force": bool(force)})

    def worker():
        try:
            t = Translator(load_settings())
            if force:
                dropped = t.clear_targets(texts, lang)
                TRANSLATE["log"] = [f"已清除旧译文 {dropped} 条，开始重译…"]

            def prog(n, total):
                TRANSLATE["done"] = n
                TRANSLATE["log"] = [f"已翻译 {n}/{total} 条"]

            t.translate_many(texts, lang, progress=prog, force=force)
            provider = (load_settings().get("provider") or "mymemory")
            msg = (f"完成：{len(texts)} 条 → {lang}（{provider}），"
                   f"本次联网 {t.used_network} 次")
            if t.errors:
                msg += "；部分失败：" + "；".join(t.errors[:2])
            TRANSLATE["log"] = [msg]
            TRANSLATE["code"] = 0
        except Exception as e:
            TRANSLATE["log"] = [f"翻译失败：{e}"]
            TRANSLATE["code"] = -1
        TRANSLATE["running"] = False
        TRANSLATE["finished"] = now_str()

    threading.Thread(target=worker, daemon=True).start()
    return True, ("已开始重译" if force else "已开始")


def save_settings(doc: dict) -> None:
    doc["updated_at"] = now_str()
    save_json(SETTINGS_FILE, doc)


def test_proxy(proxy: str) -> list:
    """用给定代理试拉几个海外源，返回每个源的成败。"""
    handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    opener = urllib.request.build_opener(handler, urllib.request.HTTPSHandler(context=CTX))
    out = []
    for name, url in PROXY_TEST_URLS:
        t0 = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with opener.open(req, timeout=12) as r:
                body = r.read(2000)
            ok = b"<rss" in body[:1500] or b"<feed" in body[:1500]
            out.append({"name": name, "ok": True, "kind": "RSS" if ok else "HTML",
                        "ms": int((time.time() - t0) * 1000)})
        except Exception as e:
            out.append({"name": name, "ok": False, "error": f"{type(e).__name__}",
                        "ms": int((time.time() - t0) * 1000)})
    return out


# --------------------------------------------------------------------------
# 采集任务
# --------------------------------------------------------------------------
def start_collect(fast: bool = False) -> bool:
    with COLLECT_LOCK:
        if COLLECT["running"]:
            return False
        COLLECT.update({"running": True, "started": now_str(), "finished": "",
                        "code": None, "log": []})

    cmd = [sys.executable, str(ROOT / "daily.py")]
    if fast:
        cmd.append("--fast")

    def worker():
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True,
                                    encoding="utf-8", errors="replace", bufsize=1,
                                    creationflags=flags)
            for line in proc.stdout:
                COLLECT["log"].append(line.rstrip())
                if len(COLLECT["log"]) > 400:
                    del COLLECT["log"][:200]
            proc.wait()
            code = proc.returncode
        except Exception as e:
            COLLECT["log"].append(f"启动采集失败：{e}")
            code = -1
        COLLECT.update({"running": False, "finished": now_str(), "code": code})

    threading.Thread(target=worker, daemon=True).start()
    return True


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------
PUBLIC_PATHS = {"/login.html", "/api/login", "/favicon.ico"}
NO_AUTH_STATIC = {"/login.html", "/favicon.ico"}


class Handler(SimpleHTTPRequestHandler):

    server_version = "CanyinDaily/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/") or "api" in (self.path or ""):
            sys.stderr.write(f"  [{now_str()[11:]}] {self.command} {self.path}\n")

    # ---------------- 基础工具 ----------------
    def _json(self, obj, code=200, cookie=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _token(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return ""

    def current_session(self):
        """返回 {"user":…, "device_id":…}；Cookie 无效或设备被踢掉则返回 None。"""
        got = verify_token(self._token())
        if not got:
            return None
        username, device_id, legacy = got
        if legacy or not device_id:
            # 升级前的旧 Cookie：按 浏览器+IP 补一个设备身份，名额满了就得重新登录
            ua = self.headers.get("User-Agent") or ""
            ip = self._client_ip()
            device_id = "legacy-" + hashlib.sha1((ip + ua).encode("utf-8")).hexdigest()[:12]
            if not touch_device(username, device_id):
                res = register_device(username, device_id, "旧会话", ua, ip)
                if not res.get("ok"):
                    return None
        if not touch_device(username, device_id):
            return None
        return {"user": username, "device_id": device_id}

    def current_user(self):
        s = self.current_session()
        return s["user"] if s else None

    def _redirect(self, to: str):
        self.send_response(302)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _client_ip(self):
        return self.client_address[0] if self.client_address else "?"

    # ---------------- GET ----------------
    def do_GET(self):
        path = urlparse(self.path).path

        if path in NO_AUTH_STATIC:
            return super().do_GET()

        if path.startswith("/api/"):
            user = self.current_user()
            if path == "/api/session":
                sess = self.current_session()
                did = (sess or {}).get("device_id", "")
                return self._json({
                    "ok": bool(sess), "logged_in": bool(sess), "user": (sess or {}).get("user", ""),
                    "device_id": did, "max_devices": MAX_DEVICES,
                    "devices": public_devices(user, did) if user else [],
                    "offsets": self._collect_state(False)})
            if path == "/api/devices":
                sess = self.current_session()
                did = (sess or {}).get("device_id", "")
                return self._json({"ok": True, "user": user, "device_id": did,
                                   "max_devices": MAX_DEVICES,
                                   "devices": public_devices(user, did)})
            if not user:
                return self._json({"error": "未登录"}, 401)

            if path == "/api/settings":
                return self._json(public_settings(load_settings()))
            if path == "/api/translate/status":
                st = dict(TRANSLATE)
                st["log"] = st.get("log", [])[-10:]
                st["provider"] = load_settings().get("provider", "mymemory")
                return self._json(st)
            if path == "/api/translate/languages":
                return self._json({"langs": [{"id": k, "label": v} for k, v in LANGS]})
            if path == "/api/collect/status":
                return self._json(self._collect_state(True))
            if path == "/api/data/index":
                return self._json(load_json(PUBLIC / "data" / "index.json", {}))
            return self._json({"error": "未知接口"}, 404)

        # 静态资源：除登录页外都要登录
        if not self.current_user():
            if path in ("/", "/index.html"):
                return self._redirect("/login.html")
            return self._redirect("/login.html")
        return super().do_GET()

    # ---------------- POST ----------------
    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()

        if path == "/api/login":
            return self._login(body)

        user = self.current_user()
        if not user:
            return self._json({"error": "未登录"}, 401)

        if path == "/api/logout":
            sess = self.current_session()
            if sess and sess.get("device_id"):
                drop_device(sess["user"], sess["device_id"])   # 退出即释放名额
            cookie = f"{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
            return self._json({"ok": True}, cookie=cookie)

        if path == "/api/devices/kick":
            sess = self.current_session()
            target = str(body.get("deviceId") or "").strip()
            if not target:
                return self._json({"ok": False, "error": "没指定要下线的设备"}, 400)
            if target == sess.get("device_id"):
                return self._json({"ok": False, "error": "不能下线当前正在使用的这台设备"}, 400)
            drop_device(user, target)
            return self._json({"ok": True, "user": user, "device_id": sess.get("device_id", ""),
                               "max_devices": MAX_DEVICES,
                               "devices": public_devices(user, sess.get("device_id", ""))})

        if path == "/api/settings":
            doc = load_settings()
            fields = ("proxy", "provider", "base_url", "model", "scope", "mymemory_email")
            for f in fields:
                if f in body:
                    doc[f] = str(body.get(f) or "").strip()
            # API Key 只有传了非空值才覆盖，留空 = 不改
            if str(body.get("api_key") or "").strip():
                doc["api_key"] = str(body["api_key"]).strip()
            if body.get("clear_key"):
                doc["api_key"] = ""
            proxy = doc.get("proxy", "")
            if proxy and not (proxy.startswith("http://") or proxy.startswith("https://")
                              or ":" in proxy):
                return self._json({"error": "节点格式应形如 http://127.0.0.1:7897"}, 400)
            if doc.get("provider") not in ("mymemory", "llm"):
                doc["provider"] = "mymemory"
            if doc.get("scope") not in ("all", "title"):
                doc["scope"] = "all"
            save_settings(doc)
            return self._json({"ok": True, **public_settings(doc)})

        if path == "/api/translate/lookup":
            texts = [str(t) for t in (body.get("texts") or [])][:400]
            lang = str(body.get("lang") or "zh")
            t = Translator(load_settings())
            cache = t.cache
            return self._json({
                "lang": lang,
                "map": {s: (cache.get(tr_key(s, lang)) or "") for s in texts},
                **t.stats(texts, lang),
            })

        if path == "/api/translate/start":
            texts = [str(t) for t in (body.get("texts") or [])][:400]
            lang = str(body.get("lang") or "zh")
            started, msg = start_translate(texts, lang, force=bool(body.get("force")))
            return self._json({"ok": started, "message": msg, "total": len(texts)},
                              200 if started else 409)

        if path == "/api/models":
            doc = load_settings()
            base = str(body.get("base_url") or doc.get("base_url")
                       or "https://api.deepseek.com/v1").rstrip("/")
            key = str(body.get("api_key") or "").strip() or doc.get("api_key", "")
            if not key:
                return self._json({"error": "先填 API Key（或先保存一个）再拉取"}, 400)
            try:
                req = urllib.request.Request(
                    base + "/models",
                    headers={"Authorization": "Bearer " + key,
                             "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                    data = json.loads(r.read().decode("utf-8", "replace"))
                ids = [m.get("id") for m in (data.get("data") or []) if m.get("id")]
                if not ids:
                    return self._json({"error": "接口没返回模型列表"}, 502)
                return self._json({"ok": True, "models": ids[:80], "base_url": base})
            except Exception as e:
                body_txt = ""
                if isinstance(e, urllib.error.HTTPError):
                    try:
                        body_txt = e.read().decode("utf-8", "replace")[:160]
                    except Exception:
                        pass
                return self._json({"error": f"拉取失败：{type(e).__name__} "
                                            f"{str(e)[:100]} {body_txt}"}, 502)

        if path == "/api/translate/test":
            doc = load_settings()
            sample = str(body.get("text") or
                         "McDonald's is testing a new value menu to win back customers")
            langs = body.get("langs") or ["zh"]
            t = Translator(doc)
            t.settings = doc
            out = []
            for lg in langs[:5]:
                got = t.translate(sample, str(lg))
                out.append({"lang": lg, "text": got})
            t.save()
            return self._json({"sample": sample, "provider": doc.get("provider"),
                               "results": out, "errors": t.errors[:3]})

        if path == "/api/proxy-test":
            proxy = str(body.get("proxy", "")).strip() or load_settings().get("proxy", "")
            if not proxy:
                return self._json({"error": "还没填节点"}, 400)
            return self._json({"proxy": proxy, "results": test_proxy(proxy)})

        if path == "/api/collect":
            ok = start_collect(fast=bool(body.get("fast")))
            if not ok:
                return self._json({"error": "已经有一个采集任务在跑"}, 409)
            return self._json({"ok": True, "started": COLLECT["started"]})

        return self._json({"error": "未知接口"}, 404)

    # ---------------- 登录 ----------------
    def _login(self, body: dict):
        ip = self._client_ip()
        now = time.time()
        with LOGIN_LOCK:
            rec = LOGIN_FAILS.get(ip) or {"fails": 0, "until": 0}
            if rec["until"] > now:
                return self._json({"error": f"失败次数过多，请 {int(rec['until'] - now)} 秒后再试"}, 429)

        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        if not username or not password:
            return self._json({"error": "用户名和密码都要填"}, 400)

        if not load_users():
            return self._json({"error": "还没有任何账号，先运行 tools\\setup_users.py 添加"}, 503)

        if check_password(username, password):
            with LOGIN_LOCK:
                LOGIN_FAILS.pop(ip, None)
            device_id = str(body.get("deviceId") or "").strip()
            device_name = str(body.get("deviceName") or "").strip()[:60]
            kick = str(body.get("kick") or "").strip()
            ua = self.headers.get("User-Agent") or ""
            res = register_device(username, device_id, device_name, ua, ip, kick)
            if not res.get("ok"):
                if res.get("code") == "device_limit":
                    n = len(res.get("devices") or [])
                    print(f"  ✗ 设备名额已满：{username}（{n}/{MAX_DEVICES}，{ip}）")
                    return self._json({
                        "ok": False, "code": "device_limit",
                        "error": f"这个账号已经在 {n} 台设备上登录（上限 {MAX_DEVICES} 台）",
                        "maxDevices": MAX_DEVICES,
                        "devices": public_devices(username, device_id),
                    }, 403)
                return self._json({"ok": False, "code": res.get("code"),
                                   "error": "要下线的设备不存在，请刷新后重试"}, 400)
            did = res.get("device_id", "")
            cookie = (f"{COOKIE}={make_token(username, did)}; Path=/; Max-Age={SESSION_DAYS * 86400}; "
                      f"HttpOnly; SameSite=Lax")
            print(f"  ✓ 登录成功：{username}（{ip}，设备 {did[:8]}）")
            return self._json({"ok": True, "user": username, "deviceId": did,
                               "maxDevices": MAX_DEVICES,
                               "devices": public_devices(username, did)}, cookie=cookie)

        with LOGIN_LOCK:
            rec = LOGIN_FAILS.get(ip) or {"fails": 0, "until": 0}
            rec["fails"] += 1
            if rec["fails"] >= 6:
                rec["until"] = now + 180
                rec["fails"] = 0
            LOGIN_FAILS[ip] = rec
        print(f"  ✗ 登录失败：{username}（{ip}）")
        return self._json({"error": "用户名或密码不对"}, 401)

    def _collect_state(self, with_log: bool):
        st = dict(COLLECT)
        st["proxy"] = load_settings().get("proxy", "")
        if not with_log:
            st.pop("log", None)
        elif st.get("log"):
            st["log"] = st["log"][-60:]
        return st


# --------------------------------------------------------------------------
def local_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return ips


def main():
    ap = argparse.ArgumentParser(description="餐饮日报 本地服务")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8848)
    args = ap.parse_args()

    if not load_users():
        print("!! 还没有任何账号，先执行：")
        print("   python tools\\setup_users.py --add 用户名 密码")
        return 1

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("餐饮日报 服务已启动")
    print(f"  本机：http://127.0.0.1:{args.port}/login.html")
    for ip in local_ips():
        print(f"  局域网：http://{ip}:{args.port}/login.html")
    print(f"  账号数：{len(load_users())}    节点：{load_settings().get('proxy') or '未设置'}")
    print("  Ctrl+C 停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
