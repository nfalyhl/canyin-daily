# -*- coding: utf-8 -*-
"""打一个「交接包」：把项目源码（不含任何密钥）打包成 zip，
并附一份给「有苹果开发者账号的人」的上架说明。

用途：自己没有 99 美元的开发者账号时，把包发给有账号的人（朋友/实验室/公司），
对方按说明跑一次，你就能从 TestFlight 装上。

用法：python tools\\make_handoff.py
"""
import sys
import zipfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import publish_github as pg  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

HANDOFF = """# 餐饮日报 · iOS 上架交接说明

这个包是一个「餐饮行业每日资讯」工具：Python 采集 + 静态网页，
iOS 端是一个 WKWebView 壳（**已经是完整可用工程**，本地不需要再写代码）。

打包时间：{stamp}
项目体积：约 {mb:.1f} MB（zip 内不含任何账号密码 / API Key，可放心转交）

---

## 你需要做的事（约 15 分钟，之后每次更新只需点一次）

### 前置：一个 Apple Developer Program 账号（99 美元/年）
这是苹果的硬门槛：没有它就无法上传 TestFlight。个人账号注册后审核 1–2 天。

### 第 1 步：把项目放到你的 GitHub 仓库
解压本包，上传到你自己的仓库（公开仓库的 macOS 构建免费额度更宽松）。
如果直接丢整个项目，注意包内已带 `.gitignore`，不会误传密钥。

### 第 2 步：在 App Store Connect 建好 App 记录（**必须先做，否则上传会被拒**）
1. 打开 https://developer.apple.com/account → Certificates, Identifiers & Profiles
   → Identifiers → ➕ → App IDs → App → Bundle ID 填 **com.canyindaily.app**
   （若占用了，可改成你自己的，比如 com.你的名字.canyindaily；
   改了要同步改 `ios/project.yml` 里的 PRODUCT_BUNDLE_IDENTIFIER）
2. 打开 https://appstoreconnect.apple.com → 我的 App → ➕ → 新建 App
   - 平台：iOS
   - 名称：餐饮日报（可自己改）
   - 主要语言：简体中文
   - Bundle ID：选第 1 步建的那个
   - SKU：随便填（如 canyin-daily）

### 第 3 步：生成 API Key（给 CI 用，不用手工配证书）
App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**
→ ➕ 新建 → 角色选 **App Manager** → 创建后**下载 .p8 文件（只能下载一次，务必存好）**
记下三个值：**Key ID**、**Issuer ID**（同页顶部）、**Team ID**（Membership 页）。

### 第 4 步：在仓库里填 4 个 Secret
仓库 → Settings → Secrets and variables → Actions → New repository secret：

| 名称 | 值 |
| --- | --- |
| `ASC_KEY_ID` | 第 3 步的 Key ID |
| `ASC_ISSUER_ID` | 第 3 步的 Issuer ID |
| `ASC_KEY_P8` | .p8 文件的**全部内容**（含 BEGIN/END 那两行） |
| `APPLE_TEAM_ID` | 第 3 步的 Team ID |

### 第 5 步：点一下就跑
仓库 → Actions → 左侧 **iOS TestFlight** → **Run workflow**
它会自动：装 XcodeGen → 把 `public/offline.html` 拷成 App 内置页面 → 生成工程
→ 归档签名 → **直接上传到 App Store Connect**（约 10 分钟）

### 第 6 步：把测试员加进来
App Store Connect → 你的 App → **TestFlight**
- **内部测试**：把对方 Apple ID 邮箱加进「App Store Connect 用户」即可
- **外部测试**：建一个测试组，Apple 审核首个构建（通常 1 天内），然后可以生成**公开链接**直接发给人装

对方（iPhone 用户）拿到邀请后：App Store 装 **TestFlight** → 打开邀请链接 → 安装你的 App。

---

## 常见问题

**Q：构建红了怎么办？**
本工程没在 macOS 上实测过（是在 Windows 上准备的）。第一次跑大概率要调 1–2 轮，常见两处：
- `ExportOptions.plist` 里的 `method`：Xcode 15.3+ 用 `app-store-connect`，更老版本改成 `app-store`
- 缺少 App 记录时会报 "No suitable application records were found" → 回到第 2 步

**Q：更新内容要重新上架吗？**
不用。跑 `python daily.py`（可加 `--translate zh`）重新生成页面，
再点一次 Actions 就能传新构建。或者 App 内置的「同步」按钮可以指向一个在线地址，连重装都不用。

**Q：不想花这 99 美元还有别的办法吗？**
有，但都不是 TestFlight：
- **PWA**：把 `public/` 挂到任意 https 静态托管，iPhone Safari 打开 → 分享 → 添加到主屏幕。
  全屏、有图标、支持离线，这个工具的功能几乎完全一致，且免费。（推荐先用这个）
- **免费 Apple ID 自签**（AltStore / Sideloadly）：仍需要一个 .ipa，而 .ipa 必须在 macOS 上构建；
  且 7 天过期要续签，iOS 17+ 还要开开发者模式。折腾程度远高于 PWA。
- ⚠️ 网上那些「免越狱安装平台 / 企业签名」是盗用企业证书的灰产，随时掉签还可能被装后门，别用。
"""


def main():
    files = pg.collect_files()
    hits = pg.scan(files)
    if hits:
        print("!! 安全闸门拦下，包内疑似有密钥，已中止")
        for rel, desc, sample in hits:
            print(f"   {rel}  {desc}  {sample}")
        sys.exit(2)
    print(f"打包 {len(files)} 个文件（已排除 config/、keystore、日志）")

    DIST.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d")
    out = DIST / f"canyin-daily-源码交接包-{stamp}.zip"
    total = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel, p in files:
            z.write(p, arcname=f"canyin-daily/{rel}")
            total += p.stat().st_size
        z.writestr("canyin-daily/上架交接说明.md",
                   HANDOFF.format(stamp=stamp, mb=total / 1048576))
    print(f"  ✓ {out}")
    print(f"    原始 {total / 1024:.0f} KB → 压缩后 {out.stat().st_size / 1024:.0f} KB")
    print(f"    含说明：上架交接说明.md")


if __name__ == "__main__":
    main()
