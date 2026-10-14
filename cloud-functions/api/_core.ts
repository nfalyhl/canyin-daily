/* ==========================================================================
   餐饮日报 · 登录鉴权服务（EdgeOne Makers 云函数版）
   --------------------------------------------------------------------------
   与 cloud/main.ts（Deno Deploy 版）同源的业务逻辑，为 EdgeOne 做的适配：

     · Deno.openKv        → 控制台把 KV namespace 绑定为变量 canyin_kv，
                            函数里以全局变量（或 context.env.canyin_kv）访问
     · 数组 key ["dev",u] → 字符串 key（每段 hex 编码，EdgeOne KV 的 key
                            只允许数字/字母/下划线，中文用户名必须编码）
     · KV get 返回 .value → 直接返回值；对象一律 JSON 字符串存取
     · list 只有 keys     → 逐个 get 组装 {key,value}（kvListEntries）
     · CompressionStream  → node:zlib（云函数是 Node 运行时）
     · Deno.env 模块级    → 每请求 refreshEnv(context)（context.env 优先）
     · Deno.serve         → 由 [[default]].ts 的 onRequest 调 handle(context)

   环境变量（EdgeOne 控制台 → 项目 → 设置 → 环境变量）：
     USERS_JSON      必填。config/users.json 的原文（python tools\auth_admin.py emit）
     MAX_DEVICES     可选，默认 3
     DEVICE_TTL_DAYS 可选，默认 30
     SESSION_DAYS    可选，默认 30
     ALLOW_ORIGIN    可选，默认 *（站点与 API 同域时无所谓；github.io 站点跨域调时需要）
     APP_TITLE       可选，默认「餐饮日报」
     ADMIN_TOKEN     可选，填了才能用 /api/admin/* 管理接口
   ========================================================================== */

import { gzipSync, gunzipSync } from "node:zlib";

const VERSION = "1.1.0-edgeone";
const enc = new TextEncoder();

/* ---------------------------------------------- 环境（每请求刷新） --- */
let MAX_DEVICES = 3;
let DEVICE_TTL_DAYS = 30;
let SESSION_DAYS = 30;
let MAX_FAILS = 6;
let LOCK_SECONDS = 180;
let DIGEST_KEEP = 60;
let MAX_DIGEST_BYTES = 8 * 1024 * 1024;
let ALLOW_ORIGIN = "*";
let APP_TITLE = "餐饮日报";
let ADMIN_TOKEN = "";

function refreshEnv(ctx: any) {
  const e: Record<string, any> = { ...(process.env || {}), ...((ctx && ctx.env) || {}) };
  const s = (n: string, d = "") => String(e[n] ?? d).trim();
  const n = (v: string, d: number) => (v !== "" && Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : d);
  MAX_DEVICES = n(s("MAX_DEVICES"), 3);
  DEVICE_TTL_DAYS = n(s("DEVICE_TTL_DAYS"), 30);
  SESSION_DAYS = n(s("SESSION_DAYS"), 30);
  MAX_FAILS = n(s("MAX_FAILS"), 6);
  LOCK_SECONDS = n(s("LOCK_SECONDS"), 180);
  DIGEST_KEEP = n(s("DIGEST_KEEP"), 60);
  MAX_DIGEST_BYTES = n(s("MAX_DIGEST_BYTES"), 8 * 1024 * 1024);
  ALLOW_ORIGIN = s("ALLOW_ORIGIN", "*") || "*";
  APP_TITLE = s("APP_TITLE", "餐饮日报") || "餐饮日报";
  ADMIN_TOKEN = s("ADMIN_TOKEN");
}

/* ------------------------------------------------------------ 存储 ---
   2026-09-30 起 EdgeOne KV 数据面故障（读写全部 6 秒超时），同时官方文档写明
   「KV 存储的**运行环境：仅 Edge Functions**」，而本鉴权服务是 **Cloud Function**；
   「Blob 存储：Edge Functions / Cloud Functions」——走 Blob 才是官方支持的组合。

   所以这里把底层存储做成「**Blob 优先、KV 兜底**」的适配器：对外保持原来的
   put / get / delete / list 接口，上层的 kvSet / kvGet / kvDel / kvListEntries
   一行都不用改；Blob 用不了时自动退回控制台绑定的 KV（变量名 canyin_kv）。

   Blob 用法：getStore("name") 即用即得，无需控制台配置，命名空间首次使用自动创建。
   读一律用强一致（登录态/会话不能容忍 60 秒最终一致）。
   ------------------------------------------------------------------- */
