/* ==========================================================================
   餐饮日报 · 登录鉴权服务（Deno Deploy 单文件版）
   --------------------------------------------------------------------------
   为什么需要它：GitHub Pages 只能放静态文件，没法校验密码、也没法记住
   「某个账号已经在几台设备上登录」。所以把「登录 + 设备名额」放到这个
   小服务里，网页（静态版 / APK / iOS）通过 HTTPS 调它。

   它做的事：
     · POST /api/login          账号密码校验（PBKDF2-SHA256，与本地 users.json 同格式）
                                通过后发放 token，并登记这台设备
     · POST /api/session        校验 token（顺带心跳更新设备最后在线时间）
     · POST /api/logout         退出登录，并释放这台设备的名额
     · POST /api/devices        列出该账号当前在线的设备
     · POST /api/devices/kick   把某台设备踢下线（腾出名额）
     · GET  /api/health         健康检查 / 自检
     · GET  /                   一个很小的状态页

   硬性约束：
     · 每账号最多 MAX_DEVICES 台设备（默认 3）。超出时先要求踢掉一台，
       不会偷偷顶掉老设备。
     · 密码永不明文存储、永不明文返回；只存 PBKDF2 哈希。
     · 连续 6 次密码错误锁 3 分钟（按 IP + 账号双重计数）。

   环境变量（在 Deno Deploy 控制台里配）：
     USERS_JSON      必填。内容就是本地 config/users.json 的原文（只含哈希）；
                     用 python tools\auth_admin.py emit 生成
     MAX_DEVICES     可选，默认 3
     DEVICE_TTL_DAYS 可选，默认 30（超过这个天数没上线的设备自动释放名额）
     SESSION_DAYS    可选，默认 30（token 有效期）
     ALLOW_ORIGIN    可选，默认 *（跨域白名单，可填你的站点域名）
     APP_TITLE       可选，默认「餐饮日报」
     ADMIN_TOKEN     可选，填了才能用 /api/admin/purge 清空某账号的所有设备
   ========================================================================== */

const VERSION = "1.0.0";
const enc = new TextEncoder();

function envInt(name: string, def: number, min = 1): number {
  const raw = (Deno.env.get(name) ?? "").trim();
  const v = Number(raw);
  return raw !== "" && Number.isFinite(v) && v >= min ? Math.floor(v) : def;
}

const MAX_DEVICES = envInt("MAX_DEVICES", 3);
const DEVICE_TTL_DAYS = envInt("DEVICE_TTL_DAYS", 30);
const SESSION_DAYS = envInt("SESSION_DAYS", 30);
const MAX_FAILS = envInt("MAX_FAILS", 6);
const LOCK_SECONDS = envInt("LOCK_SECONDS", 180);
const ALLOW_ORIGIN = (Deno.env.get("ALLOW_ORIGIN") ?? "*").trim() || "*";
const APP_TITLE = (Deno.env.get("APP_TITLE") ?? "餐饮日报").trim() || "餐饮日报";
const ADMIN_TOKEN = (Deno.env.get("ADMIN_TOKEN") ?? "").trim();

/* ------------------------------------------------------------ KV 连接 --- */
// Deno Deploy 里给这个 App 挂上一个 Deno KV 数据库后，Deno.openKv() 不需要参数。
// 延迟打开 + 兜底报错：没挂数据库时给一句人话提示，而不是整个服务 500。
let kvCache: any = null;
let kvError = "";

async function kv(): Promise<any> {
  if (kvCache) return kvCache;
  const open = (Deno as any).openKv;
  if (typeof open !== "function") {
    kvError = "当前运行环境没有 Deno.openKv（Deno KV 目前仍是 unstable API，" +
      "需要在 App 配置的 Dynamic arguments 里加 --unstable-kv）";
    return null;
  }
  try {
    const url = (Deno.env.get("KV_URL") ?? Deno.env.get("DENO_KV_URL") ?? "").trim();
    kvCache = url ? await open(url) : await open();
    kvError = "";
    return kvCache;
  } catch (e) {
    kvError = String(e);
    return null;
  }
}

