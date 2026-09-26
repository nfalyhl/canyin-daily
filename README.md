# 餐饮日报 · 每日餐饮行业情报

采集 **20 个**公开信息源（内网 10 + 外网 10），分成**内网 / 外网两个大板块**，
按 **产品上新 / 行业趋势 / 品牌动作** 归类，提炼「今日要点」，
并用**饼图**展示品类市场格局（资讯热度 × 门店规模 综合占比）。
带**登录鉴权**、**外网节点（代理）可在网页里改**、**外网译文可选语言**。

- 纯 Python 标准库，**不需要 pip 安装任何依赖**
- 采集失败自动跳过，单个源卡住不影响整体（全局超时兜底）
- 每个源可单独标记是否需要代理；海外源实测大多可直连
- 没配大模型 Key 时用规则式提炼，**不会伪造模型输出**
- 另有安卓 APK（离线可用）与 iOS 工程（TestFlight）

---

## 一、快速开始

```powershell
cd C:\Users\Lenovo\Desktop\代码\canyin-daily

python daily.py            # 1. 采集（首次先跑一次，生成数据）
python server.py           # 2. 启动带登录的网站
# 浏览器打开 http://127.0.0.1:8848/ ，用账号登录
```

**首次使用要先建账号**（只存 PBKDF2 哈希，不存明文）：

```powershell
python tools\setup_users.py --add YYQ 你的密码
python tools\setup_users.py --add 管理员 你的密码
python tools\setup_users.py --list
```

生成物：

```
public\index.html                  ← 日报页面（需登录）
public\login.html                  ← 登录页（公开）
public\offline.html                ← 单文件版（全内联，供 App / 离线阅读）
public\data\digest-YYYY-MM-DD.json ← 结构化数据（含内网/外网两套统计与译文）
public\data\index.json             ← 往期目录
```

### daily.py 常用参数

| 参数 | 说明 |
| --- | --- |
| `--fast` | 只抓列表不抓正文，约 8 秒出结果（要点会少一些） |
| `--date 2026-09-25` | 指定写入日期，用于补跑某一天 |
| `--only hongcan,jiemian` | 只跑指定信息源，便于调试 |
| `--proxy http://127.0.0.1:7897` | 临时指定外网节点（优先于网页里保存的） |
| `--translate zh` | 采集后顺带把外网内容翻成指定语言（可 `zh,ja`） |
| `--render-only` | **不采集**，只用已有数据重算 + 重新生成页面（改前端时秒出） |
| `--llm` | 调用大模型润色要点（见第九节） |

---

## 二、每天自动跑

```powershell
.\setup-task.ps1                 # 注册计划任务，默认每天 07:30
.\setup-task.ps1 -At 08:15       # 改时间
.\setup-task.ps1 -Status         # 看状态和下次运行时间
.\setup-task.ps1 -RunNow         # 立刻跑一次
.\setup-task.ps1 -Remove         # 取消
```

计划任务调用 `run-daily.ps1`，日志写在 `logs\daily-YYYY-MM.log`。
默认「用户登录时运行」；要关机也照跑，在「任务计划程序」里改成
「不管用户是否登录都要运行」并填 Windows 密码。

---

## 三、账号与登录

网站是**登录后才能访问**的：未登录时页面、数据文件、接口全部拦住（302 跳登录页 / 401）。

- 账号只存 **PBKDF2-SHA256 哈希 + 随机盐**（`config/users.json`，权限 600）
- 会话用 **HMAC 签名 Cookie**（默认 30 天，且绑定设备），服务重启不掉登录
- **每个账号最多 3 台设备同时在线**（`MAX_DEVICES`，见下）：名额满了不会偷偷顶掉老设备，
  而是把在线设备列出来，让你自己选一台「下线并登录」；在设备上点「退出」会立刻释放名额；
  30 天没上过线的设备自动释放（`DEVICE_TTL_DAYS`）
- 连续 6 次密码错误，该 IP 锁 3 分钟
- 目前两个账号：`YYQ`、`管理员`（密码是创建时你设的）
- 设备记录：本机版在 `config/devices.json`，公网静态版在鉴权服务的 KV 里（见第十二节）
- 界面上顶栏的「设备」按钮可以随时看「哪些设备在线」并下线其中任意一台