const BLOB_STORE = "canyin-store";
let blobStore: any = null;
let blobTried = false;
let blobError = "";
let blobKind: "blob" | "kv" | "" = "";

// 控制台绑定 KV namespace 时变量名填 canyin_kv；代码里全局变量即绑定对象。
// 兜底也看 context.env.canyin_kv（不同版本的注入方式不同，两头都试）。
let kvCache: any = null;
let kvError = "";

/** 控制台绑定的 KV 对象（仅作兜底）。 */
function kvBinding(ctx?: any): any {
  if (kvCache) return kvCache;
  const g = globalThis as any;
  const k = g.canyin_kv || (ctx && ctx.env && ctx.env.canyin_kv) || null;
  if (k && typeof k.put === "function") {
    kvCache = k;
    kvError = "";
    return k;
  }
  kvError = k
    ? "canyin_kv 不是合法的 KV 对象（没有 put 方法）"
    : "KV 未绑定：请在 EdgeOne 控制台把 KV namespace 绑定到本项目，变量名填 canyin_kv";
  return null;
}

/** 选后端：Blob 优先（懒加载 + 真连一次探活），失败才退回 KV。 */
async function backend(): Promise<{ kind: "blob" | "kv"; api: any }> {
  if (!blobTried) {
    blobTried = true;
    try {
      // 注意：不能写包名 "@edgeone/pages-blob"——云函数构建产物里解析不到它
      // （实测 Cannot find package '@edgeone/pages-blob' imported from /var/user/index.mjs）。
      // 这里用的是**相对路径**引入的项目内联副本，会被一起打进产物。
      const mod: any = await import("./_pages_blob.js");
      const s = mod.getStore(BLOB_STORE);
      await s.get("__alive__", { type: "text", consistency: "strong" }); // 探活
      blobStore = s;
      blobKind = "blob";
      blobError = "";
    } catch (e: any) {
      blobStore = null;
      blobKind = "";
      blobError = `${e?.name || "Error"}: ${String(e?.message || e).slice(0, 200)}`;
    }
  }
  if (blobStore) return { kind: "blob", api: blobStore };
  const k = kvBinding();
  if (k) return { kind: "kv", api: k };
  throw new Error(`没有可用的存储后端（Blob → ${blobError || "未尝试"}；KV → ${kvError}）`);
}

/** 上层只认这个适配器，签名与原来的 KV 对象一致。 */
const storage: any = {
  async put(key: string, val: any) {
    const b = await backend();
    if (b.kind === "blob") return b.api.set(key, typeof val === "string" ? val : String(val));
    return b.api.put(key, val);
  },
  async get(key: string) {
    const b = await backend();
    if (b.kind === "blob") return await b.api.get(key, { type: "text", consistency: "strong" });
    return await b.api.get(key);
  },
  async delete(key: string) {
    const b = await backend();
    return b.api.delete(key);
  },
  async list(opts: { prefix?: string; limit?: number; cursor?: string }) {
    const b = await backend();
    if (b.kind !== "blob") return b.api.list(opts);
    const r = await b.api.list({
      prefix: opts?.prefix,
      limit: opts?.limit ?? 256,
      cursor: opts?.cursor,
      paginate: false,
      consistency: "strong",
    });
    const keys = (r?.blobs || []).map((x: any) => ({ key: x.key }));
    return { keys, cursor: r?.cursor, complete: !r?.cursor };
  },
};

function kvOf(_ctx?: any): any {
  return storage;
}

/** 存储后端现状（给 /api/health 自报用，方便判断到底走的哪条路）。 */
function storageInfo() {
  return { storage: blobKind || (blobTried ? "" : "lazy"), blobStore: BLOB_STORE, blobError, kvError };
}

/* Deno KV 数组 key → EdgeOne KV 字符串 key。
   每段 hex 编码（中文用户名/任意 deviceId 都安全），下划线连接。 */
