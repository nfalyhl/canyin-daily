/* ==========================================================================
   餐饮日报 · 手机端（B 站手机端风格）
   --------------------------------------------------------------------------
   只在窄屏（<= 820px）生效；宽屏什么都不做，交给 app.js 的桌面版。
     · 顶部：品牌 + 日期，右上「搜索 / 设置」
     · 胶囊标签：全部 / 内网 / 外网 + 品类横滑
     · 卡片流（标题两行 + 摘要两行 + 品类/板块/来源/时间）
     · 底部四格：首页 / 要点 / 图表 / 我的
     · 顶栏：搜索 / 白天·夜班切换 / 设置（每个页面都在）
     · 设置入口：顶栏齿轮、「我的」标签
     · 数据源：页面内联数据 → 鉴权服务（登录后下发）→ 静态 data/*.json
   偏好存在 localStorage 的 canyin-mobile；主题沿用 canyin-shift（与桌面版共用）。
   ========================================================================== */
(function () {
  'use strict';

  var MQ = window.matchMedia('(max-width: 820px)');
  window.CanyinMobile = { active: MQ.matches, openSettings: null };
  if (!MQ.matches) {
    // 宽屏 → 桌面版；若中途宽度跨越断点，刷新一次拿到正确的界面
    MQ.addEventListener && MQ.addEventListener('change', function () { location.reload(); });
    return;
  }

  var VERSION = 'v0.11 手机版';
  var PKEY = 'canyin-mobile';
  var SHIFT_KEY = 'canyin-shift';

  var ICON = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.6"/><path d="m15.8 15.8 4.2 4.2"/></svg>',
    set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h9M17.5 7H20M4 17h3M11.5 17H20"/><circle cx="15" cy="7" r="2.4"/><circle cx="9" cy="17" r="2.4"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3.5 10.6 12 4l8.5 6.6V20a1 1 0 0 1-1 1h-4.6v-6H9.1v6H4.5a1 1 0 0 1-1-1z"/></svg>',
    brief: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 20V10.5M10 20V4.5M16 20v-6.5M21 20H3"/></svg>',
    me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8.2" r="3.7"/><path d="M4.6 20c1.7-3.5 4.4-5.1 7.4-5.1S17.7 16.5 19.4 20"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4.1"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 11.4A8.5 8.5 0 1 0 19 16.6"/><path d="M20.6 5.6v5.6h-5.6"/></svg>',
  };

  /* 三大分类：数据里的 it.cat，顺序与 daily.py 的 CAT_ORDER 一致 */
  var CLASSES = ['product', 'trend', 'brand'];
  /* 时间分类：今天 = 当期（最新一期）；一周内 / 一月内 = 跨期汇总，按发布时间过滤 */
  var RANGES = [['today', '今天'], ['week', '一周内'], ['month', '一月内']];
  var RANGE_DAYS = { today: 0, week: 6, month: 29 };
  var CAT_FALLBACK = {
    product: { label: '产品上新', color: '#ff6b81' },
    trend: { label: '行业趋势', color: '#3d7eff' },
    brand: { label: '品牌动作', color: '#f0a020' },
  };

  /* ------------------------------------------------------------ 小工具 --- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function loadPrefs() {
    var d = { region: 'all', cls: 'all', cat: 'all', range: 'today', lang: 'orig', showCn: true, showGlobal: true, big: false, shift: '' };
    try {
      var o = JSON.parse(localStorage.getItem(PKEY) || '{}') || {};
      for (var k in d) if (k in o) d[k] = o[k];
    } catch (e) {}
    return d;
  }
  var prefs = loadPrefs();
  function savePrefs() { try { localStorage.setItem(PKEY, JSON.stringify(prefs)); } catch (e) {} }

  function readShift() { try { return localStorage.getItem(SHIFT_KEY) || ''; } catch (e) { return ''; } }
  function applyShift() {
    var mode = prefs.shift || readShift();
    if (mode !== 'day' && mode !== 'night') {
      mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
    }
    document.documentElement.dataset.shift = mode;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'night' ? '#16181c' : '#f6f7f8');
    renderShiftBtn();
  }
  function setShiftPref(v) {
    prefs.shift = v; savePrefs();
    try { if (v) localStorage.setItem(SHIFT_KEY, v); else localStorage.removeItem(SHIFT_KEY); } catch (e) {}
    applyShift();
  }

  /** 当前实际生效的是白天还是夜班 */
  function effectiveShift() {
    return document.documentElement.dataset.shift === 'night' ? 'night' : 'day';
  }

  /** 顶栏那个白天/夜班按钮（每个页面都能看到） */
  function renderShiftBtn() {
    if (!elShiftBtn) return;
    var night = effectiveShift() === 'night';
    elShiftBtn.innerHTML = (night ? ICON.moon : ICON.sun) + '<span>' + (night ? '夜班' : '白天') + '</span>';
    elShiftBtn.setAttribute('aria-label', night ? '现在夜班，点一下换白天' : '现在白天，点一下换夜班');
  }

  /* -------------------------------------------------------------- 状态 --- */
  var state = { digest: null, index: null, atlas: {}, tab: 'feed', q: '', devices: null, loading: true,
    limit: 200, rangeBusy: false, offline: false, cachedAt: '', emergency: false };

  var auth = function () { return window.CanyinAuth; };
  function isProtected() { var A = auth(); return !!(A && A.mode === 'remote' && A.protected); }
  function waitAuth() {
    var A = auth();
    return new Promise(function (res) {
      if (!A || A.mode === 'off' || A.mode === 'local') return res(A && A.state ? A.state : null);
      if (A.state && A.state.user) return res(A.state);
      A.onChange(function (s) { if (s && s.user) res(s); });
    });
  }

  /* -------------------------------------------------------------- 取数 --- */
  function inlineData() {
    try {
      var v = JSON.parse($('#boot-data').textContent);
      return (v && v.items && v.items.length) ? v : null;
    } catch (e) { return null; }
  }
  /** 离线单文件版（App / 微信传的那份）把最近几天数据内联成 {日期: digest} */
  function inlineArchive() {
    try { return JSON.parse($('#boot-archive').textContent) || null; } catch (e) { return null; }
  }
  function inlineIndex() {
    var a = inlineArchive();
    if (!a) return null;
    if (a.history) return a;                                   // 已经是 {latest, history}
    var dates = Object.keys(a).sort().reverse();
    if (!dates.length) return null;
    return {
      latest: dates[0],
      history: dates.map(function (k) {
        var x = a[k] || {};
        return { date: k, total: x.total || (x.items || []).length,
                 issue: x.issue, headline: x.headline };
      }),
    };
  }
  /* ------------------------------ 离线副本（连不上服务时先看上次的） --- */
  var CACHE_KEY = 'canyin-cache';
  function saveCache(dig, index) {
    if (!dig || !dig.items || !dig.items.length) return;
    try {
      var old = readCache();
      if (old && String(old.digest.date || '') > String(dig.date || '')) return;   // 别用旧期覆盖新期
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        savedAt: new Date().toISOString(), digest: dig, index: index || state.index || null,
      }));
    } catch (e) { /* 隐私模式 / 配额满：忽略 */ }
  }
  function readCache() {
    try {
      var v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return (v && v.digest && v.digest.items && v.digest.items.length) ? v : null;
    } catch (e) { return null; }
  }
  function cacheTimeText() {
    var c = readCache();
    if (!c || !c.savedAt) return '';
    var t = new Date(c.savedAt);
    if (isNaN(t.getTime())) return '';
    return pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
  }
  function offlineNote() {
    if (!state.offline) return '';
    var t = cacheTimeText();
    var hasCopy = !!readCache();
    var head = state.emergency
      ? '<b>应急口令通道</b>已解锁 · ' + ((state.digest && state.digest.date) || '')
      : ('连不上服务器' + (hasCopy ? '，现在看的是<b>离线副本</b>' + (t ? '（更新于 ' + t + '）' : '') : ''));
    return '<div class="m-note">' + head +
      '<br>网络或代理恢复后，点右上角 ⟳ 刷新即可。' +
      (state.emergency || !(window.crypto && window.crypto.subtle) ? '' :
        '<br><button class="m-mini" data-act="emergency">输入应急口令，看最新一期</button>') +
      '</div>';
  }

  /* ------------------------------ 应急口令通道（连不上服务时的后手） --- */
  function b64buf(s) {
    var bin = atob(String(s || ''));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  async function emergencyUnlock(pw) {
    if (!(window.crypto && window.crypto.subtle)) {
      toast('这个环境不支持本地解密（用 https 或本机打开才行）');
      return false;
    }
    var pass = pw;
    if (pass === undefined || pass === null) {
      pass = prompt('输入应急口令（连不上服务器时用）');
    }
    if (!pass) return false;
    try {
      toast('正在拉取并解密…');
      var r = await fetch('enc/latest.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var env = await r.json();
      var enc = new TextEncoder();
      var base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
      var key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64buf(env.kdf.salt), iterations: env.kdf.iter, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64buf(env.iv) },
        key, b64buf(env.ct));
      var dig = JSON.parse(new TextDecoder().decode(plain));
      if (!dig || !dig.items || !dig.items.length) throw new Error('内容不完整');
      state.digest = dig;
      state.atlas[dig.date] = dig;
      state.offline = true;
      state.emergency = true;
      saveCache(dig, state.index);
      renderAll();
      toast('已用应急口令打开 ' + dig.date + '（' + dig.items.length + ' 条）');
      return true;
    } catch (e) {
      toast('解密失败：' + (e && e.message ? e.message : e) + '（口令不对？）');
      return false;
    }
  }

  async function pull(date) {
    if (isProtected()) {
      try {
        var A = auth();
        await waitAuth();
        var got = await A.api('/api/digest', { token: A.token(), date: date || '' }, 45000);
        state.offline = false;
        return got;
      } catch (e) {
        var c0 = readCache();                       // 服务连不上：先用本机副本
        if (c0 && (!date || c0.digest.date === date)) {
          return { digest: c0.digest, index: c0.index || null, cached: true };
        }
        throw e;
      }
    }
    /* App / 双击离线版走 file://，fetch 读不到 data/*.json，改用页面内联的那份 */
    var inline = inlineData();
    var arch = inlineArchive();
    if (date) {
      if (inline && inline.date === date) return { digest: inline };
      if (arch && arch[date]) return { digest: arch[date] };
      var r = await fetch('data/digest-' + date + '.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { digest: await r.json() };
    }
    try {
      var ri = await fetch('data/index.json', { cache: 'no-store' });
      if (!ri.ok) throw new Error('HTTP ' + ri.status);
      var idx = await ri.json();
      var latest = (idx.history && idx.history[0] && idx.history[0].date) || idx.latest || '';
      if (latest && (!inline || latest !== inline.date)) {
        var rd = await fetch('data/digest-' + latest + '.json', { cache: 'no-store' });
        if (rd.ok) return { digest: await rd.json(), index: idx };
      }
      if (inline) return { digest: inline, index: idx };
      return { index: idx };
    } catch (e) {
      var ii = inlineIndex();
      if (inline) return { digest: inline, index: ii };
      if (ii && arch && arch[ii.latest]) return { digest: arch[ii.latest], index: ii };
      var c2 = readCache();
      if (c2 && !date) return { digest: c2.digest, index: c2.index || null, cached: true };
      throw e;
    }
  }
  function applyResult(r) {
    if (!r) return;
    if (r.cached) {
      state.offline = true;
      state.cachedAt = cacheTimeText();
    } else {
      state.offline = false;
      state.emergency = false;
      state.cachedAt = '';
    }
    if (r.index) state.index = r.index;
    if (r.digest && r.digest.items) {
      state.digest = r.digest;
      state.atlas[r.digest.date] = r.digest;
      if (!r.cached) saveCache(r.digest, r.index || state.index);
    }
  }

  /* ---------------------------------------------------------- 展示辅助 --- */
  function d() { return state.digest; }
  function catOf(id) {
    var cats = (d() && d().market && d().market.cats) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i];
    return null;
  }
  function labelOf(it) {
    // digest.labels 是 {product:"产品上新", …} 这种「id→名字」的映射（颜色在前端定），
    // 兼容以后改成 {label,color} 对象的写法。
    var lab = (d() && d().labels) || null;
    var hit = lab && (lab[it.cat] || (lab.cat && lab.cat[it.cat]));
    var fall = CAT_FALLBACK[it.cat] || null;
    if (typeof hit === 'string' && hit) {
      return { label: hit, color: (fall && fall.color) || '#fb7299' };
    }
    if (hit && hit.label) {
      return { label: hit.label, color: hit.color || (fall && fall.color) || '#fb7299' };
    }
    return fall || { label: it.cat || '资讯', color: '#9499a0' };
  }
  function tr(it) { return (it && it.tr && (it.tr[prefs.lang] || it.tr.zh)) || null; }
  function titleOf(it) {
    if (prefs.lang !== 'orig') { var t = tr(it); if (t && t.t) return t.t; }
    return it.title || '';
  }
  function summaryOf(it) {
    if (prefs.lang !== 'orig') { var t = tr(it); if (t && t.s) return t.s; }
    return it.summary || '';
  }
  function whenOf(it) {
    var s = it.published || it.time || '';
    if (!s) return '';
    var m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?/);
    if (!m) return String(s).slice(0, 10);
    return m[2] + '-' + m[3] + (m[4] ? ' ' + m[4] + ':' + (m[5] || '00') : '');
  }
  function regionName(r) { return r === 'global' ? '外网' : '内网'; }
  function regionOf(it) { return it.region === 'global' ? 'global' : 'cn'; }
  /** 设置里的两个开关：要不要显示这个板块 */
  function regionOn(r) { return r === 'global' ? prefs.showGlobal : prefs.showCn; }

  /* 三层筛选：板块(region) / 分类(cls=product|trend|brand) / 品类(cat=tea、coffee… 存在 it.bcats 里) */
  function itemPass(it, f) {
    if (!regionOn(it.region)) return false;
    if (f.region && f.region !== 'all' && regionOf(it) !== f.region) return false;
    if (f.cls && f.cls !== 'all' && it.cat !== f.cls) return false;
    if (f.cat && f.cat !== 'all' && (it.bcats || []).indexOf(f.cat) < 0) return false;
    return true;
  }
  /* ---------------------------------------------------- 时间分类（跨期） --- */
  /** 最近 N 天应有的期次（顺序：新 → 旧） */
  function recentDates(days) {
    var dates = [];
    var hist = (state.index && state.index.history) || [];
    hist.forEach(function (h) { if (h && h.date) dates.push(h.date); });
    if (!dates.length) {
      var a = inlineArchive();
      if (a) dates = Object.keys(a);
    }
    var cur = d() && d().date;
    if (cur && dates.indexOf(cur) < 0) dates.push(cur);
    dates = dates.filter(function (x, i) { return dates.indexOf(x) === i; }).sort();
    dates.reverse();
    return days > 0 ? dates.slice(0, days + 1) : dates.slice(0, 1);
  }
  function digestFor(date) {
    if (state.atlas[date]) return state.atlas[date];
    if (d() && d().date === date) return d();
    return null;
  }
  /** 把最近 N 期的数据补齐并缓存（离线版直接吃内联档案，不会联网） */
  async function ensureRange() {
    var days = RANGE_DAYS[prefs.range] || 0;
    if (!days) return { fetched: 0, failed: 0 };
    var queue = recentDates(days).filter(function (dt) { return !digestFor(dt); });
    var fetched = 0, failed = 0;
    async function worker() {
      while (queue.length) {
        var dt = queue.shift();
        try {
          var r = await pull(dt);
          if (r && r.digest && r.digest.items) { state.atlas[dt] = r.digest; fetched += 1; }
          else { failed += 1; }
        } catch (e) { failed += 1; }
      }
    }
    if (queue.length) await Promise.all([worker(), worker(), worker()]);
    return { fetched: fetched, failed: failed };
  }
  function inWindow(it, days) {
    var s = it._day || it.published || it.time || '';
    if (!s) return true;
    var t = Date.parse(String(s).length === 10 ? (s + 'T12:00:00') : s);
    if (isNaN(t)) return true;
    return (Date.now() - t) <= (days + 2) * 86400000;
  }
  function rangeLabel() {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i][0] === prefs.range) return RANGES[i][1];
    return '今天';
  }
  /** 当前时间分类下要展示的全部条目（周/月会合并多期并按 id 去重） */
  function rangeItems() {
    var cur = d();
    if (prefs.range === 'today') return (cur && cur.items) || [];
    var days = RANGE_DAYS[prefs.range];
    var seen = {}, out = [];
    recentDates(days).forEach(function (dt) {
      var dig = digestFor(dt);
      if (!dig || !dig.items) return;
      dig.items.forEach(function (it) {
        var key = it.id || it.url || (it.title + '|' + (it.published || ''));
        if (seen[key]) return;
        seen[key] = 1;
        /* 很多源不给发布时间，就用所属期号的日期兜底，否则全挤到「日期未知」 */
        if (!it._day) it._day = String(it.published || '').slice(0, 10) || String(dig.date || '');
        if (inWindow(it, days)) out.push(it);
      });
    });
    out.sort(function (a, b) {
      return String(b._day || b.published || '').localeCompare(String(a._day || a.published || ''));
    });
    return out;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(dt) {
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  }
  /** 2026-09-27 → 09-27 · 今天 */
  function dayLabel(dstr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dstr)) return dstr;
    var now = new Date();
    if (dstr === ymd(now)) return dstr.slice(5) + ' · 今天';
    if (dstr === ymd(new Date(now.getTime() - 86400000))) return dstr.slice(5) + ' · 昨天';
    var dt = new Date(dstr + 'T09:00:00');
    return dstr.slice(5) + ' · 周' + '日一二三四五六'.charAt(dt.getDay());
  }
  async function loadRangeWithHint() {
    var days = RANGE_DAYS[prefs.range] || 0;
    if (!days) return;
    var want = recentDates(days).filter(function (dt) { return !digestFor(dt); });
    if (!want.length) return;
    state.rangeBusy = true;
    renderAll();
    if (want.length > 1) toast('正在拉取最近 ' + want.length + ' 期…');
    var r = await ensureRange();
    state.rangeBusy = false;
    if (r.failed) toast('有 ' + r.failed + ' 期没拉到（网络不稳），先看已拿到的');
  }

  function countMatching(f) {
    var n = 0;
    rangeItems().forEach(function (it) { if (itemPass(it, f)) n++; });
    return n;
  }
  function itemsAll() {
    var q = state.q.trim().toLowerCase();
    return rangeItems().filter(function (it) {
      if (!itemPass(it, { region: prefs.region, cls: prefs.cls, cat: prefs.cat })) return false;
      if (q) {
        var hay = (titleOf(it) + ' ' + (summaryOf(it) || '') + ' ' + (it.source || '') + ' ' +
          (it.brands || []).join(' ') + ' ' + (it.tags || []).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }


  /* ---------------------------------------------------------------- DOM --- */
  var root = document.createElement('div');
  root.className = 'm-app';
  root.id = 'mApp';
  root.innerHTML = [
    '<header class="m-top">',
    '  <div class="m-brand"><b>餐饮日报</b><span id="mMeta">加载中…</span></div>',
    '  <button class="m-ico" id="mSearchBtn" aria-label="搜索">', ICON.search, '</button>',
    '  <button class="m-ico" id="mRefreshBtn" aria-label="刷新最新一期">', ICON.refresh, '</button>',
    '  <button class="m-ico m-ico--wide" id="mShiftBtn" aria-label="切换白天黑天"></button>',
    '  <button class="m-ico" id="mSetBtn" aria-label="设置">', ICON.set, '</button>',
    '</header>',
    '<nav class="m-tabs" id="mTabs"></nav>',
    '<div class="m-search" id="mSearchBar" hidden><input id="mQ" placeholder="搜标题 / 来源 / 品牌" enterkeyhint="search"><button id="mQClear">关闭</button></div>',
    '<main class="m-main" id="mMain"></main>',
    '<nav class="m-nav" id="mNav">',
    '  <button data-tab="feed">' + ICON.home + '<span>首页</span></button>',
    '  <button data-tab="brief">' + ICON.brief + '<span>要点</span></button>',
    '  <button data-tab="chart">' + ICON.chart + '<span>图表</span></button>',
    '  <button data-tab="me">' + ICON.me + '<span>我的</span></button>',
    '</nav>',
    '<div class="m-drawer" id="mDrawer" aria-hidden="true">',
    '  <div class="m-drawer__mask" id="mMask"></div>',
    '  <section class="m-drawer__panel" role="dialog" aria-label="设置">',
    '    <header class="m-drawer__bar"><button class="m-back" id="mBack">‹ 返回</button><b>设置</b></header>',
    '    <div class="m-drawer__body" id="mDrawerBody"></div>',
    '  </section>',
    '</div>',
    '<div class="m-toast" id="mToast"></div>',
  ].join('');

  applyShift();
  if (prefs.big) root.classList.add('is-big');
  document.body.appendChild(root);
  document.body.classList.add('m-on');

  var elTabs = $('#mTabs'), elMain = $('#mMain'), elDrawer = $('#mDrawer'),
    elDrawerBody = $('#mDrawerBody'), elNav = $('#mNav'), elMeta = $('#mMeta'),
    elToast = $('#mToast'), elSearchBar = $('#mSearchBar'), elShiftBtn = $('#mShiftBtn'),
    elRefreshBtn = $('#mRefreshBtn');

  function toast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { elToast.classList.remove('is-on'); }, 2100);
  }

  /* -------------------------------------------------------------- 渲染 --- */
  function card(it) {
    var c = labelOf(it);
    var bc = (it.bcats && it.bcats.length) ? catOf(it.bcats[0]) : null;
    return [
      '<a class="m-card" href="', esc(it.url || '#'), '" target="_blank" rel="noopener noreferrer">',
      '  <div class="m-card__t">', esc(titleOf(it)), '</div>',
      summaryOf(it) ? '  <p class="m-card__s">' + esc(summaryOf(it)) + '</p>' : '',
      '  <div class="m-card__m">',
      '    <span class="m-chip m-chip--', it.region === 'global' ? 'global' : 'cn', '">', regionName(it.region), '</span>',
      '    <span class="m-chip m-chip--cat" style="--c:', esc(c.color), '">', esc(c.label), '</span>',
      bc ? '<span class="m-chip m-chip--cat" style="--c:' + esc(bc.color) + '">' + esc(bc.label) + '</span>' : '',
      '    <span class="m-src">', esc(it.source || ''), '</span>',
      whenOf(it) ? '    <span class="m-dot"></span><span>' + esc(whenOf(it)) + '</span>' : '',
      '  </div>',
      '</a>',
    ].join('');
  }

  function renderTabs() {
    var html = [];
    var f = { cls: prefs.cls, cat: prefs.cat };
    if (prefs.showCn && prefs.showGlobal) {
      html.push(pill('region', 'all', '全部', countMatching(f)));
    }
    if (prefs.showCn) html.push(pill('region', 'cn', '内网', countMatching({ region: 'cn', cls: prefs.cls, cat: prefs.cat })));
    if (prefs.showGlobal) html.push(pill('region', 'global', '外网', countMatching({ region: 'global', cls: prefs.cls, cat: prefs.cat })));
    /* 时间分类：今天 / 一周内 / 一月内 */
    html.push('<span class="m-tabs__sep"></span>');
    RANGES.forEach(function (r) {
      var on = prefs.range === r[0];
      html.push(pill('range', r[0], r[1], on ? countMatching({ region: prefs.region, cls: prefs.cls, cat: prefs.cat }) : 0));
    });
    /* 三大分类：产品上新 / 行业趋势 / 品牌动作 */
    html.push('<span class="m-tabs__sep"></span>');
    html.push(pill('cls', 'all', '全部分类', countMatching({ region: prefs.region, cat: prefs.cat })));
    CLASSES.forEach(function (k) {
      var lb = labelOf({ cat: k });
      html.push(pill('cls', k, lb.label, countMatching({ region: prefs.region, cat: prefs.cat, cls: k }), lb.color));
    });
    /* 品类：数据存在 it.bcats 里 */
    var cats = (d() && d().market && d().market.cats) || [];
    if (cats.length) {
      html.push('<span class="m-tabs__sep"></span>');
      html.push(pill('cat', 'all', '全品类', countMatching({ region: prefs.region, cls: prefs.cls })));
      cats.slice(0, 12).forEach(function (c) {
        html.push(pill('cat', c.id, c.label, countMatching({ region: prefs.region, cls: prefs.cls, cat: c.id }), c.color));
      });
    }
    elTabs.innerHTML = html.join('');
  }
  function pill(kind, value, label, count, color) {
    var cur = kind === 'region' ? prefs.region
      : (kind === 'cls' ? prefs.cls : (kind === 'range' ? prefs.range : prefs.cat));
    var on = cur === value;
    return '<button class="m-pill' + (on ? ' is-on' : '') + '" data-kind="' + kind + '" data-value="' + esc(value) +
      '"' + (color ? ' style="--c:' + esc(color) + '"' : '') + '>' + esc(label) +
      (count ? ' <b style="font-weight:600;opacity:.7">' + count + '</b>' : '') + '</button>';
  }

  function renderFeed() {
    var all = itemsAll();
    if (!all.length) {
      elMain.innerHTML = '<div class="m-empty">' + (d() ? '这个筛选下没有内容<br>换个时间、板块或分类看看' : '还没有数据') + '</div>';
      return;
    }
    var html = [];
    html.push(offlineNote());
    if (prefs.range !== 'today') {
      /* 一周内 / 一月内：跨期汇总，按发布日期分组 */
      var ds = all.map(function (it) { return String(it._day || it.published || '').slice(0, 10); })
        .filter(function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(x); }).sort();
      html.push('<div class="m-count">', esc((state.q ? '“' + state.q + '” · ' : '') + all.length +
        ' 条 · ' + rangeLabel() + (ds.length ? '（' + ds[0] + ' ~ ' + ds[ds.length - 1] + '）' : '') +
        (state.rangeBusy ? ' · 正在拉往期…' : '')), '</div>');
      var shown = all.length > state.limit ? all.slice(0, state.limit) : all;
      var groups = [], gi = {};
      shown.forEach(function (it) {
        var k = String(it._day || it.published || '').slice(0, 10) || '日期未知';
        if (!gi[k]) { gi[k] = []; groups.push([k, gi[k]]); }
        gi[k].push(it);
      });
      groups.forEach(function (g) {
        html.push('<div class="m-sec"><i class="m-sec__bar"></i>', esc(dayLabel(g[0])),
          '<small>', g[1].length, ' 条</small></div>');
        g[1].forEach(function (it) { html.push(card(it)); });
      });
      if (all.length > shown.length) {
        html.push('<button class="m-more" id="mMoreBtn">还有 ', all.length - shown.length,
          ' 条，点这里继续看</button>');
      }
      elMain.innerHTML = html.join('');
      return;
    }
    html.push('<div class="m-count">', esc(state.q ? ('“' + state.q + '” · ' + all.length + ' 条') : (all.length + ' 条 · ' + (d().date || ''))), '</div>');

    /* 内网里把小红书单独分一个区（它和行业媒体性质不同） */
    function pushOne(list, title, sub, kind) {
      var xhs = [], rest = [];
      list.forEach(function (it) { (it.platform === 'xiaohongshu' ? xhs : rest).push(it); });
      if (rest.length || !xhs.length) {
        html.push('<div class="m-sec m-sec--', kind, '"><i class="m-sec__bar"></i>', title,
          '<small>', rest.length, ' 条', (sub ? ' · ' + sub : ''), '</small></div>');
        rest.forEach(function (it) { html.push(card(it)); });
      }
      if (xhs.length) {
        html.push('<div class="m-sec m-sec--xhs"><i class="m-sec__bar"></i>小红书 · 平台新品',
          '<small>', xhs.length, ' 条 · 扫码登录后自动采集</small></div>');
        xhs.forEach(function (it) { html.push(card(it)); });
      }
    }

    if (prefs.region === 'all' && prefs.showCn && prefs.showGlobal) {
      [['cn', '内网资讯', '国内来源'], ['global', '外网资讯', '海外来源']].forEach(function (pair) {
        var list = all.filter(function (it) { return (it.region || 'cn') === pair[0]; });
        if (!list.length) return;
        pushOne(list, pair[1], pair[2], pair[0]);
      });
    } else {
      var one = prefs.region === 'global' ? 'global' : (prefs.region === 'cn' ? 'cn' : '');
      var lab = one === 'global' ? '外网资讯' : (one === 'cn' ? '内网资讯' : '全部资讯');
      var src = one === 'global' ? '海外来源' : (one === 'cn' ? '国内来源' : '');
      pushOne(all, lab, src, one || 'all');
    }
    elMain.innerHTML = html.join('');
  }

  function renderBrief() {
    var dig = d();
    if (!dig) { elMain.innerHTML = '<div class="m-empty">还没有数据</div>'; return; }
    var groups = [];
    if (prefs.region === 'all' && prefs.showCn && prefs.showGlobal) {
      groups = [['cn', '内网 · 今日要点'], ['global', '外网 · 今日要点']];
    } else {
      groups = [[prefs.region === 'global' ? 'global' : (prefs.region === 'cn' ? 'cn' : 'all'),
        prefs.region === 'all' ? '今日要点' : regionName(prefs.region) + ' · 今日要点']];
    }
    var html = [];
    groups.forEach(function (g) {
      var region = g[0];
      var sec = dig.sections && dig.sections[region];
      var list = (sec && sec.brief) ? sec.brief : (region === 'all' ? dig.brief : null);
      if (list && prefs.cls !== 'all') {
        list = list.filter(function (b) { return (b.cat || '') === prefs.cls; });
      }
      if (!list || !list.length) return;
      html.push('<div class="m-sec"><i class="m-sec__bar"></i>', esc(g[1]), '<small>', list.length, ' 条</small></div>');
      list.forEach(function (b, i) {
        var c = b.cat ? labelOf({ cat: b.cat }) : null;
        html.push(
          '<div class="m-brief"><div class="m-brief__n">', esc(b.n || (i + 1)), '</div><div class="m-brief__b">',
          '<div class="m-brief__t">', esc(b.title || b.text || b.summary || ''), '</div>',
          '<div class="m-brief__m">',
          c ? '<span class="m-chip m-chip--cat" style="--c:' + esc(c.color) + '">' + esc(c.label) + '</span>' : '',
          b.source ? '<span>' + esc(b.source) + '</span>' : '',
          b.region ? '<span class="m-chip m-chip--' + (b.region === 'global' ? 'global' : 'cn') + '">' + regionName(b.region) + '</span>' : '',
          '</div></div></div>');
      });
    });
    elMain.innerHTML = html.length ? html.join('') : '<div class="m-empty">这一版没有要点</div>';
  }

  function renderChart() {
    var dig = d();
    if (!dig) { elMain.innerHTML = '<div class="m-empty">还没有数据</div>'; return; }
    var cats = (dig.market && dig.market.cats) || [];
    var html = ['<div class="m-sec"><i class="m-sec__bar"></i>品类格局<small>综合占比</small></div>'];
    if (cats.length) {
      var top = cats.slice().sort(function (a, b) { return (b.composite || 0) - (a.composite || 0); });
      html.push('<div class="m-bars">');
      top.forEach(function (c) {
        var v = Math.round((c.composite || 0) * 100);
        var heat = Math.round((c.heat || 0) * 100);
        var stores = Math.round((c.stores_share || 0) * 100);
        html.push(
          '<div class="m-bar" style="--m-c:', esc(c.color || '#fb7299'), '">',
          '<div class="m-bar__h"><b>', esc(c.label), '</b><i>', v, '%</i></div>',
          '<div class="m-bar__track"><div class="m-bar__fill" style="width:', clamp(v, 2, 100), '%"></div></div>',
          '<div class="m-bar__sub">资讯热度 ', heat, '% · 已披露门店 ', stores, '% · ',
          (c.items || 0), ' 条 / ', (c.brands || 0), ' 个品牌</div>',
          '</div>');
      });
      html.push('</div>');
      if (dig.market.formula) {
        html.push('<p class="m-note">口径：', esc(dig.market.formula), '。未识别品类的条目不进图。</p>');
      }
    } else {
      html.push('<div class="m-empty">这一版没有品类数据</div>');
    }
    var kw = dig.keywords || [];
    if (kw.length) {
      html.push('<div class="m-sec"><i class="m-sec__bar"></i>高频关键词<small>', kw.length, ' 个</small></div>');
      html.push('<div class="m-tagbox">');
      kw.slice(0, 26).forEach(function (k) {
        var word = typeof k === 'string' ? k : (k.word || k.label || '');
        var n = typeof k === 'object' ? (k.count || k.n || '') : '';
        html.push('<span class="m-tag">', esc(word), n ? ' <b>' + esc(n) + '</b>' : '', '</span>');
      });
      html.push('</div>');
    }
    elMain.innerHTML = html.join('');
  }

  /* ------------------------------------------------------------ 设置面板 --- */
  function renderDrawer() {
    var A = auth();
    var dig = d();
    var hist = [];
    if (state.index && state.index.history) hist = state.index.history.slice(0, 12);
    var counts = { cn: 0, global: 0 };
    if (dig && dig.items) dig.items.forEach(function (it) { counts[it.region === 'global' ? 'global' : 'cn']++; });

    var h = [];
    h.push('<div class="m-group__t">账号</div><div class="m-group">');
    if (A && A.state && A.state.user) {
      h.push('<div class="m-row"><div class="m-row__l"><b>', esc(A.state.user), '</b><small>已登录 · 设备 ',
        ((A.state.devices || []).length || 1), '/', (A.state.maxDevices || 3), '</small></div></div>');
      h.push('<div class="m-row"><div class="m-row__l"><b>在线设备</b><small>点名可以腾出名额</small></div>',
        '<button class="m-mini" data-act="devices">查看</button></div>');
      if (state.devices) {
        h.push('<div class="m-row" style="display:block"><div class="m-devlist">');
        state.devices.forEach(function (dv) {
          h.push('<div class="m-dev"><div class="m-dev__i"><b>', esc(dv.name || '未知设备'),
            dv.current ? ' <span class="m-chip m-chip--global">本机</span>' : '', '</b><small>',
            esc(dv.last || ''), dv.ip ? ' · ' + esc(dv.ip) : '', '</small></div>',
            dv.current ? '' : '<button class="m-mini" data-act="kick" data-id="' + esc(dv.id) + '">下线</button>',
            '</div>');
        });
        h.push('</div></div>');
      }
      h.push('<div class="m-row"><div class="m-row__l"><b>退出登录</b><small>退出后会释放这台设备的名额</small></div>',
        '<button class="m-mini" data-act="logout">退出</button></div>');
    } else {
      h.push('<div class="m-row"><div class="m-row__l"><b>未登录</b><small>',
        isProtected() ? '这个站点需要先登录' : '当前是静态版，未启用登录',
        '</small></div></div>');
    }
    h.push('</div>');

    if (isApp()) {
      var rem = remoteUrl();
      h.push('<div class="m-group__t">App</div><div class="m-group">');
      h.push('<div class="m-row"><div class="m-row__l"><b>在线版</b><small>',
        rem ? esc(rem) : '现在用的是 App 内置离线日报（不会自动更新）', '</small></div>',
        '<button class="m-mini" data-act="remote">', rem ? '修改' : '切到在线版', '</button></div>');
      if (rem) {
        h.push('<div class="m-row"><div class="m-row__l"><b>回到离线版</b><small>改用 App 内置数据</small></div>',
          '<button class="m-mini" data-act="remote-off">切换</button></div>');
      }
      h.push('<div class="m-row"><div class="m-row__l"><small>在线版需要登录，但每次打开都是最新一期</small></div></div>');
      h.push('</div>');
    }

    h.push('<div class="m-group__t">其它</div><div class="m-group">');
    h.push('<div class="m-row"><div class="m-row__l"><b>应急口令通道</b><small>',
      '连不上服务器时，用口令本地解密看最新一期</small></div>',
      '<button class="m-mini" data-act="emergency">打开</button></div>');
    h.push('</div>');

    h.push('<div class="m-group__t">时间</div><div class="m-group"><div class="m-chips">');
    RANGES.forEach(function (r) {
      h.push('<button class="m-pill' + (prefs.range === r[0] ? ' is-on' : '') +
        '" data-act="range" data-value="', r[0], '">', r[1], '</button>');
    });
    h.push('</div></div>');

    h.push('<div class="m-group__t">内容板块</div><div class="m-group">');
    h.push('<div class="m-row"><div class="m-row__l"><b>内网资讯</b><small>国内来源 · ', counts.cn, ' 条</small></div>',
      '<button class="m-switch', prefs.showCn ? ' is-on' : '', '" data-act="showCn" aria-label="内网开关"></button></div>');
    h.push('<div class="m-row"><div class="m-row__l"><b>外网资讯</b><small>国外来源 · ', counts.global, ' 条</small></div>',
      '<button class="m-switch', prefs.showGlobal ? ' is-on' : '', '" data-act="showGlobal" aria-label="外网开关"></button></div>');
    h.push('<div class="m-chips" style="padding-bottom:12px">');
    if (prefs.showCn && prefs.showGlobal) h.push('<button class="m-pill' + (prefs.region === 'all' ? ' is-on' : '') + '" data-act="region" data-value="all">全部</button>');
    if (prefs.showCn) h.push('<button class="m-pill' + (prefs.region === 'cn' ? ' is-on' : '') + '" data-act="region" data-value="cn">只看内网</button>');
    if (prefs.showGlobal) h.push('<button class="m-pill' + (prefs.region === 'global' ? ' is-on' : '') + '" data-act="region" data-value="global">只看外网</button>');
    h.push('<div class="m-row"><div class="m-row__l"><small>和首页顶部那排胶囊是同一个设置</small></div></div>');
    h.push('</div></div>');

    h.push('<div class="m-group__t">分类</div><div class="m-group"><div class="m-chips">');
    h.push('<button class="m-pill' + (prefs.cls === 'all' ? ' is-on' : '') + '" data-act="cls" data-value="all">全部分类</button>');
    CLASSES.forEach(function (k) {
      var lb = labelOf({ cat: k });
      h.push('<button class="m-pill' + (prefs.cls === k ? ' is-on' : '') + '" data-act="cls" data-value="',
        k, '" style="--c:', esc(lb.color), '">', esc(lb.label), '</button>');
    });
    h.push('</div></div>');

    var cats = (dig && dig.market && dig.market.cats) || [];
    if (cats.length) {
      h.push('<div class="m-group__t">品类</div><div class="m-group"><div class="m-chips">');
      h.push('<button class="m-pill' + (prefs.cat === 'all' ? ' is-on' : '') + '" data-act="cat" data-value="all">全部</button>');
      cats.forEach(function (c) {
        h.push('<button class="m-pill' + (prefs.cat === c.id ? ' is-on' : '') + '" data-act="cat" data-value="',
          esc(c.id), '">', esc(c.label), '</button>');
      });
      h.push('</div></div>');
    }

    h.push('<div class="m-group__t">语言</div><div class="m-group"><div class="m-chips">');
    h.push('<button class="m-pill' + (prefs.lang === 'orig' ? ' is-on' : '') + '" data-act="lang" data-value="orig">原文</button>');
    h.push('<button class="m-pill' + (prefs.lang === 'zh' ? ' is-on' : '') + '" data-act="lang" data-value="zh">中文译文</button>');
    h.push('</div></div>');

    h.push('<div class="m-group__t">显示</div><div class="m-group">');
    h.push('<div class="m-row"><div class="m-row__l"><b>主题</b><small>与电脑版共用同一个偏好</small></div></div>');
    h.push('<div class="m-chips" style="padding-top:0">');
    [['', '跟随系统'], ['day', '白班'], ['night', '夜班']].forEach(function (p) {
      h.push('<button class="m-pill' + ((prefs.shift || '') === p[0] ? ' is-on' : '') + '" data-act="shift" data-value="',
        p[0], '">', p[1], '</button>');
    });
    h.push('</div>');
    h.push('<div class="m-row"><div class="m-row__l"><b>大字号</b><small>标题和正文都放大一点</small></div>',
      '<button class="m-switch', prefs.big ? ' is-on' : '', '" data-act="big"></button></div>');
    h.push('</div>');

    if (hist.length) {
      h.push('<div class="m-group__t">往期</div><div class="m-group">');
      hist.forEach(function (hb) {
        var on = dig && hb.date === dig.date;
        h.push('<div class="m-date', on ? ' is-on' : '', '" data-act="date" data-value="', esc(hb.date), '">',
          on ? '● ' : '○ ', esc(hb.date), '<span>', (hb.total || hb.count || ''), ' 条</span></div>');
      });
      h.push('</div>');
    }

    h.push('<div class="m-group__t">关于</div><div class="m-group">');
    h.push('<div class="m-row"><div class="m-row__l"><b>数据</b><small>',
      esc(dig ? (dig.date + ' · 第 ' + (dig.issue || '-') + ' 期 · ' + (dig.total || (dig.items || []).length) + ' 条') : '还没有数据'),
      '</small></div></div>');
    h.push('<div class="m-row"><div class="m-row__l"><b>生成时间</b><small>', esc((dig && dig.generated_at) || '—'), '</small></div></div>');
    h.push('<div class="m-row"><div class="m-row__l"><b>数据来源</b><small>',
      isProtected() ? '登录后由服务端下发' : (state.digest ? '静态文件 data/' : '—'),
      ' · ', VERSION, '</small></div></div>');
    h.push('</div>');

    elDrawerBody.innerHTML = h.join('');
  }

  /* -------------------------------------------------- 刷新最新一期（实时） --- */
  function isApp() {
    return !!(window.AppBridge && window.AppBridge.isApp && window.AppBridge.isApp());
  }
  function remoteUrl() {
    try {
      return (window.AppBridge && window.AppBridge.getRemote
        && window.AppBridge.getRemote()) || '';
    } catch (e) { return ''; }
  }
  /** App 内置离线版：没网、也没登录，刷不出新内容 */
  function offlineApp() { return isApp() && !remoteUrl() && !isProtected(); }

  var busyRefresh = false;
  async function refresh(silent) {
    if (busyRefresh) return;
    if (offlineApp()) {
      if (!silent) toast('现在用的是 App 内置离线日报，去设置里切「在线版」才能查看新一期');
      return;
    }
    busyRefresh = true;
    if (elRefreshBtn) elRefreshBtn.classList.add('is-busy');
    var before = d() ? d().date : '';
    try {
      var r = await Promise.race([pull(''), new Promise(function (_, rej) {
        setTimeout(function () { rej(new Error('超时')); }, 25000);
      })]);
      if (!r || !r.digest) throw new Error('没拿到数据');
      applyResult(r);
      renderAll();
      var dig = r.digest;
      var n = dig.total || (dig.items || []).length;
      if (r.cached) {
        toast('连不上服务器，正在看离线副本（' + (cacheTimeText() || '上次成功更新') + '）');
      } else if (dig.date !== before) {
        toast('已更新到 ' + dig.date + '（第 ' + (dig.issue || '-') + ' 期）· ' + n + ' 条');
      } else if (!silent) {
        toast('已是最新：' + dig.date + ' · 第 ' + (dig.issue || '-') + ' 期 · ' + n + ' 条');
      }
    } catch (e) {
      if (!silent) toast('刷新失败：' + (e.message || e));
    } finally {
      busyRefresh = false;
      if (elRefreshBtn) elRefreshBtn.classList.remove('is-busy');
    }
  }
  if (elRefreshBtn) elRefreshBtn.addEventListener('click', function () { refresh(false); });

  /* 页面在前台时每 5 分钟静默刷一次，有新一期会自动换上 */
  setInterval(function () {
    if (document.hidden) return;
    refresh(true);
  }, 5 * 60 * 1000);

  function renderNav() {
    var btns = elNav.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-tab') === state.tab;
      btns[i].className = on ? 'is-on' : '';
    }
  }

  function renderMeta() {
    var dig = d();
    if (!dig) { elMeta.textContent = state.loading ? '加载中…' : '暂无数据'; return; }
    if (state.offline) {
      elMeta.textContent = (state.emergency ? '应急解锁 · ' : '离线副本 · ') + (dig.date || '');
      return;
    }
    if (prefs.range !== 'today') {
      elMeta.textContent = rangeLabel() + ' · ' + itemsAll().length + ' 条';
      return;
    }
    elMeta.textContent = [dig.date, dig.issue ? ('第 ' + dig.issue + ' 期') : '', (dig.total || (dig.items || []).length) + ' 条']
      .filter(Boolean).join(' · ');
  }

  function renderMain() {
    state.tab = state.tab || 'feed';
    if (state.tab === 'feed') renderFeed();
    else if (state.tab === 'brief') renderBrief();
    else renderChart();
  }

  function renderAll() {
    renderMeta();
    renderTabs();
    renderMain();
    renderNav();
    if (elDrawer.classList.contains('is-open')) renderDrawer();
  }

  /* -------------------------------------------------------------- 交互 --- */
  function openDrawer() {
    renderDrawer();
    elDrawer.classList.add('is-open');
    elDrawer.setAttribute('aria-hidden', 'false');
    try { localStorage.setItem(PKEY + '-seen', '1'); } catch (e) {}
  }
  function closeDrawer() {
    elDrawer.classList.remove('is-open');
    elDrawer.setAttribute('aria-hidden', 'true');
  }
  window.CanyinMobile.openSettings = openDrawer;
  window.CanyinMobile.closeSettings = closeDrawer;
  window.CanyinMobile.emergencyUnlock = emergencyUnlock;   // 应急口令通道（也方便自测）

  elTabs.addEventListener('click', async function (e) {
    var b = e.target.closest('.m-pill');
    if (!b) return;
    var kind = b.getAttribute('data-kind'), val = b.getAttribute('data-value');
    var needRange = false;
    if (kind === 'region') prefs.region = val;
    if (kind === 'cls') prefs.cls = val;
    if (kind === 'range' && prefs.range !== val) { prefs.range = val; state.limit = 200; needRange = true; }
    if (kind === 'cat') { prefs.cat = val; }
    if (kind === 'range' && val !== 'today') state.tab = 'feed';
    savePrefs();
    if (needRange) await loadRangeWithHint();
    renderAll();
    window.scrollTo(0, 0);
    elMain.scrollTop = 0;
  });

  /* 时间分类里「还有 N 条」的分页按钮 / 应急口令按钮 */
  elMain.addEventListener('click', function (e) {
    if (e.target.closest('[data-act="emergency"]')) { emergencyUnlock(); return; }
    if (!e.target.closest('#mMoreBtn')) return;
    state.limit += 200;
    renderFeed();
  });

  elNav.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (!b) return;
    var tab = b.getAttribute('data-tab');
    if (tab === 'me') { openDrawer(); return; }
    state.tab = tab;
    renderMain();
    renderNav();
    elMain.scrollTop = 0;
  });

  $('#mSearchBtn').addEventListener('click', function () {
    var open = elSearchBar.hidden;
    elSearchBar.hidden = !open;
    this.classList.toggle('is-on', open);
    if (open) $('#mQ').focus(); else { state.q = ''; $('#mQ').value = ''; renderAll(); }
  });
  $('#mQ').addEventListener('input', function () {
    state.q = this.value;
    renderMain();
  });
  $('#mQClear').addEventListener('click', function () {
    state.q = ''; $('#mQ').value = '';
    elSearchBar.hidden = true;
    $('#mSearchBtn').classList.remove('is-on');
    renderAll();
  });
  $('#mSetBtn').addEventListener('click', openDrawer);
  $('#mMask').addEventListener('click', closeDrawer);
  $('#mBack').addEventListener('click', closeDrawer);

  // 顶栏：白天 / 夜班一键切换（当前是跟随系统时，点一下变成明确选择）
  elShiftBtn.addEventListener('click', function () {
    var next = effectiveShift() === 'night' ? 'day' : 'night';
    setShiftPref(next);
    if (elDrawer.classList.contains('is-open')) renderDrawer();
    toast(next === 'night' ? '夜班模式' : '白天模式');
  });

  elDrawerBody.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act'), val = t.getAttribute('data-value');
    var A = auth();

    if (act === 'remote') {
      var cur = remoteUrl();
      var v = prompt('在线版地址（留空 = 用 App 内置离线日报）',
        cur || 'https://nfalyhl.github.io/canyin-daily/');
      if (v === null) return;
      try {
        window.AppBridge.setRemote(v.trim());
        window.AppBridge.reload();
      } catch (e) { toast('设置失败：' + e.message); }
      return;
    }
    if (act === 'remote-off') {
      try {
        window.AppBridge.setRemote('');
        window.AppBridge.reload();
      } catch (e) { toast('设置失败：' + e.message); }
      return;
    }
    if (act === 'showCn' || act === 'showGlobal') {
      var next = !prefs[act];
      if (!next && ((act === 'showCn' && !prefs.showGlobal) || (act === 'showGlobal' && !prefs.showCn))) {
        toast('至少要留一个板块');
        return;
      }
      prefs[act] = next;
      if (!prefs.showCn && prefs.region === 'cn') prefs.region = 'global';
      if (!prefs.showGlobal && prefs.region === 'global') prefs.region = 'cn';
      savePrefs(); renderAll(); return;
    }
    if (act === 'region') {
      prefs.region = val;
      if (val !== 'all') state.tab = 'feed';
      savePrefs(); renderAll(); closeDrawer(); return;
    }
    if (act === 'emergency') { closeDrawer(); emergencyUnlock(); return; }
    if (act === 'range') {
      if (prefs.range !== val) { prefs.range = val; state.limit = 200; }
      if (val !== 'today') state.tab = 'feed';
      savePrefs();
      await loadRangeWithHint();
      renderAll(); closeDrawer(); return;
    }
    if (act === 'cls') { prefs.cls = val; savePrefs(); renderAll(); return; }
    if (act === 'cat') { prefs.cat = val; savePrefs(); renderAll(); return; }
    if (act === 'lang') { prefs.lang = val; savePrefs(); renderAll(); toast(val === 'zh' ? '已切换到中文译文' : '已切换到原文'); return; }
    if (act === 'shift') { setShiftPref(val); renderDrawer(); toast(val === 'night' ? '夜班模式' : (val === 'day' ? '白班模式' : '跟随系统')); return; }
    if (act === 'big') {
      prefs.big = !prefs.big; savePrefs();
      root.classList.toggle('is-big', prefs.big);
      renderDrawer(); return;
    }
    if (act === 'date') {
      toast('正在打开 ' + val + ' …');
      try {
        if (state.atlas[val]) { state.digest = state.atlas[val]; }
        else { applyResult(await pull(val)); }
        prefs._date = val;
        state.tab = 'feed';
        renderAll(); closeDrawer(); elMain.scrollTop = 0;
      } catch (err) {
        toast('这一期打不开：' + (err.message || err));
      }
      return;
    }
    if (act === 'devices') {
      if (!A || !A.api) { toast('没有登录服务'); return; }
      try {
        var r = await A.api('/api/devices', { token: A.token() });
        state.devices = r.devices || A.state.devices || [];
      } catch (err) {
        state.devices = (A.state && A.state.devices) || [];
        toast('取设备列表失败，显示的是缓存');
      }
      renderDrawer(); return;
    }
    if (act === 'kick') {
      var id = t.getAttribute('data-id');
      if (!confirm('把这台设备下线？它需要重新登录才能看。')) return;
      try {
        var rr = await A.api('/api/devices/kick', { token: A.token(), deviceId: id });
        state.devices = rr.devices || [];
        toast('已下线一台，名额已释放');
      } catch (err) { toast('下线失败：' + (err.message || err)); }
      renderDrawer(); return;
    }
    if (act === 'logout') {
      if (!confirm('退出登录？本机需要重新登录才能看。')) return;
      try { await A.api('/api/logout', { token: A.token() }); } catch (e) {}
      location.reload();
    }
  });

  /* 首次访问给一句提示（不再有左滑手势） */
  try {
    if (!localStorage.getItem(PKEY + '-seen')) {
      setTimeout(function () { toast('右上齿轮 / 底部「我的」进设置'); }, 900);
    }
  } catch (e) {}

  /* PWA：注册 Service Worker（和桌面版共用同一份） */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  /* -------------------------------------------------------------- 启动 --- */
  (async function boot() {
    elMain.innerHTML = '<div class="m-skel"></div><div class="m-skel"></div><div class="m-skel"></div><div class="m-skel"></div>';
    applyShift();
    try {
      var r = await pull('');
      applyResult(r);
    } catch (err) {
      /* 连不上服务：先把状态标成离线，这样页面会给出「应急口令 / 离线副本」的入口 */
      state.offline = true;
      if (isProtected()) {
        try { await waitAuth(); var r2 = await pull(''); applyResult(r2); } catch (e2) { /* 下面统一提示 */ }
      }
    }
    state.loading = false;
    if (!state.digest) {
      renderMeta();
      elMain.innerHTML = offlineNote() + '<div class="m-empty">还没有拿到数据<br><br>' +
        (state.offline
          ? ((window.crypto && window.crypto.subtle)
              ? '连不上服务器。可以点上面的「输入应急口令」看最新一期'
              : '检查网络，或稍后重试')
          : (isProtected() ? '登录后由服务端下发，登录成功会自动刷新' : '检查网络，或稍后重试')) + '</div>';
      renderTabs();
      return;
    }
    renderAll();
    /* 上次停在「一周内 / 一月内」时，启动补齐往期 */
    if (prefs.range !== 'today') {
      loadRangeWithHint().then(function () { renderAll(); });
    }
  })();
})();