```powershell
python tools\setup_users.py --add 用户名 密码      # 新增
python tools\setup_users.py --passwd 用户名 新密码  # 改密
python tools\setup_users.py --del 用户名            # 删除
python tools\setup_users.py --list                 # 列出
python tools\test_server.py                        # 鉴权自检（14 项）
python tools\test_devices.py                       # 设备名额自检（用临时账号，不占你的名额）
```

密钥 `config/secret.key` **不要删**（删了所有人要重新登录）。

> ⚠️ 本机登录保护只在 `server.py` 跑起来时生效。静态托管（GitHub Pages）上没有后端，
> 那里的登录靠**独立的鉴权服务**兜底，见第十二节。

---

## 四、内网 / 外网两个大板块

顶部是大号分段控件：**内网 40 条 · 国内信息源** ｜ **外网 40 条 · 海外信息源**。
每个板块有**各自独立的一整套数据**（不是过滤出来的视图）：

| | 内网 | 外网 |
| --- | --- | --- |
| 今日要点 | 政策/食安/供应链为主 | 咖啡、快餐、资本动作为主 |
| 品类格局 | 食品供应链 23.6% · 茶饮 22.5% · 中式快餐 16.9% | 咖啡 25.8% · 食品供应链 16.1% · 西式快餐 16.1% |
| 筛选 | 板块 × 品类 叠加 | 板块 × 品类 叠加 + 语言 |

数量由配额保证均衡（`sources.json` 里的 `global_quota`，默认内外各 50%）。

---

## 五、网页构成（电脑端全屏）

```
┌─────────────────────────────────────────────────────────────────────┐
│ 餐饮日报 DAILY PASS  【内网 40 条】【外网 40 条】 日期·期号 账号/工具 │
├─────────────────────────────────────────────────────────────────────┤
│ 外网译文  原文 中文 繁體 English 日本語 한국어      翻译状态/动作按钮 │
├─────────────────────────────────────────────────────────────────────┤
│ 外网 · 今日要点（自适应多列卡片，译文带「译」标记）                   │
├───────────────┬───────────────────────────┬───────────────────────┤
│ 外网节点       │ 资讯流（自适应多列票据卡）  │ 外网 · 市场格局（饼图）│
│ 翻译服务       │  · 按板块自动分组           │ 品牌提及 TOP（条形）   │
│ 板块          │  · 卡片带品牌标签           │ 已披露规模（门店/营收）│
│ 品类（带占比）│                           │ 计算公式说明           │
│ 今日高频词     │                           │                       │
└───────────────┴───────────────────────────┴───────────────────────┘
```

- 板块内可按 **板块 × 品类** 叠加筛选，点左栏即时报文流重算
- 外网板块顶部有**语言选择条**
- 左侧「外网节点」「翻译服务」两张卡只在**外网板块**出现
- 浅色/深色（**白班 / 夜班**）随系统，也可手动切换，连状态栏颜色一起切
- 饼图、品牌榜、占比条都是页面内生成的纯 SVG，**无任何图表库依赖**
- 窄屏（<1180px）自动折叠成单栏，安卓 APK 也不会散

---

## 六、外网节点（代理）

外网板块左栏有「外网节点」卡片，直接在网页上改：

1. 填 `http://127.0.0.1:7897` 这样的地址 → **保存**
2. **测试**：用这个节点拉 QSR / Restaurant Dive / Retail Dive，逐条报告成/失败
3. **用该节点重新采集**：后台跑一次 daily.py，卡片里实时滚日志，完成后自动刷新

- 优先级：`--proxy` 命令行 > 网页里保存的节点（存 `config/settings.json`）
- 只有标记 `needs_proxy` 的海外源走它，其余外网源直连，**所以不填节点也能用**

---

## 七、翻译（外网译文）

外网板块顶部选语言：**原文 / 中文 / 繁體 / English / 日本語 / 한국어**。
选中文后，标题、要点、今日要点全部变成译文，票据上多一个「译」标记
（点标题仍可去原文核对）。

**两种翻译服务，在网页左栏切换：**

| 服务 | 要不要 Key | 说明 |
| --- | --- | --- |
| 免费接口（MyMemory） | 不需要，默认 | 实测你这条网络可用，中/繁/英/日/韩都能翻；质量一般，有每日额度 |
| 大模型 | 需要，任意 OpenAI 兼容接口 | 质量明显更好，可在网页里填 Key / Base URL / 模型（如 DeepSeek） |

