<#
  餐饮日报 · Android APK 打包脚本（不用 Gradle，直接用 SDK 自带工具链）

  依赖：
    · JDK 17               （需要 javac / jar / keytool）
    · Android SDK 工具链    build-tools 34.0.0 + platforms/android-34/android.jar
      默认在 C:\Users\Lenovo\Desktop\代码\android-sdk，可用 -Sdk 指定

  说明：aapt2 / zipalign 等原生工具处理不了含中文的路径，
        所以脚本会先把源码复制到纯 ASCII 的工作目录（默认 C:\android-build）再编译，
        编译完成后把 APK 拷回项目的 dist\ 目录。

  用法：
    .\build-apk.ps1                      # 用 public\offline.html 作为内置页面打包
    .\build-apk.ps1 -Version 1.1 -VersionCode 2
    .\build-apk.ps1 -Sdk D:\android-sdk -WorkDir D:\android-build
#>
param(
    [string]$Sdk = "C:\Users\Lenovo\Desktop\代码\android-sdk",
    [string]$WorkDir = "C:\android-build",
    [string]$Version = "1.0",
    [int]$VersionCode = 1
)

# 原生命令会把正常信息写到 stderr，PowerShell 5.1 配合 Stop 会误判为致命错误，
# 所以这里用 Continue，并用退出码手工判断。
$ErrorActionPreference = "Continue"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path          # android\
$proj = Split-Path -Parent $here                                 # canyin-daily\
$bt   = Join-Path $Sdk "build-tools\34.0.0"
$ajar = Join-Path $Sdk "platforms\android-34\android.jar"

function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }
function Need($path, $what) { if (-not (Test-Path $path)) { Fail "缺少 $what：$path" } }

Need $bt "build-tools 目录"
Need $ajar "android.jar (platforms/android-34)"
Need (Join-Path $proj "tools\apk_pack.py") "tools\apk_pack.py"

# ---------- 定位 JDK ----------
$javaHome = ""
try {
    $out = & java -XshowSettings:properties -version 2>&1 | Out-String
    $m = [regex]::Match($out, "java\.home\s*=\s*(.+)")
    if ($m.Success) { $javaHome = $m.Groups[1].Value.Trim() }
} catch { }
if (-not $javaHome -or -not (Test-Path (Join-Path $javaHome "bin\javac.exe"))) {
    foreach ($cand in @("D:\", "C:\Program Files\Java\latest\jdk-17", "C:\Program Files\Java\latest")) {
        if (Test-Path (Join-Path $cand "bin\javac.exe")) { $javaHome = $cand; break }
    }
}
if (-not $javaHome) { Fail "找不到 JDK，请安装 JDK 17 并确保 java/javac 在 PATH 中" }

$env:JAVA_HOME = $javaHome
$javac   = Join-Path $javaHome "bin\javac.exe"
$jarTool = Join-Path $javaHome "bin\jar.exe"
$keytool = Join-Path $javaHome "bin\keytool.exe"
Need $javac "javac"; Need $keytool "keytool"

Write-Host "JDK        : $javaHome"
Write-Host "build-tools: $bt"
Write-Host "android.jar: $ajar"
Write-Host "工作目录   : $WorkDir"

# ---------- 0. 准备 ASCII 工作目录 ----------
$src = Join-Path $proj "public\offline.html"
if (-not (Test-Path $src)) { Fail "找不到 public\offline.html，请先运行 python daily.py" }

Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
foreach ($d in @("", "res", "java", "assets", "out")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $WorkDir $d) | Out-Null
}
Copy-Item (Join-Path $here "AndroidManifest.xml") $WorkDir -Force
Copy-Item (Join-Path $here "res\*") (Join-Path $WorkDir "res") -Recurse -Force
Copy-Item (Join-Path $here "java\*") (Join-Path $WorkDir "java") -Recurse -Force
Copy-Item $src (Join-Path $WorkDir "assets\index.html") -Force

# android.jar 的原始路径含中文，aapt2 / javac 读不到，先拷一份到 ASCII 目录
$ajarLocal = Join-Path $WorkDir "android.jar"
if (-not (Test-Path $ajarLocal) -or
    (Get-Item $ajarLocal).Length -ne (Get-Item $ajar).Length) {
    Write-Host "     拷贝 android.jar 到工作目录…"
    Copy-Item $ajar $ajarLocal -Force
}