function hx(s: string): string {
  const b = enc.encode(String(s ?? ""));
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function unhex(h: string): string {
  const out: number[] = [];
  for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
  return new TextDecoder().decode(new Uint8Array(out));
}

function kstr(key: (string | number)[]): string {
  return key.map((seg) => hx(String(seg))).join("_") || "_";
}

/* KV 超时守卫：KV 卡住时快速失败（否则整个请求会挂到网关 504） */
function kvGuard<T>(p: Promise<T>, label: string, ms = 6000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_res, rej) =>
      setTimeout(() => rej(new Error(`KV ${label} 超时（${ms}ms）`)), ms),
    ),
  ]);
}

/* 对象存取：EdgeOne KV 的 put 只收字符串/二进制，对象统一 JSON 序列化 */
async function kvSet(k: any, key: (string | number)[], val: unknown) {
  await kvGuard(k.put(kstr(key), JSON.stringify(val ?? null)), "put");
}

async function kvGet(k: any, key: (string | number)[], def: any = null) {
  const s = await kvGuard(k.get(kstr(key)), "get");
  if (s == null || s === "") return def;
  try {
    return JSON.parse(s);
  } catch {
    return def;
  }
}

async function kvDel(k: any, key: (string | number)[]) {
  await kvGuard(k.delete(kstr(key)), "delete");
}

/** 前缀遍历（带值）。EdgeOne 的 list 只回 keys，这里逐个 get 组装。 */
async function kvListEntries(
  k: any,
  prefix: (string | number)[],
): Promise<{ key: string[]; value: any }[]> {
  const p = prefix.map((seg) => hx(String(seg))).join("_") + "_";
  const out: { key: string[]; value: any }[] = [];
  let cursor: string | undefined = undefined;
  do {
    const r = await kvGuard(k.list({ prefix: p, limit: 256, ...(cursor ? { cursor } : {}) }), "list");
    for (const item of r.keys || []) {
      const key: string[] = String(item.key || "").slice(p.length).split("_").filter(Boolean).map(unhex);
      let value: any = null;
      try {
        const s = await k.get(item.key);
        value = s == null || s === "" ? null : JSON.parse(s);
      } catch {
        value = null;
      }
      out.push({ key, value });
    }
    cursor = r.complete ? undefined : r.cursor;
  } while (cursor);
  return out;
}

/* ------------------------------------------------------------ 小工具 --- */
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

/** 大响应在客户端支持 gzip 时压缩（node:zlib） */
function jsonMaybeGz(obj: unknown, status: number, req?: Request): Response {
  const text = JSON.stringify(obj);
  const ae = (req?.headers.get("accept-encoding") || "").toLowerCase();
  if (text.length > 4096 && ae.includes("gzip")) {
    try {
      const bytes = gzipSync(Buffer.from(text, "utf8"));
      return new Response(new Uint8Array(bytes), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Encoding": "gzip",
          "Cache-Control": "no-store",
          ...corsHeaders(),
        },
      });
    } catch { /* 压缩失败走原文 */ }
  }
  return json(obj, status);
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

/* ------------------------------------------------------------- 账号 --- */
type UserRec = { username: string; salt: string; hash: string; iterations: number };

function usersFromEnv(): UserRec[] {
  const e: Record<string, any> = { ...(process.env || {}) };
  const raw = String(e.USERS_JSON ?? "").trim();
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
  const k = kvOf();
  if (!k) return 0;
  const list = usersFromEnv();
  for (const u of list) await kvSet(k, ["user", u.username], u);
  await kvSet(k, ["meta", "seeded"], { at: nowSec(), count: list.length });
  return list.length;
}