配置项（都在 `config/settings.json`）：

- `provider`：`mymemory`（默认）或 `llm`
- `scope`：`all`（标题+要点）或 `title`（仅标题，省额度）
- `base_url` / `model` / `api_key`：选大模型时才用；
  **Key 只存服务端，接口永远不回传它**（只回 `has_key` 和掩码提示）

### 配 DeepSeek Key 的具体步骤

1. 打开 https://platform.deepseek.com/ 注册/登录 → 先**充值**（建议先充 10–20 元，无余额无法调用）
2. 左侧 **API Keys** → 创建 → 复制 `sk-` 开头的 Key（**只显示一次**）
3. 回到本站 `http://127.0.0.1:8848/` 登录 → 顶部 **外网** → 左栏「**翻译服务**」卡片
4. 选「**大模型（质量更好，需 Key）**」→ 粘贴 Key → 点「**拉取可用模型列表**」（会自动填好模型名）
5. 范围选「标题 + 要点」→ **保存** → 右上角变成「大模型」→ 点「**试译一句**」验证
6. 如果本期的中文是免费接口翻的，想换大模型重译：点语言栏右侧的「**换服务重译**」

要点：

- 模型名以官方文档为准（现在是 `deepseek-v4-flash` 这类），**不要手写猜**，点「拉取可用模型列表」
- Key 想清掉：卡片里有「清除已保存的 Key」
- 保存时 Key 留空 = 不修改已保存的（不会误删）
- Key 无效不会崩：会自动回退到免费接口，并在日志里报出 DeepSeek 自己的错误信息
- 费用参考：翻译一天约 85 条短文本（一万多 token），按 flash 档价格量级约几分钱

细节：

- 译文全部落盘缓存（`config/translations.json`），同一句话只翻一次；
  当前这一期已经是 85/85 全缓存，打开秒出
- 页面上的「翻译本期」是后台任务 + 进度轮询，不用干等
- 离线/不连服务器时，只能用数据里已经写进去的译文（`item.tr`）
- 想提前批量翻，不用在网页等：

```powershell
python tools\translate_digest.py --lang zh        # 整期外网 → 中文
python tools\translate_digest.py --lang zh,ja     # 多语言
python tools\translate_digest.py --lang zh --only-global-brief
python tools\check_tr_cache.py                    # 看缓存命中情况
```

> 翻译质量提醒：免费接口是逐句机器翻译，品牌名与数字会保留，但语气生硬；
> 自己看够用，发给别人建议配大模型。

---

## 八、信息源与分类规则

### 信息源 `sources.json`

**内网（region: cn）**：红餐网、餐饮界、Foodaily 每日食品、赢商网、新华网·食品、
中国连锁经营协会、职业餐饮网、钛媒体、界面新闻、每日经济新闻

**外网（region: global）**：

| 源 | 语言 | 直连 |
| --- | --- | --- |
| Restaurant Dive / Food Dive / Nation's Restaurant News / Eater / TechCrunch | 英 | ✅ |
| 食品産業新聞 | 日 | ✅ |
| The Spoon（餐饮科技） | 英 | ⚠️ 偶发超时 |
| QSR Magazine / Retail Dive / Restaurant Hospitality | 英 | ❌ 需代理 |

加一个源就往 `sources` 里追加：

```json
{
  "id": "kaimentime",
  "name": "咖门",
  "region": "cn",
  "type": "html",
  "url": "https://www.kaimentime.com/",
  "link_regex": "/article/\\d+",
  "weight": 1.2,
  "niche": true
}
```

- `region`：`cn` 内网 / `global` 外网（两个板块靠它分）
- `type`：`rss` 或 `html`；`link_regex` 只抓路径匹配的链接（HTML 源必填）
- `niche: true`：整站都是餐饮，不再做餐饮关键词过滤；综合站要设 `false`
- `weight`：来源权重，影响排序与「今日要点」入选
- `needs_proxy`：国内直连不通，只有配了代理才会抓

> 实测：红餐网只有 `http://` 可用；咖门、窄门餐眼在部分网络 TLS 握手失败。

### 分类与要点 `keywords.json`

