# 鉴权服务（cloud/）

餐饮日报的**登录 + 设备名额**后端。站点本体是纯静态页面（GitHub Pages / APK），
没法校验密码，也没法记住「这个账号已经在几台设备上登录」——所以把这两件事
放到这个约 500 行的单文件服务里。

- 代码：`cloud/main.ts`（零依赖，只需要 Deno 自带的 KV）
- 部署：Deno Deploy 免费版（每月 100 万次请求、1 GiB KV，个人用绰绰有余）
- 访问：`https://xxx.deno.dev`，国内可直连（不需要代理）
- 账号：不存明文，只认 `USERS_JSON` 环境变量里的 PBKDF2 哈希（就是本机
  `config/users.json` 的原文），和本机 `server.py` 用的是同一套哈希

## 一、部署（约 5 分钟，全在浏览器里点）

1. 打开 <https://console.deno.com>，用 **GitHub 账号**登录，建一个 organization
   （slug 例如 `canyin`，名字建了不好改，随手起一个就行）。
2. 先把这个仓库推上去（本机执行，复用 git 里已保存的 GitHub 凭据）：
   ```powershell
   python tools\publish_auth_service.py
   ```
   它会建/更新仓库 **`nfalyhl/canyin-auth`**，内容就是 `main.ts` + `deno.json`。
3. 在 Deno Deploy 里 **Databases → Provision Database → Deno KV**，
   slug 填 `canyin-kv`（免费）。
4. **+ New App** → 选 `canyin-auth` 仓库 → Build 配置里：
   - Runtime：**Dynamic**
   - Dynamic Entrypoint：**`main.ts`**
   - **Dynamic arguments：`--unstable-kv`** ← 不能省！Deno KV 目前仍是
     unstable API，不带这个参数启动，服务会直接告诉你「没有 Deno.openKv」
   - Install / Build command：**留空**
5. 打开这个 App 的 **Databases** 标签 → **Attach Database** → 选 `canyin-kv`。
6. **环境变量**（App → Settings → Environment Variables，Production 和 Development 都勾上）：

   | 变量 | 必填 | 说明 |
   | --- | --- | --- |
   | `USERS_JSON` | ✅ | 账号哈希。本机跑 `python tools\auth_admin.py emit` 生成，整段贴进去（选 Secret） |
   | `MAX_DEVICES` | 建议 | 每账号设备名额上限，默认 **3** |
   | `DEVICE_TTL_DAYS` | 可选 | 多少天没上线的设备自动释放名额，默认 30 |
   | `SESSION_DAYS` | 可选 | 登录有效期（天），默认 30 |
   | `ALLOW_ORIGIN` | 可选 | 允许的站点来源，建议填 `https://nfalyhl.github.io`；不填 = `*` |
   | `ADMIN_TOKEN` | 可选 | 填了才能用 `/api/admin/purge` 清空某账号的设备（自己把 3 台占满又都上不去时救命用） |

7. **Deploy**。拿到形如 `https://canyin-auth.xxx.deno.dev` 的地址。
8. 本机自检（这一步很关键，会直接告诉你哪里没配好）：
   ```powershell
   python tools\auth_admin.py test --base https://你的地址
   python tools\auth_admin.py test --base https://你的地址 --user YYQ --password 你的密码
   ```
9. 把地址写进站点，重新生成页面并发布：
   ```powershell
   python tools\auth_admin.py set-auth https://你的地址
   python daily.py --render-only
   python tools\publish_site.py
   ```

之后打开 <https://nfalyhl.github.io/canyin-daily/> 就是「先登录才能看」了。

## 二、接口（前端 auth.js 调的就是这些）

| 方法 | 路径 | 入参 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | — | 自检：KV 是否挂上、账号是否配了、上限多少 |
| POST | `/api/login` | `username` `password` `deviceId` `deviceName` `kick?` | 成功返回 `token` + 设备列表；名额满返回 403 `device_limit` |
| POST | `/api/session` | `token` | 校验登录态（顺带心跳） |
| POST | `/api/logout` | `token` | 退出并**释放这台设备的名额** |
| POST | `/api/devices` | `token` | 列出该账号在线的设备 |
| POST | `/api/devices/kick` | `token` `deviceId` | 把某台设备踢下线（腾名额） |
| POST | `/api/admin/purge` | `adminToken` `user` | 清空某账号全部设备（需要 `ADMIN_TOKEN`） |

`token` 是随机的 24 字节，服务端只存它的 SHA-256；token 绑定了设备号，
**设备被踢下线后 token 立刻失效**。

## 三、设备名额是怎么算的

- 登录时按 `deviceId`（浏览器 localStorage 里的一串 UUID）登记；
- 名额满了怎么办？服务端**不会偷偷顶掉老设备**，而是返回 403 + 设备列表，
  页面上让用户自己选一台「下线并登录」（`kick` 参数）；
- 在设备上点「退出」= 立刻释放名额；
- 超过 `DEVICE_TTL_DAYS` 没上线的设备自动释放名额，不会永久占位；
- 手机上清缓存/换浏览器 = 换了一个 `deviceId`，会占用一个新名额（正常现象）。

## 四、要注意的边界

1. **门禁保护的是「入口」，不是「内容」**。站点正文是静态 HTML/JSON，
   懂技术的人直接拉 `data/digest-*.json` 仍能看到内容。要真正锁死内容，
   得把正文也搬到后端（登录后从服务端取数据）——需要的话可以再做一版。
2. 用户名/密码在群里或聊天里出现过，**建议尽快改**：
   `python tools\setup_users.py --passwd YYQ 新密码` → 再 `emit` → 更新环境变量 → 重新部署。
3. 服务挂掉或网络不通时，页面会提示「连不上鉴权服务」并让用户重试，
   **不会**因为连不上就放行。
4. 免费额度用超了 Deno 会限流（不是扣钱，除非你主动升 Pro）。
5. 这个服务只管登录识别，不代理任何内容、不存任何资讯数据。

## 五、本地跑一下（可选，需要有 Deno）

```powershell
cd cloud
$env:USERS_JSON = (python ..\tools\auth_admin.py emit | Select-Object -Last 3 | Select-Object -First 1)
deno run --unstable-kv --allow-net --allow-env --allow-read --allow-write main.ts
```

跑起来后另开一个窗口自检：

```powershell
python ..\tools\auth_admin.py test --base http://127.0.0.1:8000
```
