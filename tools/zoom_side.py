# -*- coding: utf-8 -*-
"""放大截取左侧栏（外网节点 / 翻译服务 两张卡），用于说明怎么填 Key。

用法：python tools\\zoom_side.py [宽] [高]
"""
import http.cookiejar
import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
ROOT = Path(__file__).resolve().parent.parent
TMP = Path(r"C:\Users\Lenovo\AppData\Local\Temp\cd-side")
BASE = "http://127.0.0.1:8848"

BOX_W = int(sys.argv[1]) if len(sys.argv) > 1 else 520
BOX_H = int(sys.argv[2]) if len(sys.argv) > 2 else 800
SCALE = 2
TOP = int(sys.argv[3]) if len(sys.argv) > 3 else 400   # 原始页面上从 y=TOP/SCALE 开始显示

FAKE_API = """
<script>
(function () {
  var canned = {
    '/api/session': { logged_in: true, user: 'YYQ' },
    '/api/settings': { proxy: 'http://127.0.0.1:7897', provider: 'llm', scope: 'all',
                       base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
                       has_key: true, key_hint: 'sk-****00', updated_at: '2026-09-26 00:45:00' },
    '/api/translate/lookup': { lang: 'zh', map: {}, pending: 0, cached: 85, total: 85 },
    '/api/translate/status': { running: false, code: 0, done: 85, total: 85, log: [] },
    '/api/collect/status': { running: false, code: 0, log: [] }
  };
  window.fetch = function (url) {
    var p = String(url).split('?')[0];
    var body = canned[p];
    if (body) return Promise.resolve({ ok: true, status: 200,
      json: function () { return Promise.resolve(body); } });
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
                                headers={"Content-Type": "application/json"}, method="POST")
    with op.open(req, timeout=30) as r:
        json.loads(r.read().decode())
    for name in ("index.html", "style.css", "app.js", "manifest.webmanifest", "icon-192.png"):
        with op.open(BASE + "/" + name, timeout=30) as r:
            (site / name).write_bytes(r.read())

    js = (site / "app.js").read_text(encoding="utf-8")
    js = js.replace("var ON_SERVER = location.protocol === 'http:' || location.protocol === 'https:';",
                    "var ON_SERVER = true;")
    js = js.replace("var DEFAULT_SECTION = 'cn';", "var DEFAULT_SECTION = 'global';")
    js = js.replace("state.lang = localStorage.getItem(LANG_KEY) || 'orig';",
                    "state.lang = localStorage.getItem(LANG_KEY) || 'zh';")
    (site / "app.js").write_text(js, encoding="utf-8")

    html = (site / "index.html").read_text(encoding="utf-8")
    html = html.replace('<script src="app.js"></script>', FAKE_API + '<script src="app.js"></script>')
    (site / "index.html").write_text(html, encoding="utf-8")

    (TMP / "wrap.html").write_text(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
        'html,body{margin:0;background:#888}'
        '.box{position:relative;overflow:hidden;width:%dpx;height:%dpx}'
        'iframe{position:absolute;left:-8px;top:-%dpx;width:1680px;height:1400px;'
        'border:0;transform:scale(%d);transform-origin:0 0}'
        '</style></head><body><div class="box">'
        '<iframe src="site/index.html?shift=day"></iframe></div></body></html>'
        % (BOX_W, BOX_H, TOP, SCALE), encoding="utf-8")

    out = TMP / "side.png"
    subprocess.run([
        EDGE, "--headless=new", "--disable-gpu", "--no-sandbox",
        f"--user-data-dir={TMP / 'p'}", "--hide-scrollbars",
        "--force-device-scale-factor=1", "--virtual-time-budget=7000",
        f"--window-size={BOX_W},{BOX_H}", f"--screenshot={out}",
        "file:///" + str(TMP / "wrap.html").replace("\\", "/"),
    ], capture_output=True, timeout=120)
    print(("  ✓ " if out.exists() else "  ✗ ") + str(out))


if __name__ == "__main__":
    main()