/* -------------------------------------------------------------- 小工具 --- */
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
    },
  });
}

function deny(status: number, error: string, code = ""): Response {
  return json({ ok: false, error, ...(code ? { code } : {}) }, status);
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): ArrayBuffer {
  const clean = String(hex || "").trim();
  const out = new Uint8Array(new ArrayBuffer(Math.floor(clean.length / 2)));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out.buffer as ArrayBuffer;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return bytesToHex(new Uint8Array(d));
}

/** 与 Python hashlib.pbkdf2_hmac("sha256", pwd, salt, iters) 完全一致 */
async function pbkdf2Hex(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function sameHex(a: string, b: string): boolean {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function newToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

const nowSec = () => Math.floor(Date.now() / 1000);

function fmt(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000 + 8 * 3600 * 1000); // 东八区
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "";
  const ip = fwd.split(",")[0].trim();
  return ip || "unknown";
}

function deviceIdOf(raw: unknown, ip: string, ua: string): string {
  const s = String(raw ?? "").trim();
  if (/^[A-Za-z0-9._:-]{4,80}$/.test(s)) return s;
  // 老版本客户端没带 deviceId：按 IP+UA 兜底生成一个稳定 ID
  return "legacy-" + Math.abs(hash32(ip + "|" + ua)).toString(16);
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/* --------------------------------------------------------------- 账号 --- */
type UserRec = { username: string; salt: string; hash: string; iterations: number };

function usersFromEnv(): UserRec[] {
  const raw = (Deno.env.get("USERS_JSON") ?? "").trim();
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw);
    const list = Array.isArray(doc) ? doc : (doc.users || []);
    return list
      .filter((u: any) => u && u.username && u.salt && u.hash)
      .map((u: any) => ({
        username: String(u.username),
        salt: String(u.salt),
        hash: String(u.hash),
        iterations: Number(u.iterations) || 150000,
      }));
  } catch {
    return [];
  }
}

async function saveUsers() {
  const k = await kv();
  if (!k) return 0;
  const list = usersFromEnv();
  for (const u of list) await k.set(["user", u.username], u);
  await k.set(["meta", "seeded"], { at: nowSec(), count: list.length });
  return list.length;
}

/** 账号来源：env 里的 USERS_JSON 优先；没有就退回 KV 里已存过的（首次 seed 之后） */
async function findUser(username: string): Promise<UserRec | null> {
  const fromEnv = usersFromEnv();
  if (fromEnv.length) {
    const hit = fromEnv.find((u) => u.username === username);
    if (hit) return hit;
  }
  const k = await kv();
  if (!k) return null;
  const got = await k.get(["user", username]);
  return (got?.value as UserRec) || null;
}

async function checkPassword(username: string, password: string): Promise<boolean> {
  const u = await findUser(username);
  if (!u) return false;
  try {
    const calc = await pbkdf2Hex(password, u.salt, u.iterations);
    return sameHex(calc, u.hash);
  } catch {
    return false;
  }
}

/* ----------------------------------------------------- 设备（名额管理） --- */
type DevRec = {
  id: string;
  name: string;
  ua: string;
  ip: string;
  first: number;
  last: number;
};

async function listDevices(user: string, prune = true): Promise<DevRec[]> {
  const k = await kv();
  if (!k) return [];
  const out: DevRec[] = [];
  const cutoff = nowSec() - DEVICE_TTL_DAYS * 86400;
  for await (const e of k.list({ prefix: ["dev", user] })) {
    const d = e.value as DevRec;
    if (!d) continue;
    if (prune && (d.last || 0) < cutoff) {
      await k.delete(e.key);
      continue;
    }
    out.push(d);
  }
  out.sort((a, b) => (b.last || 0) - (a.last || 0));
  return out;
}

function publicDevice(d: DevRec, currentId: string) {
  return {
    id: d.id,
    name: d.name || "未知设备",
    ip: d.ip || "",
    first: fmt(d.first),
    last: fmt(d.last),
    lastTs: d.last || 0,
    current: d.id === currentId,
  };
}

async function dropDevice(user: string, deviceId: string) {
  const k = await kv();
  if (!k) return;
  await k.delete(["dev", user, deviceId]);
}