- `categories.*.hints`：各板块关键词及权重（**中英日三语**），决定资讯归到哪个板块
- `restaurant_terms`：综合新闻站的餐饮相关词，命中才保留
- `exclude_title`：软文/SEO 标题特征，命中直接丢弃
- `tags`：生成「今日高频词」

英文匹配用单词边界（`contains()`），不会出现 `AI` 命中 `airlines` 这类误判。

### 品牌与市场格局 `brands.json`

- `categories`：14 个餐饮品类（茶饮 / 咖啡 / 火锅 / 中式快餐 / 西式快餐 / 中式正餐 /
  烘焙甜品 / 烧烤 / 小吃卤味 / 酒馆酒吧 / 西餐轻食 / 食品供应链 / 平台与配送 / 其他）
- `brands`：**214 个品牌**字典，含中英日别名（蜜雪冰城/Mixue、麦当劳/McDonald's…）
- `cat_keywords`：没识别出具体品牌时用品类关键词兜底

饼图口径（页面上也标了）：

```
综合占比 = 0.6 × 资讯热度占比 + 0.4 × 已披露门店规模占比
```

- **资讯热度占比**：该品类条数 ÷ 总条数
- **已披露门店规模占比**：从资讯里抽到的门店数（含英文 stores/locations）归一化
- 没识别出品牌/品类的条目不进饼图，单列 `unclassified` 并在页面注明

⚠️ 这是**基于公开资讯的统计**，不是官方市场份额。要接真实市占率，
把数据整理成 `public/data/market.json` 即可（后续可加渲染）。

---

## 九、可选：大模型润色要点

不配 Key 也能用（规则式提炼：优先取与标题相关的正文导语，其次站点摘要）。
配上 Key 后要点更像人写的，还会生成一句今日综述：

```powershell
$env:LLM_API_KEY  = "你的key"
$env:LLM_BASE_URL = "https://api.deepseek.com/v1"
$env:LLM_MODEL    = "deepseek-chat"
python daily.py --llm
```

调用失败会自动回退到规则式提炼，日志里会写明，不中断采集。

---

## 十、手机上怎么看

**方式 A：局域网（最快）**

1. `python server.py`（会打印手机可用地址）
2. 手机连同一 WiFi，访问打印出来的地址，例如 `http://172.19.141.252:8848/login.html`

**方式 B：安卓 APK**

见第十三节。内置离线日报、双板块切换、译文都能用；因为数据在本地，不需要登录。

**方式 C：iPhone**

- **PWA（免费）**：Safari 打开公网地址 → 分享 → 添加到主屏幕
- **TestFlight（需苹果开发者账号 99 美元/年）**：见第十四节

**方式 D：静态托管**：见第十一节（注意：静态托管没有登录保护）

---

## 十一、发布到公网（GitHub Pages）

你的网络下 `.vibedrop.site` / Vercel / ngrok 都不通，但 **github.io 可达**，
而且 GitHub 账号你已经有了。不需要装 git 和 Node：

```powershell
$env:GITHUB_TOKEN = "ghp_你的token"     # https://github.com/settings/tokens 勾 repo
python tools\publish_site.py
python tools\publish_site.py --dry-run  # 先看会传哪些文件
```

会自动创建仓库并上传 `public/` 到 `gh-pages` 分支，得到
**`https://nfalyhl.github.io/canyin-daily/`**（首次等 1-2 分钟）。之后每次采集完再跑一次即可。

> ⚠️ 静态托管**没有后端**，所以没有外网节点设置、没有翻译开关。
> 登录和设备名额靠独立的**鉴权服务**（下一节）。

---

## 十二、公网站点也要登录（鉴权服务 + 设备名额）

静态托管没法校验密码，所以登录这件事交给一个独立的**鉴权服务**：

- 代码：`cloud/main.ts`（单文件，零依赖，用 Deno 自带的 KV 存账号/设备）
- 部署：**Deno Deploy 免费版**（100 万请求/月），国内手机可直连，官网用 GitHub 登录即可
- 网页侧：`public/auth.js` —— 没登录时用全屏门禁盖住页面（数据在前面渲染也看不到）
- 账号：与 `config/users.json` **同一套哈希**（不存明文），靠环境变量 `USERS_JSON` 同步
- 名额：**每个账号最多 3 台设备**（`MAX_DEVICES`）；满了列出在线设备让你选一台下线

