# -*- coding: utf-8 -*-
"""把 public/ 部署成一个公网网址（手机上直接打开就能看）。

本机没装 Node，所以这里用纯标准库实现了 VibeDrop 的上传接口，
配置文件与官方 CLI 完全一致（~/.vibedrop/config.json），互不冲突。

用法：
    python tools/deploy.py                     # 部署 public/，首次会申请匿名 key
    python tools/deploy.py --slug k9m2p8x7     # 复用已有网址（改完内容再传一次）
    python tools/deploy.py --title "餐饮日报"  # 设置站点标题
    python tools/deploy.py --dir public        # 指定要部署的目录
"""
import argparse
import json
import mimetypes
import os
import ssl
import sys
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.path.expanduser("~")) / ".vibedrop" / "config.json"
STATE_PATH = ROOT / ".deploy.json"
API_DEFAULT = os.environ.get("VIBEDROP_API_URL", "https://api.vibedrop.cc")
UA = "vibedrop-python/1.0"

CTX = ssl.create_default_context()


def load_config():
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_config(cfg):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass


def api_request(cfg, path, data=None, content_type=None, method=None):
    url = cfg.get("apiUrl", API_DEFAULT).rstrip("/") + path
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if cfg.get("apiKey"):
        headers["authorization"] = "Bearer " + cfg["apiKey"]
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body).get("error", {}).get("message", body)
        except Exception:
            msg = body
        raise SystemExit(f"! 接口返回 {e.code}: {msg}")
    return json.loads(body) if body.strip() else {}


def ensure_key(cfg):
    if cfg.get("apiKey"):
        return cfg
    print("  · 首次使用，正在申请匿名 API key…")
    res = api_request(cfg, "/v1/keys/anonymous", data=b"", method="POST")
    cfg["apiKey"] = res["key"]
    cfg.setdefault("apiUrl", API_DEFAULT)
    save_config(cfg)
    print(f"  · 已保存到 {CONFIG_PATH}")
    return cfg


SKIP_DIRS = {"node_modules", ".git", ".DS_Store", ".next", ".cache", "__pycache__"}


def pack(src: Path) -> bytes:
    buf = __import__("io").BytesIO()
    count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(src.rglob("*")):
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            if not p.is_file() or p.stat().st_size > 20 * 1024 * 1024:
                continue
            z.write(p, p.relative_to(src).as_posix())
            count += 1
    print(f"  · 打包 {count} 个文件，{len(buf.getvalue()) / 1024:.0f} KB")
    return buf.getvalue()


def multipart(fields: dict, files: dict) -> tuple:
    boundary = "----vibedrop" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        if value is None or value == "":
            continue
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        out += str(value).encode("utf-8") + b"\r\n"
    for name, (filename, blob) in files.items():
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        out += f"--{boundary}\r\n".encode()
        out += (f'Content-Disposition: form-data; name="{name}"; '
                f'filename="{filename}"\r\n').encode()
        out += f"Content-Type: {ctype}\r\n\r\n".encode()
        out += blob + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def main():
    ap = argparse.ArgumentParser(description="把静态目录部署成公网网址")
    ap.add_argument("--dir", default="public", help="要部署的目录，默认 public")
    ap.add_argument("--slug", default="", help="复用已有网址")
    ap.add_argument("--title", default="餐饮日报", help="站点标题")
    ap.add_argument("--visibility", default="", choices=["", "link", "public"],
                    help="link=仅链接可见（默认），public=公开收录")
    args = ap.parse_args()

    src = (ROOT / args.dir).resolve() if not Path(args.dir).is_absolute() else Path(args.dir)
    if not (src / "index.html").exists():
        raise SystemExit(f"! {src} 里没有 index.html，无法部署")

    cfg = ensure_key(load_config())

    slug = args.slug
    if not slug and STATE_PATH.exists():
        try:
            slug = json.loads(STATE_PATH.read_text(encoding="utf-8")).get("slug", "")
        except Exception:
            slug = ""
    if slug:
        print(f"  · 更新已有站点 {slug}")

    blob = pack(src)
    body, ctype = multipart(
        {"slug": slug, "title": args.title, "visibility": args.visibility},
        {"zip": ("site.zip", blob)},
    )
    res = api_request(cfg, "/v1/sites", data=body, content_type=ctype)

    site = res.get("site", {})
    url = site.get("url") or site.get("domain") or ""
    if url and not url.startswith("http"):
        url = "https://" + url
    STATE_PATH.write_text(json.dumps({"slug": site.get("slug", slug), "url": url},
                                     ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n  部署成功")
    print(f"  网址   : {url}")
    if site.get("expiresAt"):
        print(f"  有效期 : {site['expiresAt']}")
    if res.get("claimUrl"):
        print(f"  认领链接（1 小时内有效）: {res['claimUrl']}")


if __name__ == "__main__":
    main()