/* --------------------------------------------------------------- 限流 --- */
async function failState(key: any): Promise<{ n: number; until: number }> {
  const k = await kv();
  if (!k) return { n: 0, until: 0 };
  const got = await k.get(key);
  return (got?.value as any) || { n: 0, until: 0 };
}

async function bumpFail(key: any, reset = false) {
  const k = await kv();
  if (!k) return;
  if (reset) {
    await k.delete(key);
    return;
  }
  const cur = await failState(key);
  const n = (cur.n || 0) + 1;
  const val = n >= MAX_FAILS ? { n: 0, until: nowSec() + LOCK_SECONDS } : { n, until: cur.until || 0 };
  await k.set(key, val);
}

/* -------------------------------------------------------------- 业务 --- */
async function doLogin(body: any, ip: string, ua: string): Promise<Response> {
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  const deviceId = deviceIdOf(body?.deviceId, ip, ua);
  const deviceName = String(body?.deviceName ?? "").slice(0, 60);
  const kick = String(body?.kick ?? "").trim();

  if (!username || !password) return deny(400, "用户名和密码都要填", "missing");

  const k = await kv();
  if (!k) return deny(503, "鉴权服务还没挂数据库（Deno KV），请在 Deno Deploy 控制台挂上", "no_kv");

  const users = usersFromEnv();
  if (!users.length && (await k.get(["user", username])).value === null) {
    return deny(503, "鉴权服务还没配置账号（USERS_JSON），请用 tools\\auth_admin.py emit 生成后填入环境变量", "no_users");
  }

  const ipKey = ["fail", "ip", ip];
  const userKey = ["fail", "user", username];
  const now = nowSec();
  for (const key of [ipKey, userKey]) {
    const st = await failState(key);
    if (st.until > now) {
      const left = st.until - now;
      return deny(429, `失败次数太多，请 ${left} 秒后再试`, "locked");
    }
  }

  if (!(await checkPassword(username, password))) {
    await bumpFail(ipKey);
    await bumpFail(userKey);
    return deny(401, "用户名或密码不正确", "bad_credentials");
  }

  await bumpFail(ipKey, true);
  await bumpFail(userKey, true);

  // 先把名字记下来（登录成功才会覆盖）
  const devices = await listDevices(username);
  const mine = devices.find((d) => d.id === deviceId);

  if (!mine && devices.length >= MAX_DEVICES) {
    // 名额已满：要求用户明确选一台踢掉，或先在老设备上退出登录
    if (kick) {
      const target = devices.find((d) => d.id === kick);
      if (!target) return deny(400, "要下线的设备不存在，请刷新后重试", "bad_kick");
      await dropDevice(username, target.id);
    } else {
      return json({
        ok: false,
        code: "device_limit",
        error: `这个账号已经在 ${devices.length} 台设备上登录（上限 ${MAX_DEVICES} 台）`,
        maxDevices: MAX_DEVICES,
        devices: devices.map((d) => publicDevice(d, deviceId)),
      }, 403);
    }
  }

  const token = newToken();
  const exp = now + SESSION_DAYS * 86400;
  await k.set(["tok", await sha256Hex(token)], { user: username, deviceId, exp });

  const prev = (await k.get(["dev", username, deviceId])).value as DevRec | null;
  const rec: DevRec = {
    id: deviceId,
    name: deviceName || prev?.name || "未知设备",
    ua: ua.slice(0, 160),
    ip,
    first: prev?.first || now,
    last: now,
  };
  await k.set(["dev", username, deviceId], rec);

  const after = await listDevices(username);
  return json({
    ok: true,
    user: username,
    token,
    expiresAt: exp,
    maxDevices: MAX_DEVICES,
    deviceId,
    devices: after.map((d) => publicDevice(d, deviceId)),
  });
}