/** 账号来源：env 里的 USERS_JSON 优先；没有就退回 KV 里已存过的 */
async function findUser(username: string): Promise<UserRec | null> {
  const fromEnv = usersFromEnv();
  if (fromEnv.length) {
    const hit = fromEnv.find((u) => u.username === username);
    if (hit) return hit;
  }
  const k = kvOf();
  if (!k) return null;
  return (await kvGet(k, ["user", username])) || null;
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

/* --------------------------------------------------- 设备（名额管理） --- */
type DevRec = {
  id: string;
  name: string;
  ua: string;
  ip: string;
  first: number;
  last: number;
};

async function listDevices(user: string, prune = true): Promise<DevRec[]> {
  const k = kvOf();
  if (!k) return [];
  const out: DevRec[] = [];
  const cutoff = nowSec() - DEVICE_TTL_DAYS * 86400;
  for (const e of await kvListEntries(k, ["dev", user])) {
    const d = e.value as DevRec;
    if (!d) continue;
    if (prune && (d.last || 0) < cutoff) {
      await kvDel(k, ["dev", user, d.id || ""]);
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
  const k = kvOf();
  if (!k) return;
  await kvDel(k, ["dev", user, deviceId]);
}

/* ------------------------------------------------------------- 限流 --- */
async function failState(key: (string | number)[]): Promise<{ n: number; until: number }> {
  const k = kvOf();
  if (!k) return { n: 0, until: 0 };
  return (await kvGet(k, key)) || { n: 0, until: 0 };
}

async function bumpFail(key: (string | number)[], reset = false) {
  const k = kvOf();
  if (!k) return;
  if (reset) {
    await kvDel(k, key);
    return;
  }
  const cur = await failState(key);
  const n = (cur.n || 0) + 1;
  const val = n >= MAX_FAILS ? { n: 0, until: nowSec() + LOCK_SECONDS } : { n, until: cur.until || 0 };
  await kvSet(k, key, val);
}

/* ------------------------------------------------------------ 业务 --- */
async function doLogin(body: any, ip: string, ua: string): Promise<Response> {
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  const deviceId = deviceIdOf(body?.deviceId, ip, ua);
  const deviceName = String(body?.deviceName ?? "").slice(0, 60);
  const kick = String(body?.kick ?? "").trim();

  if (!username || !password) return deny(400, "用户名和密码都要填", "missing");

  const k = kvOf();
  if (!k) return deny(503, "鉴权服务还没绑定 KV，请在 EdgeOne 控制台绑定（变量名 canyin_kv）", "no_kv");

  const users = usersFromEnv();
  if (!users.length && (await kvGet(k, ["user", username])) === null) {
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

  const devices = await listDevices(username);
  const mine = devices.find((d) => d.id === deviceId);

  if (!mine && devices.length >= MAX_DEVICES) {
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
  await kvSet(k, ["tok", await sha256Hex(token)], { user: username, deviceId, exp });

  const prev = (await kvGet(k, ["dev", username, deviceId])) as DevRec | null;
  const rec: DevRec = {
    id: deviceId,
    name: deviceName || prev?.name || "未知设备",
    ua: ua.slice(0, 160),
    ip,
    first: prev?.first || now,
    last: now,
  };
  await kvSet(k, ["dev", username, deviceId], rec);

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
  const k = kvOf();
  if (!k) return null;
  const h = await sha256Hex(token);
  const rec = (await kvGet(k, ["tok", h])) as { user: string; deviceId: string; exp: number } | null;
  if (!rec) return null;
  if (!rec.exp || rec.exp < nowSec()) {
    await kvDel(k, ["tok", h]);
    return null;
  }
  const d = (await kvGet(k, ["dev", rec.user, rec.deviceId])) as DevRec | null;
  if (!d) {
    // 设备被踢下线（或名额过期）→ token 一起作废
    await kvDel(k, ["tok", h]);
    return null;
  }
  if (touch && nowSec() - (d.last || 0) > 600) {
    d.last = nowSec();
    d.ua = ua.slice(0, 160) || d.ua;
    await kvSet(k, ["dev", rec.user, rec.deviceId], d);
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
  const k = kvOf();
  if (k && token) await kvDel(k, ["tok", await sha256Hex(token)]);
  if (s) await dropDevice(s.user, s.deviceId); // 退出即释放名额
  return json({ ok: true });
}

async function doPurge(body: any): Promise<Response> {
  if (!ADMIN_TOKEN) return deny(404, "未开启管理接口（需要设 ADMIN_TOKEN 环境变量）", "disabled");
  const given = String(body?.adminToken ?? "").trim();
  if (given !== ADMIN_TOKEN) return deny(403, "管理令牌不对", "forbidden");
  const user = String(body?.user ?? "").trim();
  if (!user) return deny(400, "要指定 username", "missing");
  const k = kvOf();
  if (!k) return deny(503, "KV 不可用", "no_kv");

  let devices = 0;
  for (const e of await kvListEntries(k, ["dev", user])) {
    await kvDel(k, ["dev", user, (e.value as DevRec)?.id || ""]);
    devices++;
  }
  let tokens = 0;
  for (const e of await kvListEntries(k, ["tok"])) {
    if ((e.value as any)?.user === user) {
      await kvDel(k, e.key);
      tokens++;
    }
  }
  let locks = 0;
  if (body?.clearLocks !== false) {
    for (const e of await kvListEntries(k, ["fail"])) {
      await kvDel(k, e.key);
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
<p>状态：<b class="ok">${ok ? "运行中 ✓" : "缺少配置 ✗"}</b>　版本 <code>${VERSION}</code>（EdgeOne）</p>
<p>${extra}</p></div></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() } },
  );
}

async function health(): Promise<Response> {
  const k = kvOf();
  const users = usersFromEnv();
  const info = storageInfo();
  const problems: string[] = [];
  let stored = 0;
  let digestDatesCount = 0;
  let latestDigest = "";
  let storageError = "";
  // 健康检查本身必须永远能回答：存储读失败也把错误当结果返回，而不是让请求 5xx。
  try {
    if (!users.length) stored = (await kvListEntries(k, ["user"])).length;
    digestDatesCount = (await digestDates(k)).length;
    const idx = (await kvGet(k, ["digestIndex"])) as any;
    latestDigest = (idx && idx.latest) || "";
  } catch (e: any) {
    storageError = `${e?.name || "Error"}: ${String(e?.message || e).slice(0, 200)}`;
    problems.push("存储读失败：" + storageError);
  }
  const accountCount = users.length || stored;
  if (info.storage !== "blob" && info.storage !== "kv") {
    problems.push(`没有可用的存储后端（Blob → ${info.blobError || "未尝试"}；KV → ${info.kvError || "未绑定"}）`);
  }
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
    digestIssues: digestDatesCount,
    latestDigest,
    protectContent: true,
    kv: !!k,
    storage: info.storage,
    blobStore: info.blobStore,
    blobError: info.blobError,
    storageError,
    problems,
    time: fmt(nowSec()),
  });
}

/* --------------------------------------------- 日报正文（登录后可见） --- */
// 彻底版：公网页面里不内联数据，日报 JSON 存在 KV，只有带合法 token 的请求
// 才拿得到。上传靠带 ADMIN_TOKEN 的管理接口（tools\push_digest.py）。
// EdgeOne KV 单值上限 25 MB，理论上整期直存都够；但为了和 Deno 版同一套
// 数据格式（迁移时两边可互导），仍按 gzip+分片存。

const KV_CHUNK = 48 * 1024;

function gzipToBase64(text: string): string {
  return gzipSync(Buffer.from(text, "utf8")).toString("base64");
}

function gunzipFromBase64(b64: string): string {
  return gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
}

async function putDigest(k: any, date: string, obj: unknown): Promise<number> {
  const payload = gzipToBase64(JSON.stringify(obj));
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += KV_CHUNK) chunks.push(payload.slice(i, i + KV_CHUNK));
  const old = (await kvGet(k, ["digestMeta", date])) as any;
  const oldN = Number(old?.chunks || 0);
  for (let i = 0; i < chunks.length; i++) await kvSet(k, ["digestPart", date, i], chunks[i]);
  for (let i = chunks.length; i < oldN; i++) await kvDel(k, ["digestPart", date, i]);
  await kvSet(k, ["digestMeta", date], { chunks: chunks.length, enc: "gzip+base64", at: nowSec() });
  return payload.length;
}

async function getDigest(k: any, date: string): Promise<unknown | null> {
  const meta = (await kvGet(k, ["digestMeta", date])) as any;
  if (!meta) return null;
  let payload = "";
  for (let i = 0; i < Number(meta.chunks || 0); i++) {
    const part = (await kvGet(k, ["digestPart", date, i])) as string | null;
    if (part == null) return null;
    payload += part;
  }
  try {
    return JSON.parse(gunzipFromBase64(payload));
  } catch {
    return null;
  }
}

async function dropDigest(k: any, date: string) {
  const meta = (await kvGet(k, ["digestMeta", date])) as any;
  for (let i = 0; i < Number(meta?.chunks || 0); i++) await kvDel(k, ["digestPart", date, i]);
  await kvDel(k, ["digestMeta", date]);
}

async function digestDates(k: any): Promise<string[]> {
  const out: string[] = [];
  for (const e of await kvListEntries(k, ["digestMeta"])) {
    const d = e.key[0]; // prefix 后第一段就是 date（hex 解码后）
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) out.push(d);
  }
  return out.sort();
}

async function doAdminPutDigest(body: any): Promise<Response> {
  if (!ADMIN_TOKEN) return deny(404, "未开启管理接口（需要 ADMIN_TOKEN 环境变量）", "disabled");
  if (String(body?.adminToken ?? "").trim() !== ADMIN_TOKEN) return deny(403, "管理令牌不对", "forbidden");
  const date = String(body?.date ?? "").trim();
  const digest = body?.digest;
  const index = body?.index;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !digest || typeof digest !== "object") {
    return deny(400, "要带上 date(YYYY-MM-DD) 和 digest 对象", "missing");
  }
  const k = kvOf();
  if (!k) return deny(503, "KV 不可用", "no_kv");
  const bytes = JSON.stringify(digest).length;
  if (bytes > MAX_DIGEST_BYTES) return deny(413, `这一期数据太大（${bytes} 字节）`, "too_large");
  let stored = 0;
  try {
    stored = await putDigest(k, date, digest);
  } catch (e) {
    return deny(500, `写入 KV 失败：${String(e).slice(0, 160)}`, "kv_write");
  }
  if (index && typeof index === "object") await kvSet(k, ["digestIndex"], index);

  const dates = await digestDates(k);
  const drop = dates.sort().reverse().slice(DIGEST_KEEP);
  for (const d of drop) await dropDigest(k, d);
  return json({ ok: true, date, bytes, stored, kept: dates.length - drop.length, dropped: drop.length });
}

