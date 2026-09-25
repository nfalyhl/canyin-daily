<#
  注册 Windows 计划任务：每天固定时间自动采集一次餐饮日报。

  用法（在项目目录里执行，不需要管理员权限）：
    .\setup-task.ps1                       # 每天 07:30 采集
    .\setup-task.ps1 -At 08:15             # 改成 08:15
    .\setup-task.ps1 -At 07:30 -Proxy http://127.0.0.1:7897
    .\setup-task.ps1 -Status               # 查看任务状态
    .\setup-task.ps1 -RunNow               # 立刻跑一次
    .\setup-task.ps1 -Remove               # 删除任务
#>
param(
    [string]$At = "07:30",
    [string]$Name = "餐饮日报-每日采集",
    [string]$Proxy = "",
    [switch]$Remove,
    [switch]$Status,
    [switch]$RunNow
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue

if ($Status) {
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $Name
        "任务名称 : $Name"
        "状态     : $($task.State)"
        "上次运行 : $($info.LastRunTime)"
        "上次结果 : $($info.LastTaskResult)"
        "下次运行 : $($info.NextRunTime)"
    } else {
        "还没有注册计划任务，先执行 .\setup-task.ps1"
    }
    return
}

if ($RunNow) {
    if (-not $task) { throw "任务尚未注册，请先执行 .\setup-task.ps1" }
    Start-ScheduledTask -TaskName $Name
    "已触发一次：$Name"
    return
}

if ($Remove) {
    if ($task) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        "已删除计划任务：$Name"
    } else {
        "没有找到计划任务：$Name"
    }
    return
}

$psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$script = Join-Path $root "run-daily.ps1"
$argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
if ($Proxy) { $argLine += " -Proxy $Proxy" }

$action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
    -Settings $settings -Force `
    -Description "餐饮日报：每天采集餐饮行业资讯并生成今日要点。" | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $Name
"已注册计划任务：$Name"
"触发时间：每天 $At"
"下次运行：$($info.NextRunTime)"
"说明：默认在「用户登录时」运行；若要关机后也自动跑，可在「任务计划程序」里"
"      改为「不管用户是否登录都要运行」并填入 Windows 密码。"