async function sessionOf(body: any, ua: string, touch = true): Promise<{ user: string; deviceId: string } | null> {
  const token = String(body?.token ?? "").trim();
  if (!token) return null;
  const k = await kv();
  if (!k) return null;
  const h = await sha256Hex(token);
  const got = await k.get(["tok", h]);
  const rec = got?.value as { user: string; deviceId: string; exp: number } | null;
  if (!rec) return null;
  if (!rec.exp || rec.exp < nowSec()) {
    await k.delete(["tok", h]);
    return null;
  }
  const dev = await k.get(["dev", rec.user, rec.deviceId]);
  const d = dev?.value as DevRec | null;
  if (!d) {
    // 设备被踢下线（或名额过期）→ token 一起作废
    await k.delete(["tok", h]);
    return null;
  }
  if (touch && nowSec() - (d.last || 0) > 600) {
    d.last = nowSec();
    d.ua = ua.slice(0, 160) || d.ua;
    await k.set(["dev", rec.user, rec.deviceId], d);
  }
  return { user: rec.user, deviceId: rec.deviceId };
}

async function doSession(body: any, ua: string): Promise<Response> {
  const s = await sessionOf(body, ua);
  if (!s) return deny(401, "登录已失效，请重新登录", "unauthorized");
  const devices = await listDevices(s.user);
  return json({
    ok: true,
    user: s.user,
    deviceId: s.deviceId,
    maxDevices: MAX_DEVICES,
    devices: devices.map((d) => publicDevice(d, s.deviceId)),
  });
}

async function doDevices(body: any, ua: string): Promise<Response> {
  const s = await sessionOf(body, ua, false);
  if (!s) return deny(401, "登录已失效，请重新登录", "unauthorized");
  const devices = await listDevices(s.user);
  return json({
    ok: true,
    user: s.user,
    deviceId: s.deviceId,
    maxDevices: MAX_DEVICES,
    devices: devices.map((d) => publicDevice(d, s.deviceId)),
  });
}

async function doKick(body: any, ua: string): Promise<Response> {
  const s = await sessionOf(body, ua, false);
  if (!s) return deny(401, "登录已失效，请重新登录", "unauthorized");
  const target = String(body?.deviceId ?? "").trim();
  if (!target) return deny(400, "没指定要下线的设备", "missing");
  if (target === s.deviceId) return deny(400, "不能下线当前正在使用的这台设备", "self");
  await dropDevice(s.user, target);
  const devices = await listDevices(s.user);
  return json({
    ok: true,
    user: s.user,
    deviceId: s.deviceId,
    maxDevices: MAX_DEVICES,
    devices: devices.map((d) => publicDevice(d, s.deviceId)),
  });
}

async function doLogout(body: any, ua: string): Promise<Response> {
  const token = String(body?.token ?? "").trim();
  const s = await sessionOf(body, ua, false);
  const k = await kv();
  if (k && token) await k.delete(["tok", await sha256Hex(token)]);
  if (s) await dropDevice(s.user, s.deviceId); // 退出即释放名额
  return json({ ok: true });
}

async function doPurge(body: any): Promise<Response> {
  if (!ADMIN_TOKEN) return deny(404, "未开启管理接口（需要设 ADMIN_TOKEN 环境变量）", "disabled");
  const given = String(body?.adminToken ?? "").trim();
  if (given !== ADMIN_TOKEN) return deny(403, "管理令牌不对", "forbidden");
  const user = String(body?.user ?? "").trim();
  if (!user) return deny(400, "要指定 username", "missing");
  const k = await kv();
  if (!k) return deny(503, "KV 不可用", "no_kv");

  // 1) 清掉该账号的全部设备（同时让它们的 token 失效，session 校验时自然作废）
  let devices = 0;
  for await (const e of k.list({ prefix: ["dev", user] })) {
    await k.delete(e.key);
    devices++;
  }
  // 2) 清掉该账号残留的 token
  let tokens = 0;
  for await (const e of k.list({ prefix: ["tok"] })) {
    if ((e.value as any)?.user === user) {
      await k.delete(e.key);
      tokens++;
    }
  }
  // 3) 默认顺手清掉登录失败计数，免得账号被锁住时没法救
  let locks = 0;
  if (body?.clearLocks !== false) {
    for await (const e of k.list({ prefix: ["fail"] })) {
      await k.delete(e.key);
      locks++;
    }
  }
  return json({ ok: true, user, cleared: { devices, tokens, locks } });
}