async function doGetDigest(body: any, ua: string, req?: Request): Promise<Response> {
  const s = await sessionOf(body, ua, false);
  if (!s) return deny(401, "登录已失效，请重新登录", "unauthorized");
  const k = kvOf();
  if (!k) return deny(503, "KV 不可用", "no_kv");
  const idx = ((await kvGet(k, ["digestIndex"])) as any) || null;
  const want = String(body?.date ?? "").trim();
  if (want) {
    const one = await getDigest(k, want);
    if (!one) return deny(404, "没有这一期的数据", "no_digest");
    return jsonMaybeGz({ ok: true, index: idx, digest: one }, 200, req);
  }
  const latest = (idx && idx.latest) || "";
  const one = latest ? await getDigest(k, latest) : null;
  if (!one) {
    return deny(404, "服务端还没有日报数据：先在本机跑 python tools\\push_digest.py 上传", "no_digest");
  }
  return jsonMaybeGz({ ok: true, index: idx, digest: one }, 200, req);
}

/* ------------------------------------------------------------ 路由 --- */
let seeded = false;

/* ======================= 小红书采集：云端转发（方案 A） =======================
   采集只能跑在机主的电脑上（真实浏览器 + 家宽 IP）；云端只做中转：
     · 网页（需站点登录 token）→ state 看状态与二维码、notes 看结果、ask 下指令
     · 本机 tools/xhs_agent.py → agent 上报状态/二维码/结果，并领取指令
   鉴权：网页走 token（同日报门禁），采集机走 ADMIN_TOKEN。 */