$build = Join-Path $WorkDir "out"
$dist  = Join-Path $proj "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Write-Host ("`n[1/7] 内置页面 : {0:N0} KB" -f ((Get-Item $src).Length / 1KB))

# ---------- 2. 编译资源 ----------
Write-Host "[2/7] aapt2 compile"
& (Join-Path $bt "aapt2.exe") compile --dir (Join-Path $WorkDir "res") -o (Join-Path $build "res.zip")
if ($LASTEXITCODE -ne 0) { Fail "aapt2 compile 失败" }

# ---------- 3. 生成 APK 骨架 ----------
Write-Host "[3/7] aapt2 link"
& (Join-Path $bt "aapt2.exe") link `
    -o (Join-Path $build "base.apk") `
    -I $ajarLocal `
    --manifest (Join-Path $WorkDir "AndroidManifest.xml") `
    -A (Join-Path $WorkDir "assets") `
    --version-code $VersionCode --version-name $Version `
    (Join-Path $build "res.zip")
if ($LASTEXITCODE -ne 0) { Fail "aapt2 link 失败" }

# ---------- 4. 编译 Java ----------
Write-Host "[4/7] javac"
$classes = Join-Path $build "classes"
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$sources = Get-ChildItem -Path (Join-Path $WorkDir "java") -Filter *.java -Recurse |
    ForEach-Object { $_.FullName }
$jcArgs = @("-encoding", "UTF-8", "-source", "8", "-target", "8", "-nowarn",
            "-bootclasspath", $ajarLocal, "-cp", $ajarLocal, "-d", $classes) + $sources
& $javac @jcArgs
if ($LASTEXITCODE -ne 0) { Fail "javac 失败" }

# ---------- 5. dex ----------
Write-Host "[5/7] d8"
& $jarTool cf (Join-Path $build "classes.jar") -C $classes .
if ($LASTEXITCODE -ne 0) { Fail "打包 classes.jar 失败" }
New-Item -ItemType Directory -Force -Path (Join-Path $build "dex") | Out-Null
& (Join-Path $bt "d8.bat") --release --min-api 21 --lib $ajarLocal `
    --output (Join-Path $build "dex") (Join-Path $build "classes.jar")
if ($LASTEXITCODE -ne 0) { Fail "d8 失败" }

Write-Host "[6/7] 合成 + 对齐"
& python (Join-Path $proj "tools\apk_pack.py") (Join-Path $build "base.apk") `
    (Join-Path $build "dex\classes.dex") (Join-Path $build "unsigned.apk")
if ($LASTEXITCODE -ne 0) { Fail "合成 APK 失败" }
& (Join-Path $bt "zipalign.exe") -f -p 4 (Join-Path $build "unsigned.apk") `
    (Join-Path $build "aligned.apk")
if ($LASTEXITCODE -ne 0) { Fail "zipalign 失败" }

# ---------- 6. 签名 ----------
$ksDir = Join-Path $here "keystore"
New-Item -ItemType Directory -Force -Path $ksDir | Out-Null
$ks = Join-Path $ksDir "canyin-release.keystore"
$storePass = "canyindaily"
$alias = "canyin"
if (-not (Test-Path $ks)) {
    Write-Host "     生成签名密钥（自签名；留着它才能给已安装的 App 升级）"
    & $keytool -genkeypair -v -keystore $ks -alias $alias -keyalg RSA -keysize 2048 `
        -validity 10950 -storepass $storePass -keypass $storePass `
        -dname "CN=Canyin Daily, OU=Personal, O=Personal, L=Hangzhou, ST=Zhejiang, C=CN"
    if ($LASTEXITCODE -ne 0) { Fail "生成 keystore 失败" }
}

$apk = Join-Path $dist ("canyin-daily-{0}.apk" -f $Version)
& (Join-Path $bt "apksigner.bat") sign `
    --ks $ks --ks-key-alias $alias `
    --ks-pass "pass:$storePass" --key-pass "pass:$storePass" `
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true `
    --out $apk (Join-Path $build "aligned.apk")
if ($LASTEXITCODE -ne 0) { Fail "签名失败" }

# ---------- 7. 校验 ----------
Write-Host "[7/7] 校验"
$verifyOut = & (Join-Path $bt "apksigner.bat") verify --verbose $apk 2>&1
$verifyCode = $LASTEXITCODE
$verifyOut | Select-Object -First 9
if ($verifyCode -ne 0) { Fail "签名校验未通过" }

$badging = & (Join-Path $bt "aapt2.exe") dump badging $apk 2>&1
$badging | Select-String -Pattern "^package|^application-label|^sdkVersion|^targetSdkVersion|^launchable"

Write-Host ""
Write-Host ("完成：{0}  ({1:N0} KB)" -f $apk, ((Get-Item $apk).Length / 1KB)) -ForegroundColor Green
exit 0
