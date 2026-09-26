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

  var VERSION = 'v0.6 手机版';
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
  };

  /* 三大分类：数据里的 it.cat，顺序与 daily.py 的 CAT_ORDER 一致 */
  var CLASSES = ['product', 'trend', 'brand'];
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
    var d = { region: 'all', cls: 'all', cat: 'all', lang: 'orig', showCn: true, showGlobal: true, big: false, shift: '' };
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
  var state = { digest: null, index: null, atlas: {}, tab: 'feed', q: '', devices: null, loading: true };

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
    try { return JSON.parse($('#boot-data').textContent); } catch (e) { return null; }
  }
  async function pull(date) {
    if (isProtected()) {
      var A = auth();
      await waitAuth();
      return await A.api('/api/digest', { token: A.token(), date: date || '' }, 45000);
    }
    if (date) {
      var r = await fetch('data/digest-' + date + '.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { digest: await r.json() };
    }
    var ri = await fetch('data/index.json', { cache: 'no-store' });
    if (!ri.ok) throw new Error('HTTP ' + ri.status);
    var idx = await ri.json();
    var latest = (idx.history && idx.history[0] && idx.history[0].date) || idx.latest || '';
    if (!latest) return { index: idx };
    var rd = await fetch('data/digest-' + latest + '.json', { cache: 'no-store' });
    return { digest: await rd.json(), index: idx };
  }
  function applyResult(r) {
    if (r && r.index) state.index = r.index;
    if (r && r.digest && r.digest.items) {
      state.digest = r.digest;
      state.atlas[r.digest.date] = r.digest;
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
  function countMatching(f) {
    var dig = d(), n = 0;
    if (!dig || !dig.items) return 0;
    dig.items.forEach(function (it) { if (itemPass(it, f)) n++; });
    return n;
  }
  function itemsAll() {
    var dig = d();
    if (!dig || !dig.items) return [];
    var q = state.q.trim().toLowerCase();
    return dig.items.filter(function (it) {
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
    elToast = $('#mToast'), elSearchBar = $('#mSearchBar'), elShiftBtn = $('#mShiftBtn');

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
    var on = (kind === 'region' ? prefs.region : (kind === 'cls' ? prefs.cls : prefs.cat)) === value;
    return '<button class="m-pill' + (on ? ' is-on' : '') + '" data-kind="' + kind + '" data-value="' + esc(value) +
      '"' + (color ? ' style="--c:' + esc(color) + '"' : '') + '>' + esc(label) +
      (count ? ' <b style="font-weight:600;opacity:.7">' + count + '</b>' : '') + '</button>';
  }

  function renderFeed() {
    var all = itemsAll();
    if (!all.length) {
      elMain.innerHTML = '<div class="m-empty">' + (d() ? '这个筛选下没有内容<br>换个板块、分类或品类看看' : '还没有数据') + '</div>';
      return;
    }
    var html = ['<div class="m-count">', esc(state.q ? ('“' + state.q + '” · ' + all.length + ' 条') : (all.length + ' 条 · ' + (d().date || ''))), '</div>'];
    if (prefs.region === 'all' && prefs.showCn && prefs.showGlobal) {
      [['cn', '内网资讯', '国内来源'], ['global', '外网资讯', '海外来源']].forEach(function (pair) {
        var list = all.filter(function (it) { return (it.region || 'cn') === pair[0]; });
        if (!list.length) return;
        html.push('<div class="m-sec m-sec--', pair[0], '"><i class="m-sec__bar"></i>', pair[1],
          '<small>', list.length, ' 条 · ', pair[2], '</small></div>');
        list.forEach(function (it) { html.push(card(it)); });
      });
    } else {
      var one = prefs.region === 'global' ? 'global' : (prefs.region === 'cn' ? 'cn' : '');
      var lab = one === 'global' ? '外网资讯' : (one === 'cn' ? '内网资讯' : '全部资讯');
      var src = one === 'global' ? '海外来源' : (one === 'cn' ? '国内来源' : '');
      html.push('<div class="m-sec m-sec--', (one || 'all'), '"><i class="m-sec__bar"></i>', lab,
        '<small>', all.length, ' 条', (src ? ' · ' + src : ''), '</small></div>');
      all.forEach(function (it) { html.push(card(it)); });
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

  elTabs.addEventListener('click', function (e) {
    var b = e.target.closest('.m-pill');
    if (!b) return;
    var kind = b.getAttribute('data-kind'), val = b.getAttribute('data-value');
    if (kind === 'region') prefs.region = val;
    if (kind === 'cls') prefs.cls = val;
    if (kind === 'cat') { prefs.cat = val; }
    savePrefs();
    renderAll();
    window.scrollTo(0, 0);
    elMain.scrollTop = 0;
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
      if (isProtected()) {
        try { await waitAuth(); var r2 = await pull(''); applyResult(r2); } catch (e2) { /* 下面统一提示 */ }
      }
    }
    state.loading = false;
    if (!state.digest) {
      renderMeta();
      elMain.innerHTML = '<div class="m-empty">还没有拿到数据<br><br>' +
        (isProtected() ? '登录后由服务端下发，登录成功会自动刷新' : '检查网络，或稍后重试') + '</div>';
      renderTabs();
      return;
    }
    renderAll();
  })();
})();