const XHS_KEY_STATE: (string | number)[] = ["xhs", "state"];
const XHS_KEY_NOTES: (string | number)[] = ["xhs", "notes"];
const XHS_KEY_CMD: (string | number)[] = ["xhs", "cmd"];
const XHS_CMDS = new Set(["login", "logout", "collect"]);

/** 网页侧：必须带合法 token（和日报同一套门禁） */
async function xhsUser(body: any, ua: string): Promise<string | null> {
  const s = await sessionOf(body, ua, true);
  return s ? s.user : null;
}

/** 公开只读：把采集机当前的登录二维码透出来。

    为什么要公开（2026-10-01 改）：这个码本来就是给「访客用手机扫」的（产品目标就是
    让访客登录小红书），而要求访客**先登录本站**才能拿到码，等于在手机上加了一道没必要
    的门 —— 实测手机上就是这个原因看不到码（页面把二维码整块隐藏了）。

    这里只露出二维码本身与状态；下单（ask）、结果（notes）仍然要站点登录。
    存储抱动时不要 500，宁可返回空码。 */
async function xhsPublicQr() {
  const k = kvOf();
  let st: any = null;
  try {
    st = ((await kvGet(k, XHS_KEY_STATE)) as any) || null;
  } catch {
    st = null;
  }
  const s = st || {};
  return json({
    ok: true,
    loggedIn: !!s.loggedIn,
    qr: s.qr || "",
    qrExpired: !!s.qrExpired,
    loginState: s.loginState || "",
    loginNote: s.loginNote || "",
    agent: s.agent || "",
    agentAt: s.agentAt || "",
    count: s.count || 0,
    keywords: s.keywords || [],
    lastCollectAt: s.lastCollectAt || "",
  });
}

