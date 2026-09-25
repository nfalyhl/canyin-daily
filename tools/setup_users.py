# -*- coding: utf-8 -*-
"""管理登录账号（只存 PBKDF2 哈希，不存明文密码）。

用法：
    python tools\\setup_users.py --add YYQ 你的密码
    python tools\\setup_users.py --add 管理员 你的密码
    python tools\\setup_users.py --list
    python tools\\setup_users.py --del 用户名
    python tools\\setup_users.py --passwd 用户名 新密码

不传参数则进入交互式添加。
"""
import argparse
import getpass
import hashlib
import json
import os
import secrets
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
USERS = ROOT / "config" / "users.json"
ITER = 150_000


def load():
    if USERS.exists():
        try:
            return json.loads(USERS.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"users": []}


def save(doc):
    USERS.parent.mkdir(parents=True, exist_ok=True)
    USERS.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(USERS, 0o600)
    except Exception:
        pass


def make_hash(password: str) -> dict:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITER)
    return {"salt": salt.hex(), "hash": digest.hex(), "iterations": ITER}


def find(doc, name):
    for u in doc["users"]:
        if u["username"] == name:
            return u
    return None


def main():
    ap = argparse.ArgumentParser(description="管理餐饮日报的登录账号")
    ap.add_argument("--add", nargs=2, metavar=("用户名", "密码"))
    ap.add_argument("--passwd", nargs=2, metavar=("用户名", "新密码"))
    ap.add_argument("--del", dest="delete", metavar="用户名")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    doc = load()

    if args.list:
        if not doc["users"]:
            print("还没有任何账号。")
        for u in doc["users"]:
            print(f"  {u['username']:<12} 创建于 {u.get('created', '?')}")
        return

    if args.delete:
        before = len(doc["users"])
        doc["users"] = [u for u in doc["users"] if u["username"] != args.delete]
        if len(doc["users"]) == before:
            print(f"没找到账号：{args.delete}")
            return
        save(doc)
        print(f"已删除账号：{args.delete}")
        return

    if args.passwd:
        name, pwd = args.passwd
        u = find(doc, name)
        if not u:
            print(f"没找到账号：{name}")
            return
        u.update(make_hash(pwd))
        u["updated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        save(doc)
        print(f"已更新密码：{name}")
        return

    if args.add:
        name, pwd = args.add
    else:
        name = input("用户名: ").strip()
        pwd = getpass.getpass("密码: ")
        if not name or not pwd:
            print("用户名和密码都不能为空。")
            return

    if len(pwd) < 6:
        print("密码至少 6 位。")
        return

    if find(doc, name):
        print(f"账号 {name} 已存在，用 --passwd 改密码。")
        return

    rec = {"username": name, "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    rec.update(make_hash(pwd))
    doc["users"].append(rec)
    save(doc)
    print(f"已创建账号：{name}（仅保存哈希，明文不入盘）")
    print(f"账号文件：{USERS}")


if __name__ == "__main__":
    main()
