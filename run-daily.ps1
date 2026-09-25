<#
  餐饮日报 · 每日采集入口
  采集 10 个公开信息源，生成 public/index.html（可直接双击打开或部署到静态托管）。

  用法：
    .\run-daily.ps1                                   # 采集今天（默认顺带把外网翻成中文）
    .\run-daily.ps1 -Proxy http://127.0.0.1:7897      # 走本地代理
    .\run-daily.ps1 -UseLlm                           # 启用大模型润色要点（需先设 API Key）
    .\run-daily.ps1 -Translate "zh,ja"                # 翻译成多种语言
    .\run-daily.ps1 -NoTranslate                      # 不翻译，只采集
    .\run-daily.ps1 -Fast                             # 只跑列表，不抓正文（约 8 秒）
#>
param(
    [string]$Proxy = "",
    [string]$Date = "",
    [string]$Translate = "zh",
    [switch]$NoTranslate,
    [switch]$UseLlm,
    [switch]$Fast
)

$ErrorActionPreference = "Stop"

# 让 PowerShell 正确按 UTF-8 读取 python 输出，否则日志里的中文会乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("daily-{0}.log" -f (Get-Date -Format "yyyy-MM"))

$cliArgs = @("daily.py")
if ($Date)  { $cliArgs += @("--date", $Date) }
if ($Proxy) { $cliArgs += @("--proxy", $Proxy) }
if ($UseLlm) { $cliArgs += "--llm" }
if ($Fast)  { $cliArgs += "--fast" }
if (-not $NoTranslate -and $Translate) { $cliArgs += @("--translate", $Translate) }

Add-Content -Path $logFile -Encoding UTF8 -Value ("===== " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " =====")

$output = & python @cliArgs 2>&1 | Out-String
Add-Content -Path $logFile -Encoding UTF8 -Value $output
Write-Output $output

# 采集失败时返回非 0，便于计划任务里排查
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