function healthPage(ok: boolean, extra: string): Response {
  const color = ok ? "#1b5fc1" : "#d8432f";
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>${APP_TITLE} · 鉴权服务</title>
<style>body{font:15px/1.7 -apple-system,"Microsoft YaHei",system-ui,sans-serif;margin:0;
padding:48px;background:#eef0ee;color:#14171b}code{font-family:ui-monospace,Consolas,monospace}
.card{max-width:660px;background:#fff;border:1px solid #e8eae6;border-radius:8px;padding:28px 30px}
h1{font-size:20px;margin:0 0 6px}b.ok{color:${color}}</style>
<div class="card"><h1>${APP_TITLE} · 登录鉴权服务</h1>
<p>状态：<b class="ok">${ok ? "运行中 ✓" : "缺少配置 ✗"}</b>　版本 <code>${VERSION}</code></p>
<p>${extra}</p></div></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() } },
  );
}

async function health(): Promise<Response> {
  const k = await kv();
  const users = usersFromEnv();
  let stored = 0;
  if (k && !users.length) {
    for await (const _ of k.list({ prefix: ["user"] })) stored++;
  }
  const accountCount = users.length || stored;
  const problems: string[] = [];
  if (!k) problems.push("Deno KV 未挂载" + (kvError ? `（${kvError.slice(0, 120)}）` : ""));
  if (!accountCount) problems.push("USERS_JSON 未配置");
  return json({
    ok: problems.length === 0,
    service: "canyin-daily-auth",
    version: VERSION,
    maxDevices: MAX_DEVICES,
    deviceTtlDays: DEVICE_TTL_DAYS,
    sessionDays: SESSION_DAYS,
    accounts: accountCount,
    accountNames: users.map((u) => u.username),
    kv: !!k,
    problems,
    time: fmt(nowSec()),
  });
}

/* -------------------------------------------------------------- 路由 --- */
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const ua = req.headers.get("user-agent") || "";
  const ip = clientIp(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let body: any = {};
  if (req.method === "POST") {
    const text = await req.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return deny(400, "请求体不是合法 JSON", "bad_json");
      }
    }
  }

  switch (path) {
    case "/":
      return healthPage(true, "接口：<code>/api/login</code>、<code>/api/session</code>、<code>/api/devices</code>");
    case "/api/health":
      return await health();
    case "/api/login":
      return req.method === "POST" ? await doLogin(body, ip, ua) : deny(405, "用 POST", "method");
    case "/api/session":
      return req.method === "POST" ? await doSession(body, ua) : deny(405, "用 POST", "method");
    case "/api/logout":
      return req.method === "POST" ? await doLogout(body, ua) : deny(405, "用 POST", "method");
    case "/api/devices":
      return req.method === "POST" ? await doDevices(body, ua) : deny(405, "用 POST", "method");
    case "/api/devices/kick":
      return req.method === "POST" ? await doKick(body, ua) : deny(405, "用 POST", "method");
    case "/api/admin/purge":
      return req.method === "POST" ? await doPurge(body) : deny(405, "用 POST", "method");
    case "/api/admin/seed":
      if (req.method !== "POST") return deny(405, "用 POST", "method");
      if (!ADMIN_TOKEN || String(body?.adminToken ?? "").trim() !== ADMIN_TOKEN) {
        return deny(403, "管理令牌不对", "forbidden");
      }
      return json({ ok: true, seeded: await saveUsers() });
    default:
      return deny(404, "没有这个接口", "not_found");
  }
}

if (import.meta.main) {
  // 冷启动时顺手把 env 里的账号写进 KV（失败也不影响运行）
  try {
    if (usersFromEnv().length) await saveUsers();
  } catch { /* 忽略 */ }
  // 本地测试时用 PORT 指定端口；Deno Deploy 上不设 PORT，交给平台
  const portEnv = (Deno.env.get("PORT") ?? "").trim();
  const opts: any = portEnv ? { port: Number(portEnv) } : {};
  (Deno as any).serve(opts, (req: Request) => handle(req));
}
