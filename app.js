/* ==========================================================================
   餐饮日报 · 电脑端（内网 / 外网 双板块 + 登录 + 外网节点设置）
   数据：内联的 boot-data（离线可用）；在服务器上运行时再向 /api 与 data/ 取最新。
   ========================================================================== */
(function () {
  'use strict';

  var SECTIONS = [
    { id: 'cn', label: '内网', note: '国内信息源', color: 'var(--c-cn)' },
    { id: 'global', label: '外网', note: '海外信息源', color: 'var(--c-global)' }
  ];
  var CATS = [
    { id: 'product', label: '产品上新', color: 'var(--c-product)' },
    { id: 'trend', label: '行业趋势', color: 'var(--c-trend)' },
    { id: 'brand', label: '品牌动作', color: 'var(--c-brand)' }
  ];
  var CAT = {};
  CATS.forEach(function (c) { CAT[c.id] = c; });

  var SHIFT_KEY = 'canyin-shift';
  var LANG_KEY = 'canyin-lang';
  var WEEK = '日一二三四五六';
  var ON_SERVER = location.protocol === 'http:' || location.protocol === 'https:';
  // HAS_API：服务端有没有 /api（静态托管、file:// 都没有）—— 启动时探测一次
  var HAS_API = false;
  // PROTECTED：彻底版模式——正文不内联，登录后由鉴权服务下发
  var PROTECTED = false;
  var IS_APP = !!(window.AppBridge && window.AppBridge.isApp && window.AppBridge.isApp());
  var DEFAULT_SECTION = 'cn';

  var state = {
    digest: null,
    archive: {},
    history: [],
    section: DEFAULT_SECTION,
    cat: 'all',
    bcat: 'all',
    user: '',
    nodeLogTimer: null,
    // 翻译
    lang: 'orig',
    trMap: {},
    trPending: 0,
    trTotal: 0,
    trScope: 'all',
    trTimer: null,
    trLangs: [{ id: 'zh', label: '中文' }, { id: 'zh-TW', label: '繁體' },
              { id: 'en', label: 'English' }, { id: 'ja', label: '日本語' },
              { id: 'ko', label: '한국어' }]
  };

  /** 空日报（等登录 / 等待服务端下发时的占位） */
  function emptyDigest() {
    return { date: '', generated_at: '', issue: 1, total: 0, counts: {},
      region_counts: {}, keywords: [], brief: [], items: [], sections: {},
      market: { cats: [] } };
  }

  /** 等登录门禁通过（彻底版必须先登录才能拿数据） */
  function waitLogin() {
    var A = window.CanyinAuth;
    return new Promise(function (resolve) {
      if (!A) return resolve(null);
      if (A.state && A.state.user) return resolve(A.state);
      A.onChange(function (st) { if (st && st.user) resolve(st); });
    });
  }

  /** 向鉴权服务要日报（date 留空 = 最新一期）
      单期正文压缩后约 25 KB，国内链路慢的时候给 45 秒 */
  function authDigest(date) {
    var A = window.CanyinAuth;
    if (!A || !A.api) return Promise.reject(new Error('鉴权服务不可用'));
    return A.api('/api/digest', { token: A.token(), date: date || '' }, 45000);
  }

  /** 取译文（没译到就回原文） */
  function T(text) {
    if (!text || state.lang === 'orig') return text;
    var got = state.trMap[text];
    return got && String(got).trim() ? got : text;
  }

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function catOf(id) { return CAT[id] || { label: id || '动态', color: 'var(--ink-3)' }; }
  function pct(v) { return (v * 100).toFixed(1) + '%'; }

  function sectionMeta(id) {
    var found = SECTIONS.filter(function (s) { return s.id === id; })[0];
    return found || { id: id, label: id, note: '', color: 'var(--ink-3)' };
  }

  /** 当前板块的数据（内网/外网各一套） */
  function sec() {
    var d = state.digest || {};
    var sections = d.sections || {};
    return sections[state.section] || sections.all || {
      total: d.total || 0, counts: d.counts || {}, keywords: d.keywords || [],
      brief: d.brief || [], market: d.market || { cats: [] }, headline: d.headline || ''
    };
  }
  function secItems() {
    return ((state.digest || {}).items || []).filter(function (it) {
      return (it.region || 'cn') === state.section;
    });
  }

  async function api(method, path, payload) {
    var opt = { method: method, cache: 'no-store', headers: {} };
    if (payload !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(payload);
    }
    var r = await fetch(path, opt);
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  /* ------------------------------------------------------------ 班次主题 --- */
  function setShift(mode, persist) {
    document.documentElement.dataset.shift = mode;
    var btn = $('#shiftBtn');
    if (btn) btn.textContent = mode === 'night' ? '白班' : '夜班';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'night' ? '#0d1013' : '#eef0ee');
    if (IS_APP && window.AppBridge.setStatusBarColor) {
      try { window.AppBridge.setStatusBarColor(mode === 'night' ? '#0d1013' : '#eef0ee'); } catch (e) {}
    }
    if (persist) { try { localStorage.setItem(SHIFT_KEY, mode); } catch (e) {} }
    syncTopH();
  }

  function initShift() {
    var forced = new URLSearchParams(location.search).get('shift');
    if (forced === 'day' || forced === 'night') {
      setShift(forced, false);
    } else {
      var saved = null;
      try { saved = localStorage.getItem(SHIFT_KEY); } catch (e) {}
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      setShift(saved || (mq.matches ? 'night' : 'day'), false);
      mq.addEventListener('change', function (e) {
        var cur = null;
        try { cur = localStorage.getItem(SHIFT_KEY); } catch (err) {}
        if (!cur) setShift(e.matches ? 'night' : 'day', false);
      });
    }
    $('#shiftBtn').addEventListener('click', function () {
      setShift(document.documentElement.dataset.shift === 'night' ? 'day' : 'night', true);
    });
  }

  function syncTopH() {
    var h = document.querySelector('.topbar').offsetHeight;
    document.documentElement.style.setProperty('--top-h', h + 'px');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var p = iso.split('-');
    var d = new Date(iso + 'T00:00:00');
    return p[0] + '.' + p[1] + '.' + p[2] + ' 周' + WEEK[d.getDay()];
  }
  function itemTime(it) {
    if (!it.published) return '';
    if (it.published.slice(0, 10) === state.digest.date) return it.published.slice(11, 16);
    return it.published.slice(5, 10);
  }

  /* ------------------------------------------------- 外网译文与语言选择 --- */
  function globalItems() {
    return ((state.digest || {}).items || []).filter(function (it) {
      return (it.region || 'cn') === 'global';
    });
  }

  function trTexts() {
    var g = ((state.digest || {}).sections || {}).global || {};
    var arr = [];
    (g.brief || []).forEach(function (b) { if (b.text) arr.push(b.text); });
    globalItems().forEach(function (it) {
      if (it.title) arr.push(it.title);
      if (state.trScope !== 'title' && it.summary) arr.push(it.summary);
    });
    var seen = {}, out = [];
    arr.forEach(function (t) { if (t && !seen[t]) { seen[t] = 1; out.push(t); } });
    return out.slice(0, 400);
  }

  function renderLangBar() {
    var bar = $('#langBar');
    if (!bar) return;
    bar.hidden = state.section !== 'global';
    if (bar.hidden) return;

    var chips = [{ id: 'orig', label: '原文' }].concat(state.trLangs);
    $('#langChips').innerHTML = chips.map(function (l) {
      return '<button type="button" class="lang-chip' + (state.lang === l.id ? ' on' : '') +
        '" data-lang="' + esc(l.id) + '">' + esc(l.label) + '</button>';
    }).join('');
    $('#langChips').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.dataset.lang); });
    });

    var go = $('#langGo');
    if (state.lang === 'orig') {
      go.hidden = true;
      $('#langStatus').textContent = '选一种语言看译文；译文会缓存，之后秒开';
      return;
    }
    if (!HAS_API) {
      go.hidden = true;
      $('#langStatus').textContent = state.trPending > 0
        ? '静态版：数据里自带 ' + (state.trTotal - state.trPending) + '/' + state.trTotal +
          ' 条译文，其余要在本机跑 server.py 才能翻'
        : '已用数据内自带的译文（' + state.trTotal + ' 条）';
      return;
    }
    go.hidden = false;
    go.disabled = false;
    if (state.trPending > 0) {
      go.dataset.force = '0';
      go.textContent = '翻译本期（还缺 ' + state.trPending + ' 条）';
    } else {
      go.dataset.force = '1';
      go.textContent = '换服务重译';
    }
    $('#langStatus').textContent = state.trPending > 0
      ? '已有缓存 ' + (state.trTotal - state.trPending) + '/' + state.trTotal + ' 条'
      : '已全部有译文（' + state.trTotal + ' 条，来自缓存）；换了翻译服务可点右边重译';
  }

  function seedTranslations() {
    var out = {};
    if (state.lang === 'orig') return out;
    var g = ((state.digest || {}).sections || {}).global || {};
    var briefs = g.brief || [];
    var trBrief = (g.tr || {})[state.lang];
    if (trBrief && trBrief.length === briefs.length) {
      briefs.forEach(function (b, i) { if (trBrief[i]) out[b.text] = trBrief[i]; });
    }
    globalItems().forEach(function (it) {
      var rec = (it.tr || {})[state.lang];
      if (!rec) return;
      if (rec.t) out[it.title] = rec.t;
      if (rec.s && it.summary) out[it.summary] = rec.s;
    });
    return out;
  }

  async function loadTranslations() {
    state.trMap = seedTranslations();
    state.trPending = 0;
    if (state.lang === 'orig') { state.trTotal = 0; return; }
    var texts = trTexts();
    state.trTotal = texts.length;
    if (!HAS_API) {
      state.trPending = texts.filter(function (t) { return !state.trMap[t]; }).length;
      return;
    }
    try {
      var r = await api('POST', '/api/translate/lookup',
                        { texts: texts, lang: state.lang });
      var remote = r.map || {};
      Object.keys(remote).forEach(function (k) {
        if (remote[k]) state.trMap[k] = remote[k];
      });
      state.trPending = r.pending || 0;
    } catch (e) {
      var st = $('#langStatus');
      if (st) st.textContent = '读取译文失败：' + e.message;
    }
  }

  async function setLang(id) {
    state.lang = id;
    try { localStorage.setItem(LANG_KEY, id); } catch (e) {}
    await loadTranslations();
    renderAll();
  }

  async function startTranslate() {
    if (state.lang === 'orig' || !ON_SERVER) return;
    var texts = trTexts();
    if (!texts.length) return;
    var go = $('#langGo');
    var force = go.dataset.force === '1';
    if (force && !confirm('会用当前翻译服务重新翻一遍这 ' + texts.length +
        ' 条（覆盖现有译文），确定吗？')) return;
    go.disabled = true;
    go.textContent = force ? '正在重译…' : '正在翻译…';
    try {
      await api('POST', '/api/translate/start',
                { texts: texts, lang: state.lang, force: force });
      $('#langStatus').textContent = (force ? '重译中 0/' : '翻译中 0/') +
        texts.length + '…';
      if (state.trTimer) clearInterval(state.trTimer);
      state.trTimer = setInterval(pollTranslate, 2000);
    } catch (e) {
      $('#langStatus').textContent = '无法开始翻译：' + e.message;
      go.disabled = false;
      renderLangBar();
    }
  }

  async function pollTranslate() {
    try {
      var s = await api('GET', '/api/translate/status');
      if (s.running) {
        $('#langStatus').textContent = '翻译中 ' + s.done + '/' + s.total + '…';
        return;
      }
      if (state.trTimer) clearInterval(state.trTimer);
      state.trTimer = null;
      await loadTranslations();
      renderAll();
      if (s.log && s.log.length) {
        var st = $('#langStatus');
        if (st) st.textContent = s.log[s.log.length - 1];
      }
    } catch (e) { /* 忽略抖动 */ }
  }

  /* ------------------------------------------------- 翻译服务设置 --- */
  function trLog(lines) {
    var box = $('#trLog');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = (lines || []).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
  }

  function initTranslateSettings() {
    $('#langGo').addEventListener('click', startTranslate);
    if (!HAS_API) return;

    var box = $('#trLlmBox');
    function setProviderUI(p) { box.hidden = (p !== 'llm'); }

    function load() {
      api('GET', '/api/settings').then(function (s) {
        state.trScope = s.scope || 'all';
        document.querySelectorAll('input[name=provider]').forEach(function (r) {
          r.checked = (r.value === (s.provider || 'mymemory'));
        });
        document.querySelectorAll('input[name=scope]').forEach(function (r) {
          r.checked = (r.value === state.trScope);
        });
        setProviderUI(s.provider || 'mymemory');
        $('#trBase').value = s.base_url || '';
        $('#trModel').value = s.model || '';
        $('#trKey').value = '';
        $('#trKey').placeholder = s.has_key
          ? ('已保存 ' + (s.key_hint || '') + '（留空 = 不修改）') : 'API Key';
        $('#trState').textContent = (s.provider === 'llm')
          ? (s.has_key ? '大模型' : '缺 Key') : '免费接口';
      }).catch(function () {});
    }
    load();

    document.querySelectorAll('input[name=provider]').forEach(function (r) {
      r.addEventListener('change', function () { setProviderUI(r.value); });
    });

    $('#trSave').addEventListener('click', async function () {
      var p = document.querySelector('input[name=provider]:checked');
      var sc = document.querySelector('input[name=scope]:checked');
      try {
        var r = await api('POST', '/api/settings', {
          provider: p ? p.value : 'mymemory',
          scope: sc ? sc.value : 'all',
          base_url: $('#trBase').value.trim(),
          model: $('#trModel').value.trim(),
          api_key: $('#trKey').value.trim()
        });
        state.trScope = r.scope || 'all';
        $('#trState').textContent = (r.provider === 'llm')
          ? (r.has_key ? '大模型' : '缺 Key') : '免费接口';
        $('#trKey').value = '';
        trLog(['已保存：' + (r.provider === 'llm' ? '大模型' : '免费接口') + '，范围：' +
               (r.scope === 'all' ? '标题 + 要点' : '仅标题')]
          .concat(r.provider === 'llm' && !r.has_key
            ? ['⚠ 还没填 Key，翻译会继续走免费接口；填上再保存即可生效'] : []));
        load();
        await loadTranslations();
        renderAll();
      } catch (e) {
        trLog(['保存失败：' + e.message]);
      }
    });

    $('#trClearKey').addEventListener('click', async function () {
      if (!confirm('确定清除已保存的 API Key？（清除后翻译会回退到免费接口）')) return;
      try {
        var r = await api('POST', '/api/settings', { clear_key: true });
        trLog(['Key 已清除，当前服务：' + (r.provider === 'llm' ? '大模型（缺 Key）' : '免费接口')]);
        $('#trKey').value = '';
        $('#trKey').placeholder = 'API Key';
        $('#trState').textContent = (r.provider === 'llm') ? '缺 Key' : '免费接口';
      } catch (e) {
        trLog(['清除失败：' + e.message]);
      }
    });

    $('#trModels').addEventListener('click', async function () {
      trLog(['正在拉取模型列表…']);
      try {
        var r = await api('POST', '/api/models', {
          api_key: $('#trKey').value.trim(),
          base_url: $('#trBase').value.trim()
        });
        $('#modelList').innerHTML = (r.models || []).map(function (m) {
          return '<option value="' + esc(m) + '"></option>';
        }).join('');
        var guess = (r.models || []).filter(function (m) { return /flash|chat|v3/i.test(m); });
        if (guess.length) $('#trModel').value = guess[0];
        trLog(['共 ' + r.models.length + ' 个模型（点模型框会下拉选择）',
               '已自动选：' + ($('#trModel').value || '（自己选一个）'),
               '列表：' + r.models.slice(0, 8).join(' / ')]);
      } catch (e) {
        trLog(['拉取失败：' + e.message]);
      }
    });

    $('#trTest').addEventListener('click', async function () {
      trLog(['正在试译一句…']);
      try {
        var r = await api('POST', '/api/translate/test', { langs: ['zh', 'ja'] });
        var lines = ['服务：' + (r.provider === 'llm' ? '大模型' : '免费接口'),
                     '原文：' + r.sample];
        (r.results || []).forEach(function (x) { lines.push(x.lang + '：' + x.text); });
        (r.errors || []).forEach(function (e) { lines.push('警告：' + e); });
        trLog(lines);
        await loadTranslations();
        renderAll();
      } catch (e) {
        trLog(['试译失败：' + e.message]);
      }
    });
  }

  /* -------------------------------------------------------------- 报头 --- */
  function renderTop() {
    var d = state.digest;
    var rc = d.region_counts || {};
    $('#dateLine').textContent = fmtDate(d.date);
    $('#issueNo').textContent = '第 ' + String(d.issue || 1).padStart(3, '0') + ' 期';
    $('#genLine').textContent = (d.generated_at || '').slice(11, 16) + ' 生成';
    var t = $('#footTime');
    if (t) t.textContent = (d.generated_at || '').slice(0, 16).replace('T', ' ');

    $('#sectionNav').innerHTML = SECTIONS.map(function (s) {
      var n = rc[s.id] || 0;
      return '<button type="button" data-section="' + s.id + '"' +
        (state.section === s.id ? ' class="on"' : '') +
        ' style="--c:' + s.color + '">' +
        '<span class="sec-tab__label">' + s.label + '</span>' +
        '<span class="sec-tab__n">' + n + ' 条</span>' +
        '<span class="sec-tab__note">' + s.note + '</span></button>';
    }).join('');
    $('#sectionNav').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.section === b.dataset.section) return;
        state.section = b.dataset.section;
        state.bcat = 'all';
        renderAll();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  /* ---------------------------------------------------------- 今日要点 --- */
  function renderBrief() {
    var meta = sectionMeta(state.section);
    var brief = sec().brief || [];
    $('#briefTitle').textContent = meta.label + ' · 今日要点' +
      (state.lang !== 'orig' && state.section === 'global' ? '（已译）' : '');
    $('#briefList').innerHTML = brief.map(function (b, i) {
      var c = catOf(b.cat);
      return '<li class="brief__item reveal" style="--c:' + c.color +
        ';animation-delay:' + (i * 36) + 'ms">' +
        '<span class="brief__no">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<div><div class="brief__tag">' +
        (b.cat ? '<span class="brief__cat">' + esc(c.label) + '</span>' : '') +
        '<span class="brief__src">' + esc(b.source || '') + '</span>' +
        '</div><p class="brief__text">' + esc(T(b.text)) + '</p></div></li>';
    }).join('');
    $('#briefNote').textContent = brief.length ? brief.length + ' 条' : '';
  }

  /* ------------------------------------------------- 左栏：板块 / 品类 --- */
  function renderSide() {
    var s = sec();
    var counts = s.counts || {};

    $('#catNav').innerHTML = [{ id: 'all', label: '全部', color: 'var(--ink-3)',
      n: s.total || 0 }].concat(CATS.map(function (c) {
        return { id: c.id, label: c.label, color: c.color, n: counts[c.id] || 0 };
      })).map(function (c) {
        return '<button type="button" data-cat="' + c.id + '"' +
          (state.cat === c.id ? ' class="on"' : '') + '>' +
          '<span class="dot" style="background:' + c.color + '"></span>' + c.label +
          '<span class="n">' + c.n + '</span></button>';
      }).join('');

    var market = s.market || { cats: [] };
    var cats = market.cats || [];
    var maxPct = cats.length ? cats[0].composite : 1;
    var nav = [{ id: 'all', label: '全部', color: 'var(--ink-3)', composite: 1,
      items: s.total || 0 }].concat(cats);
    if (market.unclassified) {
      nav = nav.concat([{ id: 'none', label: '未归入品类', color: 'var(--ink-3)',
        composite: 0, items: market.unclassified }]);
    }
    $('#bcNav').innerHTML = nav.map(function (c) {
      var w = c.id === 'all' ? 0 : Math.max(6, Math.round((c.composite / (maxPct || 1)) * 44));
      return '<button type="button" data-bcat="' + esc(c.id) + '"' +
        (state.bcat === c.id ? ' class="on"' : '') + '>' +
        '<span class="bar" style="background:' + c.color + ';width:' + w + 'px"></span>' +
        esc(c.label) + '<span class="n">' + c.items + '</span></button>';
    }).join('');

    $('#kwList').innerHTML = (s.keywords || []).map(function (k) {
      return '<li>' + esc(k) + '</li>';
    }).join('');

    $('#catNav').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.cat = b.dataset.cat;
        renderSide(); renderFeed();
      });
    });
    $('#bcNav').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.bcat = b.dataset.bcat;
        renderSide(); renderFeed();
      });
    });

    // 外网板块才显示节点设置与翻译服务
    var nb = $('#nodeBlock');
    if (nb) nb.hidden = !(state.section === 'global' && HAS_API);
    var tb = $('#trBlock');
    if (tb) tb.hidden = !(state.section === 'global' && HAS_API);
  }

  /* ------------------------------------------------------------ 信息流 --- */
  function filtered() {
    return secItems().filter(function (it) {
      if (state.cat !== 'all' && it.cat !== state.cat) return false;
      if (state.bcat !== 'all') {
        if (state.bcat === 'none') {
          if ((it.bcats || []).length) return false;
        } else if ((it.bcats || []).indexOf(state.bcat) < 0) {
          return false;
        }
      }
      return true;
    });
  }

  function ticketHTML(it, idx) {
    var c = catOf(it.cat);
    var brands = (it.brands || []).slice(0, 4);
    var title = T(it.title);
    var summ = it.summary ? T(it.summary) : '';
    var translated = title !== it.title;
    return '<a class="ticket reveal" href="' + esc(it.url) + '" target="_blank" ' +
      'rel="noopener noreferrer" style="--c:' + c.color +
      ';animation-delay:' + Math.min(idx, 12) * 24 + 'ms">' +
      '<span class="ticket__rail"></span>' +
      '<div class="ticket__head">' +
      '<span class="ticket__no">' + String(it.no || idx + 1).padStart(2, '0') + '</span>' +
      '<span class="ticket__cat">' + esc(c.label) + '</span>' +
      (translated ? '<span class="ticket__tr">译</span>' : '') +
      '<span class="ticket__time">' + esc(itemTime(it)) + '</span>' +
      '</div>' +
      '<h3 class="ticket__title">' + esc(title) + '</h3>' +
      (summ ? '<p class="ticket__sum">' + esc(summ) + '</p>' : '') +
      (brands.length ? '<div class="ticket__brands">' + brands.map(function (b) {
        return '<span>' + esc(b) + '</span>';
      }).join('') + '</div>' : '') +
      '<div class="perf"></div>' +
      '<div class="ticket__foot"><span>' + esc(it.source) + '</span>' +
      '<span class="ticket__go">原文 ↗</span></div></a>';
  }

  function renderFeed() {
    var items = filtered();
    var html = '', lastCat = null, i = 0;
    items.forEach(function (it) {
      if (state.cat === 'all' && it.cat !== lastCat) {
        var c = catOf(it.cat);
        var n = items.filter(function (x) { return x.cat === it.cat; }).length;
        html += '<div class="group-head" style="--c:' + c.color + '">' + esc(c.label) +
          ' <span class="n">' + n + '</span></div>';
        lastCat = it.cat;
      }
      html += ticketHTML(it, i++);
    });
    $('#feed').innerHTML = html ||
      '<div class="empty">这个筛选下没有条目，换个条件看看。</div>';
  }

  /* -------------------------------------------------- 右栏：市场格局图 --- */
  function renderDonut() {
    var market = sec().market || {};
    var cats = (market.cats || []).filter(function (c) { return c.composite >= 0.005; });
    var top = cats.slice(0, 8);
    var rest = cats.slice(8);
    if (rest.length) {
      var sum = rest.reduce(function (a, c) { return a + c.composite; }, 0);
      top = top.concat([{ id: '__rest', label: '其他品类', color: '#8D949C',
        composite: sum, items: rest.reduce(function (a, c) { return a + c.items; }, 0) }]);
    }
    var R = 62, SW = 26, C = 2 * Math.PI * R, acc = 0;
    var unclassified = market.unclassified || 0;
    var classified = Math.max(0, (sec().total || 0) - unclassified);
    var slices = top.map(function (c) {
      var len = c.composite * C;
      var seg = '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke="' + c.color +
        '" stroke-width="' + SW + '" stroke-dasharray="' + (len - 1.5).toFixed(2) + ' ' +
        (C - len + 1.5).toFixed(2) + '" stroke-dashoffset="' + (-acc).toFixed(2) + '"></circle>';
      acc += len;
      return seg;
    }).join('');

    $('#donut').innerHTML = '<svg width="200" height="200" viewBox="0 0 200 200">' +
      '<g transform="rotate(-90 100 100)">' +
      '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke="var(--recess)" ' +
      'stroke-width="' + SW + '"></circle>' + slices + '</g>' +
      '<text class="donut__num" x="100" y="98" text-anchor="middle">' + classified + '</text>' +
      '<text class="donut__lab" x="100" y="118" text-anchor="middle">条已归类</text></svg>';

    $('#catLegend').innerHTML = top.map(function (c) {
      return '<li><span class="sw" style="background:' + c.color + '"></span>' +
        esc(c.label) + '<span class="sub">' + c.items + '条</span>' +
        '<span class="pct">' + pct(c.composite) + '</span></li>';
    }).join('');

    $('#marketTitle').innerHTML = sectionMeta(state.section).label +
      ' · 市场格局 <span class="panel__hint">综合占比</span>';
    $('#formula').textContent = (market.formula || '') +
      (unclassified ? ' 另有 ' + unclassified + ' 条未识别出具体品牌/品类，未计入饼图。' : '');
  }

  function renderBrands() {
    var market = sec().market || {};
    var brands = (market.brand_top || []).slice(0, 12);
    $('#brandHint').textContent = market.brand_total_hint || '';
    if (!brands.length) {
      $('#brandBars').innerHTML = '<p class="formula">这个板块今天没有识别到明确的品牌。</p>';
      return;
    }
    var max = brands[0].count || 1;
    var colorOf = {};
    (market.cats || []).forEach(function (c) { colorOf[c.id] = c.color; });
    $('#brandBars').innerHTML = brands.map(function (b) {
      var w = Math.max(4, Math.round((b.count / max) * 100));
      return '<div class="bars__row">' +
        '<span class="bars__name" title="' + esc(b.name) + '">' + esc(b.name) + '</span>' +
        '<span class="bars__n">' + b.count + ' 次</span>' +
        '<span class="bars__track"><span class="bars__fill" style="width:' + w +
        '%;background:' + (colorOf[b.cat] || '#8D949C') + '"></span></span></div>';
    }).join('');
  }

  function renderScales() {
    var scales = ((sec().market || {}).scales || []).slice(0, 10);
    if (!scales.length) {
      $('#scaleList').innerHTML = '<p class="formula">这个板块今天没有抓到含门店数/营收的表述。</p>';
      return;
    }
    $('#scaleList').innerHTML = scales.map(function (s) {
      return '<li><span class="kind">' + esc(s.kind) + '</span>' +
        '<span class="val">' + esc(s.value) + '</span>' +
        '<span class="who">' + esc(s.brand || '未标注品牌') + ' · ' + esc(s.source) + '</span></li>';
    }).join('');
  }

  function renderFoot() {
    var seen = {}, names = [];
    secItems().forEach(function (it) {
      if (it.source && !seen[it.source]) { seen[it.source] = 1; names.push(it.source); }
    });
    $('#srcList').innerHTML = names.map(function (n) {
      return '<span>' + esc(n) + '</span>';
    }).join('');
  }

  function renderAll() {
    renderTop();
    renderLangBar();
    renderBrief();
    renderSide();
    renderFeed();
    renderDonut();
    renderBrands();
    renderScales();
    renderFoot();
    syncTopH();
  }

  /* ------------------------------------------------------- 复制今日要点 --- */
  function briefText() {
    var d = state.digest, s = sec(), meta = sectionMeta(state.section);
    var lines = ['餐饮日报 · ' + meta.label + ' · ' + fmtDate(d.date) +
      '（第 ' + String(d.issue || 1) + ' 期，' + s.total + ' 条）', ''];
    (s.brief || []).forEach(function (b, i) {
      lines.push((i + 1) + '. ' + (b.cat ? '[' + catOf(b.cat).label + '] ' : '') + b.text);
    });
    var cats = ((s.market || {}).cats || []).slice(0, 5);
    if (cats.length) {
      lines.push('', '市场格局（综合占比）：' + cats.map(function (c) {
        return c.label + ' ' + pct(c.composite);
      }).join(' / '));
    }
    if ((s.keywords || []).length) lines.push('今日高频：' + s.keywords.join(' / '));
    lines.push('', '（' + meta.label + ' ' + s.total + ' 条 · ' + meta.note + '）');
    return lines.join('\n');
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function initCopy() {
    var hint = $('#copyHint');
    var btn = $('#copyBtn');
    if (IS_APP) btn.textContent = '分享要点';
    btn.addEventListener('click', function () {
      var text = briefText();
      if (IS_APP && window.AppBridge.share) {
        legacyCopy(text);
        try { window.AppBridge.share(text); } catch (e) {}
        hint.textContent = '已复制，可直接粘贴或分享';
        setTimeout(function () { hint.textContent = ''; }, 3000);
        return;
      }
      function done(ok) {
        hint.textContent = ok ? '已复制到剪贴板' : '复制失败，请手动选中';
        setTimeout(function () { hint.textContent = ''; }, 2600);
      }
      if (navigator.clipboard && ON_SERVER) {
        navigator.clipboard.writeText(text).then(function () { done(true); },
          function () { done(legacyCopy(text)); });
      } else {
        done(legacyCopy(text));
      }
    });
  }

  /* --------------------------------------------------- 登录状态 / 退出 --- */
  async function initSession() {
    // auth.js 存在时由它接管（静态站点登录门禁 / 本机服务器的账号与设备名额）
    var A = window.CanyinAuth;
    if (A && A.enabled) return;
    if (!HAS_API) {
      var w0 = $('#whoami');
      if (w0) {
        w0.textContent = '静态版';
        w0.title = '这是在静态托管上打开：登录 / 外网节点 / 翻译设置需要在本机跑 server.py';
        w0.hidden = false;
      }
      var l0 = $('#logoutBtn');
      if (l0) l0.hidden = true;
      return;
    }
    try {
      var s = await api('GET', '/api/session');
      if (!s.logged_in) { location.replace('/login.html'); return; }
      state.user = s.user || '';
      var w = $('#whoami');
      w.textContent = state.user;
      w.hidden = false;
      $('#logoutBtn').hidden = false;
      $('#logoutBtn').addEventListener('click', async function () {
        try { await api('POST', '/api/logout'); } catch (e) {}
        location.replace('/login.html');
      });
    } catch (e) {
      if (String(e.message).indexOf('401') >= 0) location.replace('/login.html');
    }
  }

  async function detectApi() {
    HAS_API = false;
    if (!ON_SERVER) return;
    try {
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, 4000) : null;
      var r = await fetch('/api/session', {
        headers: { 'Accept': 'application/json' },
        signal: ctl ? ctl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      var j = await r.json();
      HAS_API = !!(j && typeof j === 'object' && 'logged_in' in j);
    } catch (e) {
      HAS_API = false;
    }
  }

  /* ------------------------------------------------------ 外网节点设置 --- */
  function nodeLog(lines, cls) {
    var box = $('#nodeLog');
    box.hidden = false;
    box.innerHTML = (lines || []).map(function (l) {
      return '<div' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(l) + '</div>';
    }).join('');
  }

  function initNode() {
    if (!HAS_API) return;
    var input = $('#nodeInput');

    function load() {
      api('GET', '/api/settings').then(function (s) {
        input.value = s.proxy || '';
        $('#nodeState').textContent = s.proxy ? '已设置' : '未设置';
      }).catch(function () {});
    }
    load();

    $('#nodeSave').addEventListener('click', async function () {
      try {
        var r = await api('POST', '/api/settings', { proxy: input.value.trim() });
        $('#nodeState').textContent = r.proxy ? '已设置' : '未设置';
        nodeLog(['已保存：' + (r.proxy || '（留空 = 不使用节点）') + '     ' + (r.updated_at || '')]);
      } catch (e) {
        nodeLog(['保存失败：' + e.message]);
      }
    });

    $('#nodeTest').addEventListener('click', async function () {
      var proxy = input.value.trim();
      nodeLog(['正在用 ' + (proxy || '当前节点') + ' 测试海外源…']);
      try {
        var r = await api('POST', '/api/proxy-test', { proxy: proxy });
        nodeLog(r.results.map(function (x) {
          return (x.ok ? '✓ ' : '✗ ') + x.name + '  ' +
            (x.ok ? (x.kind + '  ' + x.ms + 'ms') : (x.error + '  ' + x.ms + 'ms'));
        }));
      } catch (e) {
        nodeLog(['测试失败：' + e.message]);
      }
    });

    $('#collectBtn').addEventListener('click', async function () {
      try {
        await api('POST', '/api/collect', {});
      } catch (e) {
        nodeLog(['无法开始采集：' + e.message]);
        return;
      }
      nodeLog(['已开始采集，大约 1-3 分钟…']);
      if (state.nodeLogTimer) clearInterval(state.nodeLogTimer);
      state.nodeLogTimer = setInterval(pollCollect, 2500);
    });
  }

  async function pollCollect() {
    try {
      var st = await api('GET', '/api/collect/status');
      var lines = (st.log || []).slice(-14);
      if (st.running) {
        nodeLog(lines.concat(['…运行中']));
        return;
      }
      clearInterval(state.nodeLogTimer);
      state.nodeLogTimer = null;
      nodeLog(lines.concat([st.code === 0 ? '✓ 采集完成，正在刷新页面…' : ('✗ 采集失败（退出码 ' + st.code + '）')]));
      if (st.code === 0) setTimeout(function () { location.reload(); }, 900);
    } catch (e) { /* 忽略网络抖动 */ }
  }

  /* ------------------------------------------------------- 手机 App 桥 --- */
  function initAppShell() {
    if (!IS_APP) return;
    var btn = $('#syncBtn');
    if (!btn) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var cur = '';
      try { cur = window.AppBridge.getRemote() || ''; } catch (e) {}
      var v = prompt('在线数据源（留空 = 用 App 内置的离线日报）\n例如：https://你的域名/index.html', cur);
      if (v === null) return;
      try {
        window.AppBridge.setRemote(v.trim());
        window.AppBridge.reload();
      } catch (e) { alert('保存失败：' + e.message); }
    });
  }

  /* -------------------------------------------------------------- 往期 --- */
  function renderArchive(list, current) {
    $('#archiveList').innerHTML = list.map(function (h) {
      return '<li data-date="' + esc(h.date) + '"' +
        (h.date === current ? ' aria-current="true"' : '') + '>' +
        '<span class="d">' + esc(h.date) + '</span>' +
        '<span>' + esc((h.headline || '').slice(0, 30)) + '</span>' +
        '<span class="t">' + (h.total || 0) + ' 条</span></li>';
    }).join('');
    $('#archiveList').querySelectorAll('li').forEach(function (li) {
      li.addEventListener('click', function () { loadDate(li.dataset.date); });
    });
  }

  function historyFromArchive() {
    return Object.keys(state.archive).sort().reverse().map(function (d) {
      return { date: d, total: (state.archive[d] || {}).total || 0,
        headline: (state.archive[d] || {}).headline || '' };
    });
  }

  async function loadDate(date) {
    if (date === state.digest.date) { $('#archiveSheet').close(); return; }
    var apply = function (d) {
      state.digest = d;
      state.cat = 'all'; state.bcat = 'all';
      renderAll();
      $('#archiveSheet').close();
      window.scrollTo({ top: 0 });
    };
    if (state.archive[date]) { apply(state.archive[date]); return; }
    if (PROTECTED) {
      try {
        var got = await authDigest(date);
        var d0 = got && got.digest;
        if (!d0 || !d0.items) throw new Error((got && got.error) || '数据不完整');
        state.archive[date] = d0;
        apply(d0);
      } catch (e) { alert('打开这一期失败：' + e.message); }
      return;
    }
    if (!ON_SERVER) return;
    try {
      var r = await fetch('data/digest-' + date + '.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      if (!d || !d.items) throw new Error('数据不完整');
      apply(d);
    } catch (e) { alert('打开这一期失败：' + e.message); }
  }

  async function initArchive() {
    var sheet = $('#archiveSheet');
    $('#archiveBtn').addEventListener('click', async function () {
      if (!state.history.length) {
        var local = historyFromArchive();
        if (local.length > 1) {
          state.history = local;
        } else if (ON_SERVER || PROTECTED) {
          try {
            if (PROTECTED) {
              var got = await authDigest('');
              if (got && got.index) state.history = got.index.history || [];
            } else {
              var r = await fetch('data/index.json', { cache: 'no-store' });
              if (r.ok) state.history = (await r.json()).history || [];
            }
          } catch (e) {}
        }
      }
      if (!state.history.length) {
        state.history = [{ date: state.digest.date, total: state.digest.total }];
      }
      renderArchive(state.history, state.digest.date);
      sheet.showModal();
    });
    $('#sheetClose').addEventListener('click', function () { sheet.close(); });
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });
  }

  async function refreshFromServer() {
    if (PROTECTED) {
      try {
        var got = await authDigest('');
        if (got && got.index) state.history = got.index.history || [];
        if (got && got.digest && got.digest.items && got.digest.date !== state.digest.date) {
          state.digest = got.digest;
          renderAll();
        }
      } catch (e) {}
      return;
    }
    if (!ON_SERVER) return;
    try {
      var r = await fetch('data/index.json', { cache: 'no-store' });
      if (!r.ok) return;
      var idx = await r.json();
      state.history = idx.history || [];
      if (!idx.latest || idx.latest === state.digest.date) return;
      var r2 = await fetch('data/digest-' + idx.latest + '.json', { cache: 'no-store' });
      if (!r2.ok) return;
      var d = await r2.json();
      if (d && d.items) { state.digest = d; renderAll(); }
    } catch (e) {}
  }

  /* -------------------------------------------------------------- 启动 --- */
  async function boot() {
    // 手机端（窄屏）由 mobile.js 接管界面，桌面版什么都不渲染，免得白跑一遍
    if (window.CanyinMobile && window.CanyinMobile.active) return;
    var data = null, arch = null;
    try { data = JSON.parse(document.getElementById('boot-data').textContent); } catch (e) {}
    try { arch = JSON.parse(document.getElementById('boot-archive').textContent); } catch (e) {}
    if (arch && typeof arch === 'object' && !Array.isArray(arch)) state.archive = arch;

    await detectApi();
    PROTECTED = !!(window.CanyinAuth && window.CanyinAuth.mode === 'remote'
                   && window.CanyinAuth.protected);

    initShift();
    initCopy();
    initAppShell();
    try { state.lang = localStorage.getItem(LANG_KEY) || 'orig'; } catch (e) {}

    // 彻底版：页面里根本没有数据，必须先登录，再由服务端下发
    if (PROTECTED) {
      state.digest = emptyDigest();
      $('#sectionNav').innerHTML = '';
      $('#briefList').innerHTML = '';
      $('#feed').innerHTML = '<div class="empty">正在等待登录…</div>';
      syncTopH();
      initSession();
      initNode();
      initTranslateSettings();
      await waitLogin();
      $('#feed').innerHTML = '<div class="empty">正在从服务端取今天的数据…</div>';
      try {
        var got = await authDigest('');
        if (got && got.index) state.history = got.index.history || [];
        if (got && got.digest && got.digest.items) {
          state.digest = got.digest;
          var rc0 = got.digest.region_counts || {};
          if (!rc0.cn && rc0.global) state.section = 'global';
          renderAll();
          initArchive();
        } else {
          $('#feed').innerHTML = '<div class="empty">服务端还没有日报数据，先在本机跑 <code>python tools\\push_digest.py</code> 上传。</div>';
        }
      } catch (e) {
        $('#feed').innerHTML = '<div class="empty">取数据失败：' + esc(e.message) + '</div>';
      }
      return;
    }

    if (!data || !data.items || !data.items.length) {
      state.digest = emptyDigest();
      $('#sectionNav').innerHTML = '';
      $('#briefList').innerHTML = '';
      $('#feed').innerHTML = '<div class="empty">还没有今天的日报数据，先运行 <code>python daily.py</code>。</div>';
      syncTopH();
      initSession();
      initNode();
      initTranslateSettings();
      return;
    }

    state.digest = data;
    // 默认打开有内容的板块
    var rc = data.region_counts || {};
    if (!rc.cn && rc.global) state.section = 'global';

    renderAll();
    initArchive();
    initSession();
    initNode();
    initTranslateSettings();
    if (state.lang !== 'orig') {
      loadTranslations().then(renderAll);
    }
    refreshFromServer();

    window.addEventListener('resize', syncTopH);
    if ('serviceWorker' in navigator && ON_SERVER) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
