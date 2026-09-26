/* ==========================================================================
   餐饮日报 · 登录门禁 & 设备名额（auth.js）
   --------------------------------------------------------------------------
   两种工作模式（页面里内联的 auth-config 决定，见 daily.py / index.template.html）：
     remote —— 站点跑在静态托管（GitHub Pages）上：没有后端，所以登录校验和设备
               名额由「鉴权服务」（cloud/main.ts，部署到 Deno Deploy）负责。
               未登录时用全屏门禁盖住页面。
     local  —— 站点跑在本机 server.py 上：服务端本来就要求登录（会跳 /login.html），
               这里只补上「设备管理」界面。
     off    —— 没配置鉴权服务，且不在本机服务器上（例如双击打开的离线单文件：
               没有网络就不打扰）。

   设备身份：localStorage 里的 canyin-device-id（每个浏览器一份，清缓存会换新）。
   会话凭证：remote 模式下存在 localStorage（token），local 模式用服务端 Cookie。
   ========================================================================== */
(function () {
  'use strict';

  var DEV_KEY = 'canyin-device-id';
  var TOK_KEY = 'canyin-auth-token';
  var USER_KEY = 'canyin-auth-user';
  var LS_THEME = 'canyin-shift';

  var AUTH = {
    mode: 'off',          // off | local | remote
    enabled: false,
    base: '',             // 鉴权服务地址（remote）
    user: '',
    deviceId: '',
    devices: [],
    maxDevices: 3,
    state: null,
    _subs: [],
    _gate: null,
    _sheet: null,
    _busy: false,
    _lockTimer: null
  };
  window.CanyinAuth = AUTH;

  /* ------------------------------------------------------------ 小工具 --- */
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key) || '';
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, val);
    } catch (e) {}
    return '';
  }
  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function deviceId() {
    var id = store(DEV_KEY);
    if (!id || id.length < 6) { id = uuid(); store(DEV_KEY, id); }
    return id;
  }
  function uaName() {
    var ua = navigator.userAgent || '';
    var os = /Windows/.test(ua) ? 'Windows'
      : /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad'
      : /Android/.test(ua) ? 'Android'
      : /Macintosh/.test(ua) ? 'macOS'
      : /Linux/.test(ua) ? 'Linux' : '未知系统';
    var br = /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari' : '浏览器';
    return os + ' · ' + br;
  }
  function isLocalHost() {
    var h = location.hostname || '';
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' ||
      /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }

  /* --------------------------------------------------------------- 网络 --- */
  function req(url, payload, timeout) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, timeout || 15000) : null;
    return fetch(url, {
      method: payload === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: payload === undefined ? { 'Accept': 'application/json' }
                                     : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (t) clearTimeout(t);
      return r.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { data = null; }
        var err = new Error((data && (data.error || data.code)) || ('HTTP ' + r.status));
        err.status = r.status;
        err.data = data || {};
        if (!r.ok) throw err;
        return data || {};
      });
    }, function (e) {
      if (t) clearTimeout(t);
      var err = new Error('连不上鉴权服务（网络被拦截或服务未启动）');
      err.status = 0;
      err.data = {};
      throw err;
    });
  }

  function api(path, payload, timeout) {
    var url = AUTH.mode === 'remote' ? AUTH.base + path : path;
    return req(url, payload, timeout);
  }

  function norm(r) {
    r = r || {};
    return {
      user: r.user || '',
      deviceId: r.deviceId || r.device_id || AUTH.deviceId,
      devices: r.devices || [],
      maxDevices: r.maxDevices || r.max_devices || AUTH.maxDevices || 3
    };
  }

  function setState(st) {
    AUTH.state = st;
    if (st && st.user) {
      AUTH.user = st.user;
      AUTH.devices = st.devices || [];
      AUTH.maxDevices = st.maxDevices || 3;
      AUTH.deviceId = st.deviceId || AUTH.deviceId;
    }
    AUTH._subs.forEach(function (cb) {
      try { cb(AUTH.state); } catch (e) {}
    });
  }

  AUTH.onChange = function (cb) {
    AUTH._subs.push(cb);
    if (AUTH.state) setTimeout(function () { try { cb(AUTH.state); } catch (e) {} }, 0);
    return AUTH;
  };

  /* ------------------------------------------------------------ 门禁 UI --- */
  var CSS = [
    '.gate{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;',
    'padding:24px;background:var(--bg);}',
    '.gate[hidden]{display:none}',
    '.gate__card{width:min(420px,100%);max-height:calc(100vh - 48px);overflow:auto;background:var(--surface);',
    'border:1px solid var(--line-2);border-radius:8px;padding:28px 30px;box-shadow:var(--shadow);}',
    '.gate__brand{display:flex;align-items:baseline;gap:9px}',
    '.gate__brand b{font-size:23px;font-weight:800;letter-spacing:.05em}',
    '.gate__brand span{font-family:var(--mono);font-size:9.5px;letter-spacing:.2em;color:var(--ink-3);',
    'padding-left:9px;border-left:1px solid var(--line)}',
    '.gate__sub{margin:6px 0 20px;font-size:12.5px;color:var(--ink-3)}',
    '.gate label{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;',
    'color:var(--ink-3);margin:14px 0 6px;text-transform:uppercase}',
    '.gate input{width:100%;padding:10px 12px;font:inherit;font-size:14.5px;color:var(--ink);',
    'background:var(--recess);border:1px solid var(--line);border-radius:5px}',
    '.gate input:focus{outline:2px solid var(--c-trend);outline-offset:1px;border-color:transparent}',
    '.gate__submit{width:100%;margin-top:20px;padding:11px;font:inherit;font-size:14.5px;font-weight:600;',
    'color:var(--surface);background:var(--ink);border:0;border-radius:5px;cursor:pointer}',
    '.gate__submit:disabled{opacity:.6;cursor:default}',
    '.gate__err{margin:12px 0 0;font-size:12.5px;color:var(--c-product);min-height:18px;line-height:1.6}',
    '.gate__limit{margin-top:16px;border-top:1px dashed var(--line);padding-top:14px}',
    '.gate__limit[hidden]{display:none}',
    '.gate__hint{margin:0 0 10px;font-size:12px;color:var(--ink-2);line-height:1.7}',
    '.gate__list{list-style:none;margin:0;padding:0;display:grid;gap:7px}',
    '.gate__item{display:flex;align-items:center;gap:10px;padding:9px 11px;background:var(--recess);',
    'border:1px solid var(--line-2);border-radius:6px}',
    '.gate__item--now{border-style:dashed}',
    '.gate__itemMain{flex:1;min-width:0}',
    '.gate__itemMain b{display:block;font-size:13px;font-weight:600}',
    '.gate__itemMain span{font-size:11px;color:var(--ink-3)}',
    '.gate__foot{margin:16px 0 0;font-size:11.5px;color:var(--ink-3);line-height:1.7}',
    '.gate__foot .mono{font-family:var(--mono)}',
    'html.gate-pending main.shell,html.gate-pending .langbar{visibility:hidden}',
    '.devrow{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px dashed var(--line)}',
    '.devrow:last-child{border-bottom:0}',
    '.devrow__main{flex:1;min-width:0}',
    '.devrow__main b{font-size:13.5px;font-weight:600}',
    '.devrow__main span{display:block;font-family:var(--mono);font-size:11px;color:var(--ink-3)}',
    '.devrow__now{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;color:var(--c-trend);',
    'border:1px solid var(--c-trend);border-radius:3px;padding:2px 6px;white-space:nowrap}'
  ].join('');

  function injectCss() {
    if (document.getElementById('auth-css')) return;
    var s = document.createElement('style');
    s.id = 'auth-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function gateHtml(cfg) {
    var title = (cfg && cfg.title) || '餐饮日报';
    return '' +
      '<div class="gate__card">' +
      '  <div class="gate__brand"><b>' + esc(title) + '</b><span>DAILY&nbsp;PASS</span></div>' +
      '  <p class="gate__sub">内网 / 外网双板块 · 每日餐饮行业情报</p>' +
      '  <form id="authForm" autocomplete="on" novalidate>' +
      '    <label for="authUser">用户名</label>' +
      '    <input id="authUser" type="text" autocomplete="username" autocapitalize="none"' +
      '           autocorrect="off" spellcheck="false" required>' +
      '    <label for="authPass">密码</label>' +
      '    <input id="authPass" type="password" autocomplete="current-password" required>' +
      '    <button type="submit" class="gate__submit" id="authSubmit">登录</button>' +
      '  </form>' +
      '  <p class="gate__err" id="authErr" role="alert"></p>' +
      '  <div class="gate__limit" id="authLimit" hidden>' +
      '    <p class="gate__hint">该账号的设备名额已满（上限 <b class="mono" id="authLimitMax">3</b> 台）。' +
      '      选一台下线，就能在本机登录：</p>' +
      '    <ul class="gate__list" id="authLimitList"></ul>' +
      '  </div>' +
      '  <p class="gate__foot">每个账号最多 <span class="mono" id="authFootMax">3</span> 台设备同时在线；' +
      '    在设备上点「退出」会立刻释放名额。<br>本机识别：<span class="mono" id="authThis">—</span></p>' +
      '</div>';
  }

  function buildGate(cfg) {
    injectCss();
    var el = document.createElement('div');
    el.className = 'gate';
    el.id = 'authGate';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '登录');
    el.innerHTML = gateHtml(cfg);
    document.body.appendChild(el);
    AUTH._gate = el;
    var max = String(AUTH.maxDevices || 3);
    var m1 = document.getElementById('authLimitMax');
    var m2 = document.getElementById('authFootMax');
    if (m1) m1.textContent = max;
    if (m2) m2.textContent = max;
    var th = document.getElementById('authThis');
    if (th) th.textContent = uaName();

    document.getElementById('authForm').addEventListener('submit', function (e) {
      e.preventDefault();
      gateSubmit(null);
    });
    return el;
  }

  function gateShow() { if (AUTH._gate) AUTH._gate.hidden = false; }
  function gateHide() {
    if (AUTH._gate) AUTH._gate.hidden = true;
    document.documentElement.classList.remove('gate-pending');
  }
  function gateErr(msg) {
    var e = document.getElementById('authErr');
    if (e) e.textContent = msg || '';
  }
  function gateBusy(on, text) {
    AUTH._busy = !!on;
    var b = document.getElementById('authSubmit');
    if (!b) return;
    b.disabled = !!on;
    b.textContent = text || (on ? '登录中…' : '登录');
  }
  function gateLock(sec) {
    if (AUTH._lockTimer) clearInterval(AUTH._lockTimer);
    var left = sec;
    gateBusy(true, '稍等 ' + left + ' 秒');
    AUTH._lockTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(AUTH._lockTimer);
        AUTH._lockTimer = null;
        gateBusy(false);
        gateErr('');
        return;
      }
      gateBusy(true, '稍等 ' + left + ' 秒');
    }, 1000);
  }

  function renderLimit(devices) {
    var box = document.getElementById('authLimit');
    var list = document.getElementById('authLimitList');
    if (!box || !list) return;
    if (!devices || !devices.length) { box.hidden = true; return; }
    box.hidden = false;
    list.innerHTML = devices.map(function (d) {
      return '<li class="gate__item' + (d.current ? ' gate__item--now' : '') + '">' +
        '<div class="gate__itemMain"><b>' + esc(d.name || '未知设备') + '</b>' +
        '<span>' + esc(d.last || '') + (d.ip ? ' · ' + esc(d.ip) : '') + '</span></div>' +
        (d.current
          ? '<span class="devrow__now">本机</span>'
          : '<button type="button" class="btn" data-kick="' + esc(d.id) + '">下线并登录</button>') +
        '</li>';
    }).join('');
    list.querySelectorAll('[data-kick]').forEach(function (b) {
      b.addEventListener('click', function () { gateSubmit(b.getAttribute('data-kick')); });
    });
  }

  function gateSubmit(kick) {
    if (AUTH._busy) return;
    var u = (document.getElementById('authUser').value || '').trim();
    var p = document.getElementById('authPass').value || '';
    if (!u || !p) { gateErr('用户名和密码都要填'); return; }
    gateErr('');
    gateBusy(true);
    api('/api/login', {
      username: u,
      password: p,
      deviceId: AUTH.deviceId,
      deviceName: uaName(),
      kick: kick || undefined
    }).then(function (r) {
      store(TOK_KEY, r.token || '');
      store(USER_KEY, r.user || u);
      gateBusy(false);
      gateHide();
      setState(norm(r));
    }).catch(function (e) {
      gateBusy(false);
      var d = (e && e.data) || {};
      if (d.code === 'device_limit') {
        var max = document.getElementById('authLimitMax');
        if (max) max.textContent = String(d.maxDevices || AUTH.maxDevices || 3);
        renderLimit(d.devices || []);
        gateErr(d.error || '设备名额已满');
        return;
      }
      if (d.code === 'locked') {
        var m = /(\d+)\s*秒/.exec(d.error || '');
        gateLock(m ? parseInt(m[1], 10) : 60);
        gateErr(d.error || '失败次数太多，请稍后再试');
        return;
      }
      if (e.status === 0) {
        gateErr('连不上鉴权服务：' + e.message + '（可以点登录重试）');
        return;
      }
      gateErr(d.error || e.message || '登录失败');
    });
  }

  function startRemote(cfg) {
    AUTH.mode = 'remote';
    AUTH.enabled = true;
    AUTH.base = String(cfg.authBase).replace(/\/+$/, '');
    AUTH.deviceId = deviceId();
    AUTH.maxDevices = parseInt(cfg.maxDevices, 10) || 3;
    document.documentElement.classList.add('gate-pending');
    buildGate(cfg);
    gateShow();
    var token = store(TOK_KEY);
    if (!token) {
      AUTH.ready = Promise.resolve(null);
      return AUTH.ready;
    }
    AUTH.ready = api('/api/session', { token: token }).then(function (r) {
      gateHide();
      setState(norm(r));
      return AUTH.state;
    }).catch(function (e) {
      var d = (e && e.data) || {};
      if (e.status === 401 || d.code === 'unauthorized') {
        store(TOK_KEY, null);
        gateErr('上次的登录已失效，请重新登录');
      } else if (e.status === 0) {
        gateErr('连不上鉴权服务：' + e.message + '（点登录可重试）');
      } else {
        gateErr(d.error || e.message || '');
      }
      setState(null);
      return null;
    });
    return AUTH.ready;
  }

  function startLocal() {
    AUTH.mode = 'local';
    AUTH.enabled = true;
    AUTH.deviceId = deviceId();
    AUTH.ready = req('/api/session', undefined, 6000).then(function (r) {
      var st = norm(r);
      if (!r.logged_in && !st.user) return null;
      setState(st);
      return st;
    }).catch(function () { return null; });
    return AUTH.ready;
  }

  /* ------------------------------------------------------- 设备管理弹窗 --- */
  function buildSheet() {
    injectCss();
    var d = document.createElement('dialog');
    d.className = 'sheet';
    d.id = 'devSheet';
    d.innerHTML =
      '<div class="sheet__bar"><strong>已登录设备</strong>' +
      '<button type="button" class="btn" id="devSheetClose">关闭</button></div>' +
      '<ul class="sheet__list" id="devList"></ul>' +
      '<p class="formula" id="devNote"></p>';
    document.body.appendChild(d);
    AUTH._sheet = d;
    document.getElementById('devSheetClose').addEventListener('click', function () { d.close(); });
    if (typeof d.showModal !== 'function') {
      d.setAttribute('open', 'open');
      d.style.position = 'fixed';
      d.style.zIndex = '95';
    }
    return d;
  }

  function openSheet() {
    var d = AUTH._sheet || buildSheet();
    if (typeof d.showModal === 'function') { try { d.showModal(); } catch (e) {} }
    else d.setAttribute('open', 'open');
    loadDevices();
  }

  function renderDevices(st) {
    var list = document.getElementById('devList');
    var note = document.getElementById('devNote');
    if (!list) return;
    var max = (st && st.maxDevices) || AUTH.maxDevices || 3;
    var devices = (st && st.devices) || AUTH.devices || [];
    if (!devices.length) {
      list.innerHTML = '<li style="color:var(--ink-3);font-size:12.5px">暂时读不到设备列表</li>';
      return;
    }
    list.innerHTML = devices.map(function (d) {
      return '<li class="devrow">' +
        '<div class="devrow__main"><b>' + esc(d.name || '未知设备') + '</b>' +
        '<span>最后在线 ' + esc(d.last || '') + (d.ip ? ' · ' + esc(d.ip) : '') +
        (d.first ? ' · 首次 ' + esc(d.first) : '') + '</span></div>' +
        (d.current
          ? '<span class="devrow__now">本机</span>'
          : '<button type="button" class="btn" data-kick="' + esc(d.id) + '">下线</button>') +
        '</li>';
    }).join('');
    if (note) {
      note.textContent = '当前 ' + devices.length + ' / ' + max + ' 台；下线一台即可腾出名额。' +
        '（设备数据由鉴权服务记录，退出登录会自动释放）';
    }
    list.querySelectorAll('[data-kick]').forEach(function (b) {
      b.addEventListener('click', function () { kickDevice(b.getAttribute('data-kick')); });
    });
  }

  function loadDevices() {
    var token = store(TOK_KEY);
    var payload = AUTH.mode === 'remote' ? { token: token } : undefined;
    var call = AUTH.mode === 'remote'
      ? api('/api/devices', payload)
      : req('/api/devices', undefined, 8000);
    return call.then(function (r) {
      var st = norm(r);
      setState(st);
      renderDevices(st);
    }).catch(function (e) {
      var list = document.getElementById('devList');
      if (list) {
        list.innerHTML = '<li style="color:var(--c-product);font-size:12.5px">' +
          esc((e && e.message) || '读取失败') + '</li>';
      }
    });
  }

  function kickDevice(id) {
    if (!id) return;
    var token = store(TOK_KEY);
    var body = AUTH.mode === 'remote' ? { token: token, deviceId: id } : { deviceId: id };
    var call = AUTH.mode === 'remote' ? api('/api/devices/kick', body) : req('/api/devices/kick', body, 8000);
    call.then(function (r) {
      var st = norm(r);
      setState(st);
      renderDevices(st);
    }).catch(function (e) { alert('下线失败：' + ((e && e.message) || '')); });
  }

  /* --------------------------------------------------------- 顶栏 / 退出 --- */
  function wireTopbar() {
    var w = $('#whoami');
    var l = $('#logoutBtn');
    var dbtn = $('#devBtn');
    if (!dbtn && l && l.parentNode) {
      dbtn = document.createElement('button');
      dbtn.type = 'button';
      dbtn.className = 'btn';
      dbtn.id = 'devBtn';
      dbtn.textContent = '设备';
      l.parentNode.insertBefore(dbtn, l);
    }
    if (dbtn) dbtn.addEventListener('click', openSheet);

    AUTH.onChange(function (st) {
      var on = !!(st && st.user);
      if (w) {
        if (on) { w.textContent = st.user; w.title = '已登录：' + st.user; w.hidden = false; }
        else { w.hidden = true; }
      }
      if (l) l.hidden = !on;
      if (dbtn) dbtn.hidden = !on;
    });

    if (l) {
      l.addEventListener('click', function () {
        if (!confirm('退出登录？退出后会释放这台设备的登录名额。')) return;
        var token = store(TOK_KEY);
        store(TOK_KEY, null);
        if (AUTH.mode === 'remote') {
          api('/api/logout', { token: token }).catch(function () {});
          location.reload();
        } else {
          req('/api/logout', {}, 6000).catch(function () {}).then(function () {
            location.replace('/login.html');
          });
        }
      });
    }
  }

  /* -------------------------------------------------------------- 启动 --- */
  function readInline() {
    var el = document.getElementById('auth-config');
    if (!el) return null;
    try {
      var v = JSON.parse(el.textContent);
      return (v && typeof v === 'object') ? v : null;
    } catch (e) { return null; }
  }

  function start(cfg) {
    cfg = cfg || {};
    AUTH.deviceId = deviceId();
    var local = isLocalHost();
    if (location.protocol === 'file:') { AUTH.mode = 'off'; return; }
    // 安卓 App / 离线单文件：内容是打包那一刻的快照，不强制登录
    if (window.AppBridge) { AUTH.mode = 'off'; return; }
    if (local) {
      wireTopbar();
      startLocal();
      return;
    }
    if (cfg.authBase) {
      wireTopbar();
      startRemote(cfg);
      return;
    }
    // 内联配置没有 authBase：再探测一次同源后端（老版本部署可能没内联配置）
    wireTopbar();
    req('/api/session', undefined, 4000).then(function (r) {
      if (r && typeof r === 'object' && 'logged_in' in r) {
        AUTH.mode = 'local';
        AUTH.enabled = true;
        var st = norm(r);
        if (r.logged_in) setState(st);
      }
    }).catch(function () {});
  }

  var inline = readInline();
  if (inline) {
    start(inline);
  } else {
    fetch('auth-config.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(start);
  }
})();
