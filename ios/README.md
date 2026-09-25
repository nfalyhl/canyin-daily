# iOS 端（TestFlight）

和安卓一样的思路：**网页是主体，原生只补网页做不到的事**。
iOS 端是一个 WKWebView 壳，加载内置的离线日报（`www/index.html`，由 `public/offline.html` 复制而来），
并通过和安卓**同名同形**的 JS 桥 `window.AppBridge` 补充能力：

| 桥方法 | 作用 |
| --- | --- |
| `isApp()` | 页面据此显示「同步」按钮 |
| `share(text)` | 拉起 iOS 分享面板（可直接发微信） |
| `getRemote()` / `setRemote(url)` / `reload()` | 配置在线数据源 |
| `setStatusBarColor(hex)` | 白班/夜班切换时同步状态栏 |

页面代码（`public/app.js`）两端通用，不需要为 iOS 单独维护一份。

---

## 一、必须你本人办的两件事

这两步我无法代办，因为没有它们 TestFlight 一条都走不通：

1. **加入 Apple Developer Program** —— 99 美元/年。
   到 https://developer.apple.com/programs/ 用 Apple ID 注册，个人身份即可，通常 1-2 天审核。
   （没有它就没有 TestFlight，也没有任何官方途径把 App 装到 iPhone 上。）
2. **在 App Store Connect 建好 App 记录** —— 上传前必须先有这条记录，否则上传必被拒。
   - 打开 https://developer.apple.com/account/resources/identifiers/list 注册一个
     **App ID**：Bundle ID 填 `com.canyindaily.app`（必须完全一致）
   - 打开 https://appstoreconnect.apple.com → 我的 App → **+** → 新建 App
     - 平台：iOS
     - 名称：餐饮日报
     - 语言：简体中文
     - Bundle ID：选刚注册的 `com.canyindaily.app`
     - SKU：随便填，例如 `canyin-daily-1`
3. **生成 App Store Connect API Key**（给 CI 用）
   https://appstoreconnect.apple.com/access/integrations/api → **+** → 角色选 **App Manager**
   - 记下 **Key ID** 和 **Issuer ID**
   - 下载 `.p8` 文件（**只能下载一次**，务必存好）
   - 在 https://developer.apple.com/account → Membership 里找到 **Team ID**（10 位）

---

## 二、把项目推到 GitHub

工作流跑在 GitHub 的 macOS 机器上，所以项目得先是一个 GitHub 仓库。

```powershell
cd C:\Users\Lenovo\Desktop\代码\canyin-daily
git init
git add .
git commit -m "餐饮日报：采集管线 + 网页版 + 安卓/iOS 壳"
# 在 GitHub 上新建一个空仓库后：
git remote add origin https://github.com/<你的用户名>/canyin-daily.git
git push -u origin main
```

> 你的机器上 GitHub 直连不通，push 前先设代理：
> ```powershell
> $env:HTTP_PROXY="http://127.0.0.1:7897"; $env:HTTPS_PROXY="http://127.0.0.1:7897"
> ```

## 三、配置 4 个 Secret

仓库 → **Settings → Secrets and variables → Actions → New repository secret**：

| Secret | 内容 |
| --- | --- |
| `ASC_KEY_ID` | 上一步的 Key ID |
| `ASC_ISSUER_ID` | 上一步的 Issuer ID |
| `ASC_KEY_P8` | `.p8` 文件的**全部文本内容**（含 `-----BEGIN PRIVATE KEY-----` 那几行） |
| `APPLE_TEAM_ID` | 10 位 Team ID |

## 四、触发构建

仓库 → **Actions → iOS TestFlight → Run workflow**（可填版本号，默认 1.0.0）。

流程会自动：复制最新页面 → 装 XcodeGen → 生成 Xcode 工程 → 用 API Key 自动处理签名 → 归档 →
导出并**直接上传到 App Store Connect**。整个过程约 10-20 分钟。

## 五、装到 iPhone

1. App Store 搜「**TestFlight**」装上（苹果官方的测试 App）
2. App Store Connect → 你的 App → **TestFlight** → 等构建状态变成「准备提交」
   → 在「内部测试」里把自己加为测试员（需要填 Apple ID 邮箱）
3. iPhone 打开 TestFlight，会看到「餐饮日报」，点「安装」
4. 首次打开如提示「不受信任的开发者」，到 设置 → 通用 → VPN与设备管理 里信任即可

---

## 六、不想花 99 美元的话：PWA 路线

iOS 上有一个功能等价、零成本的替代：

1. 把网页发布到一个 https 地址（见主 README 第六节，你的网络下推荐 GitHub Pages）
2. iPhone 用 **Safari** 打开 → 分享 → **添加到主屏幕**
3. 桌面出现「餐饮日报」图标，点开是全屏无地址栏，Service Worker 让最近一期离线也能看

对这个 App 来说，PWA 和 TestFlight 版本的区别只有：没有 App Store 分发、没有原生分享面板
（复制要点仍然可用）。如果只是自己用，PWA 已经够了；要发给别人用或上架，再走 TestFlight。

---

## 七、本机（Windows）能做什么、不能做什么

- ✅ 改页面、改桥接接口、`python daily.py` 更新内容、`python -m http.server` 本地预览
- ✅ 生成 iOS 图标：`python tools\make_ios_icon.py`
- ❌ 编译 iOS 工程、跑模拟器、打包 ipa —— 这些**只能 macOS**，所以放在 GitHub Actions 上

macOS 上本地构建（有 Mac 时）：

```bash
brew install xcodegen
cd ios
mkdir -p CanyinDaily/www && cp ../public/offline.html CanyinDaily/www/index.html
xcodegen generate
open CanyinDaily.xcodeproj      # 用 Xcode 选真机运行
```

## 八、可能踩到的坑

- **上传报 "Invalid Bundle ID" / 找不到 App 记录**：App Store Connect 里的 App 必须先建好，
  且 Bundle ID 与 `ios/project.yml` 里的 `com.canyindaily.app` 完全一致
- **`method` 取值随 Xcode 版本变化**：工作流用的是 `app-store-connect`（Xcode 15.3+ 的新名字）。
  如果运行器的 Xcode 较老报错，把 `.github/workflows/ios-testflight.yml` 里改成 `app-store`
- **构建卡在「等待处理」**：Apple 侧处理通常 5-15 分钟，正常现象
- **每次上传的构建号必须递增**：工作流用 `github.run_number` 自动加，不用手动管
- **免费 Apple ID（非开发者账号）**：只能用自己的 Apple ID 在 Xcode 里连数据线装，7 天过期，
  和 TestFlight 是两回事