async function doXhsState(body: any, ua: string) {
  const user = await xhsUser(body, ua);
  if (!user) return deny(401, "先登录", "unauthorized");
  const k = kvOf();
  if (!k) return deny(503, "KV 不可用", "no_kv");
  const st = ((await kvGet(k, XHS_KEY_STATE)) as any) || null;
  const cmd = ((await kvGet(k, XHS_KEY_CMD)) as any) || null;
  return json({
    ok: true,
    user,
    loggedIn: !!(st && st.loggedIn),
    state: st,
    pending: cmd && !cmd.done ? cmd.action : "",
    at: nowSec(),
  });
}

async function doXhsNotes(body: any, ua: string) {
  const user = await xhsUser(body, ua);
  if (!user) return deny(401, "先登录", "unauthorized");
  const k = kvOf();
  if (!k) return deny(503, "KV 不可用", "no_kv");
  const rec = (await kvGet(k, XHS_KEY_NOTES)) as any;
  return json({ ok: true, items: (rec && rec.items) || [], meta: (rec && rec.meta) || null });
}

async function doXhsAsk(body: any, ua: string) {
  const action = String(body?.action ?? "").trim();
  // 登录二维码是给访客扫的，所以「下单 login」不需要本站登录（2026-10-01 放宽，
  // 否则手机上要先登录本站才能生成码 —— 正是这个把手机用户挡在外面）。
  const user = await xhsUser(body, ua);
  if (!user && action !== "login") return deny(401, "先登录", "unauthorized");
  if (!XHS_CMDS.has(action)) return deny(400, "action 只能是 login/logout/collect", "bad_action");
  const k = kvOf();
  if (!k) return deny(503, "KV 不可用", "no_kv");
  const st = ((await kvGet(k, XHS_KEY_STATE)) as any) || {};
  if (action === "login" && st.loggedIn) {
    return json({ ok: true, skipped: true, message: "已经有登录态了，不需要重新扫码" });
  }
  if (action === "collect" && !st.loggedIn) {
    return deny(409, "还没有登录态，先扫码登录", "need_login");
  }
  const id = (await sha256Hex(`${action}|${nowSec()}|${Math.random()}`)).slice(0, 12);
  const cmd = { id, action, by: user || "访客", at: nowSec(), delivered: false, done: false };
  await kvSet(k, XHS_KEY_CMD, cmd);
  return json({ ok: true, cmd });
}