部署步骤、完整接口表、注意事项都在 **`cloud/README.md`**，这里是速查：

```powershell
python tools\publish_auth_service.py          # 把 cloud/ 推到 nfalyhl/canyin-auth
python tools\auth_admin.py emit               # 生成 USERS_JSON（贴到 Deno Deploy 环境变量）
# 浏览器里：console.deno.com 建组织 → Provision Deno KV → New App 选 canyin-auth
#   Runtime=Dynamic、Entrypoint=main.ts、Dynamic arguments=--unstable-kv（不能省！）
#   Attach Database 挂 KV → 加环境变量 → Deploy
python tools\auth_admin.py test --base https://你的地址                  # 自检
python tools\auth_admin.py test --base https://你的地址 --user YYQ       # 试登录
python tools\auth_admin.py set-auth https://你的地址                     # 写进站点配置
daily.py --render-only ; python tools\publish_site.py                     # 重新生成并发布
```

想关掉门禁：`python tools\auth_admin.py set-auth ""`，再重新生成发布。
改完 `cloud/main.ts` 要重新发布服务，本地可以先跑 `python cloud\test_local.py`（需装 Deno）。

> ⚠️ 门禁保护的是「入口」，不是「正文」：站点内容是静态 HTML/JSON，
> 直接拉 `data/digest-*.json` 仍能读到。要连正文一起锁住，得把数据也搬到后端按登录态下发。

---

## 十三、目录结构

```
canyin-daily\
├─ daily.py                  采集 / 分类 / 提炼 / 生成页面
├─ server.py                 带登录的网站服务（鉴权 + 节点 + 翻译 + 触发采集）
├─ translate.py              翻译模块（免费接口 + 可选大模型 + 缓存）
├─ sources.json              信息源配置（20 个，含内网/外网标记）
├─ keywords.json             分类关键词、过滤词、标签词（中英日）
├─ brands.json               214 个品牌字典 + 14 个品类
├─ run-daily.ps1             每日采集入口（带日志）
├─ setup-task.ps1            注册/管理 Windows 计划任务
├─ config\                   账号、密钥、设置（本地，不外传）
│  ├─ users.json             账号哈希
│  ├─ devices.json           每个账号当前在线的设备（名额管理）
│  ├─ secret.key             会话签名密钥（不要删）
│  ├─ translations.json      译文缓存
│  └─ settings.json          外网节点、翻译服务等设置
├─ dist\                     生成的 APK
├─ android\                  Android 工程（WebView 壳 + 打包脚本）
├─ ios\                      iOS 工程（WKWebView 壳 + TestFlight 说明）
├─ cloud\                    登录鉴权服务（Deno Deploy 单文件版 + 部署说明）
│  ├─ main.ts                登录 / 设备名额 / 踢下线（用 Deno KV 存状态）
│  ├─ deno.json              本地起步任务（deno task start）
│  ├─ README.md              部署步骤、接口表、注意事项
│  └─ test_local.py          本地起一个实例把逻辑跑一遍（需装 Deno）
├─ .github\workflows\        iOS 构建并上传 TestFlight
├─ tools\
│  ├─ setup_users.py         管理登录账号
│  ├─ test_server.py         鉴权/接口自检（14 项）
│  ├─ test_devices.py        设备名额自检（3 台上限 / 踢下线 / 退出释放）
│  ├─ auth_admin.py          鉴权服务：生成 USERS_JSON / 自检 / 写站点配置
│  ├─ publish_auth_service.py  把 cloud/ 推到独立仓库供 Deno Deploy 部署
│  ├─ test_translate_api.py  翻译接口自检
│  ├─ translate_digest.py    给已有日报补翻译
│  ├─ check_tr_cache.py      查看译文缓存命中情况
│  ├─ shot_server_ui.py      登录页 + 双板块界面截图自检
│  ├─ make_icons.py          Web 图标
│  ├─ make_android_icons.py  Android 启动图标
│  ├─ make_ios_icon.py       iOS 1024 图标
│  ├─ publish_site.py        发布到 GitHub Pages（gh-pages 分支）
│  ├─ apk_pack.py            合成 Android APK
│  ├─ check_apk.py           检查 APK 内容
│  ├─ peek.py / peek_market.py  终端查看日报内容
│  ├─ check_region.py        核对内外网分区
│  └─ shot.py / shot_desktop.py / zoom.py   截图自检
└─ public\                   网站根目录
   ├─ index.template.html    页面模板
   ├─ auth.js                静态站点的登录门禁 + 设备管理弹窗
   ├─ auth-config.json       鉴权服务地址（留空 = 不做登录门禁）
   ├─ index.html             生成物：日报页面（需登录）
   ├─ login.html             登录页（公开）
   ├─ offline.html           生成物：单文件版（供 App / 离线阅读）
   ├─ style.css / app.js     样式与渲染
   ├─ sw.js / manifest.webmanifest    PWA 离线与安装
   └─ data\                  digest-YYYY-MM-DD.json / index.json
```

