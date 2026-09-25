<#
  餐饮日报 · iOS 工程本地准备
  把 public\offline.html 拷成 iOS 包里要用的 www\index.html，
  并生成 1024 图标。GitHub Actions 工作流里做的是同一件事。

  用法：
    .\ios\prepare.ps1
    .\ios\prepare.ps1 -From public\index.html
#>
param(
    [string]$From = "public\offline.html"
)

$ErrorActionPreference = "Stop"
$ios = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $ios

$src = Join-Path $root $From
if (-not (Test-Path $src)) {
    Write-Host "找不到 $src —— 先跑一次 python daily.py 生成页面" -ForegroundColor Red
    exit 1
}

$www = Join-Path $ios "CanyinDaily\www"
New-Item -ItemType Directory -Force -Path $www | Out-Null
Copy-Item $src (Join-Path $www "index.html") -Force

$size = [math]::Round((Get-Item (Join-Path $www "index.html")).Length / 1KB)
Write-Host "[1/2] 内置页面已就位：CanyinDaily\www\index.html（$size KB）" -ForegroundColor Green

Push-Location $root
try {
    & python "tools\make_ios_icon.py"
} finally {
    Pop-Location
}
Write-Host "[2/2] App 图标已生成（1024×1024，无透明通道）" -ForegroundColor Green

Write-Host ""
Write-Host "接下来（需要 macOS 或 GitHub Actions）：" -ForegroundColor Cyan
Write-Host "  本地 Mac：cd ios; brew install xcodegen; xcodegen generate; 用 Xcode 打开并 Archive"
Write-Host "  Windows ：推到 GitHub，跑 Actions 里的「iOS TestFlight」（见 ios\README.md）"