async function doXhsAgent(body: any) {
  const given = String(body?.adminToken ?? "").trim();
  // 除了管理令牌，还接受一个**派生**的采集机令牌：
  //   agentToken = sha256("xhs-agent|" + ADMIN_TOKEN) 的前 32 位
  // 目的：「借别人的电脑当采集机」时发出去的凭据，只能用于 /api/xhs/agent 这一个接口，
  // 拿不到管理权限（推送/删除日报、看用户记录都不行）。
  const derived = ADMIN_TOKEN ? (await sha256Hex("xhs-agent|" + ADMIN_TOKEN)).slice(0, 32) : "";
  if (!ADMIN_TOKEN || (given !== ADMIN_TOKEN && given !== derived)) {
    return deny(403, "采集机令牌不对", "forbidden");
  }
  const k = kvOf();
  if (!k) return deny(503, "KV 不可用", "no_kv");
  if (body?.state) await kvSet(k, XHS_KEY_STATE, { ...body.state, at: nowSec() });
  if (Array.isArray(body?.notes)) {
    await kvSet(k, XHS_KEY_NOTES, { items: body.notes, meta: body.notesMeta || null, at: nowSec() });
  }
  let cmd = (await kvGet(k, XHS_KEY_CMD)) as any;
  const stale = !!(cmd && !cmd.done && cmd.delivered &&
    nowSec() - Number(cmd.deliveredAt || 0) > 90);
  if (cmd && body?.cmdDone && String(body.cmdDone) === String(cmd.id)) {
    await kvSet(k, XHS_KEY_CMD, { ...cmd, done: true, doneAt: nowSec() });
    cmd = null;
  } else if (cmd && !cmd.done && (!cmd.delivered || stale)) {
    // 送达标记的语义是「至少送到一次」：响应丢了就等 90 秒后重发自愈。
    // 代理侧对同一种动作有「已经在跑就跳过」的锁，所以重发不会真的重复采集。
    await kvSet(k, XHS_KEY_CMD, { ...cmd, delivered: true, deliveredAt: nowSec() });
  } else {
    cmd = null;
  }
  return json({ ok: true, cmd, at: nowSec() });
}

export async function handle(ctx: any): Promise<Response> {
  refreshEnv(ctx);
  const req: Request = ctx.request;
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const ua = req.headers.get("user-agent") || "";
  const ip = String(ctx?.clientIp || "") || clientIp(req);

  // 冷启动种子：把 env 里的账号写进 KV（失败/卡住都不影响运行）
  // 注意：KV 抖动时这里不能无限等，否则所有 /api/* 都会跟着 504
  if (!seeded) {
    seeded = true;
    try {
      if (usersFromEnv().length) {
        await Promise.race([
          saveUsers(),
          new Promise((_r, rej) => setTimeout(() => rej(new Error("seed timeout")), 3000)),
        ]);
      }
    } catch { /* 忽略 */ }
  }

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
    case "/api/digest":
      return req.method === "POST" ? await doGetDigest(body, ua, req) : deny(405, "用 POST", "method");
    case "/api/admin/digest":
      return req.method === "POST" ? await doAdminPutDigest(body) : deny(405, "用 POST", "method");
    case "/api/admin/purge":
      return req.method === "POST" ? await doPurge(body) : deny(405, "用 POST", "method");
    case "/api/admin/seed":
      if (req.method !== "POST") return deny(405, "用 POST", "method");
      if (!ADMIN_TOKEN || String(body?.adminToken ?? "").trim() !== ADMIN_TOKEN) {
        return deny(403, "管理令牌不对", "forbidden");
      }
      return json({ ok: true, seeded: await saveUsers() });

    /* ---------------- 小红书采集（方案 A：云端转发） ---------------- */
    case "/api/xhs/qr":
      // 公开只读：二维码 + 采集机状态（手机上不登录本站也能扫码）
      return await xhsPublicQr();
    case "/api/xhs/state":
      return req.method === "POST" ? await doXhsState(body, ua) : deny(405, "用 POST", "method");
    case "/api/xhs/notes":
      return req.method === "POST" ? await doXhsNotes(body, ua) : deny(405, "用 POST", "method");
    case "/api/xhs/ask":
      return req.method === "POST" ? await doXhsAsk(body, ua) : deny(405, "用 POST", "method");
    case "/api/xhs/agent":
      return req.method === "POST" ? await doXhsAgent(body) : deny(405, "用 POST", "method");
    default:
      if (path.startsWith("/api/")) return deny(404, "没有这个接口", "not_found");
      // /api 之外不归这个函数管（理论上不会走到）
      return healthPage(true, "EdgeOne 云函数版鉴权服务");
  }
}