---

## 十四、Android APK

产出：`dist\canyin-daily-1.4.apk`（约 106 KB）

- 包名 `com.canyindaily.app`，minSdk 21（Android 5.0+），targetSdk 34
- 自签名，v1 + v2 + v3 三种签名方案均通过校验
- 权限只有 `INTERNET` / `ACCESS_NETWORK_STATE`（供在线数据源；内置日报完全离线）
- 能力：内置离线日报（含外网中文译文）、双板块切换、外链跳浏览器、分享要点、
  白班/夜班（含状态栏）、可选在线数据源

重新打包：

```powershell
python daily.py                          # 先生成最新页面
.\android\build-apk.ps1                  # 再打包
.\android\build-apk.ps1 -Version 1.5 -VersionCode 6
```

踩过的坑（已写进脚本）：

- **aapt2 / zipalign 处理不了含中文的路径**，脚本会先把源码拷到 `C:\android-build` 再编译
- PowerShell 5.1 按 GBK 读脚本，所以 `.ps1` 都带 UTF-8 BOM，另存时别把 BOM 去掉
- 版本号由 `-Version / -VersionCode` 控制，**不要**写回 `AndroidManifest.xml`
- 签名密钥在 `android\keystore\canyin-release.keystore`（口令写在 `build-apk.ps1` 里），**不要删**

构建链：JDK 17（装在 `D:\`）+ Android SDK（`C:\Users\Lenovo\Desktop\代码\android-sdk`，
build-tools 34.0.0 + platforms/android-34）。没用 Gradle，直接调
aapt2 / javac / d8 / zipalign / apksigner，不依赖网络。

---

## 十五、iOS（TestFlight）

工程在 `ios/`（WKWebView 壳 + XcodeGen 配置），上传工作流在
`.github/workflows/ios-testflight.yml`。完整步骤见 **`ios/README.md`**。

**前置条件（只能你本人办）**：Apple Developer Program（99 美元/年）
+ 在 App Store Connect 里先建好 App 记录（Bundle ID `com.canyindaily.app`）。
iOS 工程也无法在 Windows 上编译，所以走 GitHub Actions 的 macOS 机器构建并自动上传。

不想花这 99 美元：iPhone 上用 PWA（Safari → 添加到主屏幕），效果几乎一样。

---

## 十六、常见问题

**抓不到内容 / 大量 FAIL**
网络问题居多。先 `--fast` 跑一遍看哪些源失败，需要代理的在网页「外网节点」里填节点重试；
连续失败的源在 `sources.json` 里把 `"enabled"` 设为 `false`。

**要点是空的**
说明这条只拿到了标题。`--fast` 模式会出现这种情况，正常模式约 90% 的条目有要点。

**页面里的「往期」打不开**
用 `file://` 直接打开时浏览器禁止读本地 JSON，属正常；「往期」需要 http/https 环境。

**同一天的日报想重新生成**
直接再跑一次 `python daily.py --date 2026-09-25` 覆盖即可；去重只在跨天生效，
同一天重跑不会把自己过滤掉，已有译文也会按 id 接回来。

**译文没出现 / 只出来一半**
先看左栏「翻译服务」是否可用，再点「翻译本期」补齐；免费接口有每日额度，
额度用完会部分失败，换大模型或第二天再补。

**改完 README/JSON 中文变乱码**
别用 PowerShell 的 `Get-Content -Raw | Set-Content` 处理 UTF-8 中文文件（PS 5.1 会按 GBK
解码后写回，直接毁文件）。用编辑器或 Python 改。
