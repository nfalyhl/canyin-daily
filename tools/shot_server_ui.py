# -*- coding: utf-8 -*-
"""对「登录 + 双板块」界面截图自检。

做法：用真实账号登录，把服务端返回的页面元素抓下来，
在临时副本里把 ON_SERVER 打开、用假 fetch 提供 /api 响应（仅截图用，不动源文件），
再用无头 Edge 渲染。这样能同时看到外网节点卡片等登录后才会出现的部分。

用法：python tools\\shot_server_ui.py [端口] [宽] [高]
"""
import http.cookiejar
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
ROOT = Path(__file__).resolve().parent.parent
TMP = Path(r"C:\Users\Lenovo\AppData\Local\Temp\cd-srv")

PORT = sys.argv[1] if len(sys.argv) > 1 else "8848"
W = int(sys.argv[2]) if len(sys.argv) > 2 else 1680
H = int(sys.argv[3]) if len(sys.argv) > 3 else 1180
BASE = f"http://127.0.0.1:{PORT}"

FAKE_API = """
<script>
(function () {
  var canned = {
    '/api/session': { logged_in: true, user: 'YYQ' },
    '/api/settings': { proxy: 'http://127.0.0.1:7897', updated_at: '2026-09-25 22:51:46' },
    '/api/logout': { ok: true },
    '/api/collect': { ok: true },
    '/api/collect/status': { running: false, code: 0, log: [
      '✓[外] QSR Magazine   25 条',
      '✓[外] Restaurant Dive 10 条',
      '✓ 采集完成' ] },
    '/api/translate/lookup': { lang: 'zh', map: {}, pending: 0, cached: 85, total: 85 },
    '/api/translate/status': { running: false, code: 0, done: 85, total: 85, lang: 'zh', log: [] },
    '/api/translate/languages': { langs: [{ id: 'zh', label: '中文' }, { id: 'zh-TW', label: '繁體' },
      { id: 'en', label: 'English' }, { id: 'ja', label: '日本語' }, { id: 'ko', label: '한국어' }] },
    '/api/proxy-test': { proxy: 'http://127.0.0.1:7897', results: [
      { name: 'QSR Magazine', ok: true, kind: 'RSS', ms: 820 },
      { name: 'Restaurant Dive', ok: true, kind: 'RSS', ms: 410 },
      { name: 'Retail Dive', ok: true, kind: 'RSS', ms: 660 } ] }
  };
  window.fetch = function (url, opt) {
    var p = String(url).split('?')[0];
    var body = canned[p];
    if (body) {
      return Promise.resolve({ ok: true, status: 200,
        json: function () { return Promise.resolve(body); } });
    }
    return Promise.resolve({ ok: false, status: 404,
      json: function () { return Promise.resolve({}); } });
  };
})();
</script>
"""


def main():
    if TMP.exists():
        shutil.rmtree(TMP, ignore_errors=True)
    site = TMP / "site"
    site.mkdir(parents=True, exist_ok=True)

    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    req = urllib.request.Request(BASE + "/api/login",
                                data=json.dumps({"username": "YYQ",
                                                 "password": "20000921"}).encode(),
                                headers={"Content-Type": "application/json"},
                                method="POST")
    with op.open(req, timeout=30) as r:
        print("  登录:", json.loads(r.read().decode()))

    for name in ("index.html", "style.css", "app.js", "manifest.webmanifest",
                 "icon-192.png", "login.html"):
        try:
            with op.open(BASE + "/" + name, timeout=30) as r:
                (site / name).write_bytes(r.read())
        except Exception as e:
            print(f"  ! {name}: {e}")

    # 截图专用改动：打开 ON_SERVER、默认进外网板块、注入假 API
    js = (site / "app.js").read_text(encoding="utf-8")
    js = js.replace("var ON_SERVER = location.protocol === 'http:' || location.protocol === 'https:';",
                    "var ON_SERVER = true;")
    js = js.replace("var DEFAULT_SECTION = 'cn';", "var DEFAULT_SECTION = 'global';")
    js = js.replace("lang: 'orig',", "lang: 'zh',")
    js = js.replace("state.lang = localStorage.getItem(LANG_KEY) || 'orig';",
                    "state.lang = localStorage.getItem(LANG_KEY) || 'zh';")
    (site / "app.js").write_text(js, encoding="utf-8")

    html = (site / "index.html").read_text(encoding="utf-8")
    html = html.replace('<script src="app.js"></script>', FAKE_API + '<script src="app.js"></script>')
    (site / "index.html").write_text(html, encoding="utf-8")

    shots = [("app", "index.html", "?shift=day"), ("login", "login.html", "")]
    for label, page, q in shots:
        out = TMP / f"{label}.png"
        subprocess.run([
            EDGE, "--headless=new", "--disable-gpu", "--no-sandbox",
            f"--user-data-dir={TMP / ('p_' + label)}", "--hide-scrollbars",
            "--force-device-scale-factor=1", "--virtual-time-budget=7000",
            f"--window-size={W},{H}", f"--screenshot={out}",
            "file:///" + str(site / page).replace("\\", "/") + q,
        ], capture_output=True, timeout=120)
        print(("  ✓ " if out.exists() else "  ✗ ") + str(out))


if __name__ == "__main__":
    main()
