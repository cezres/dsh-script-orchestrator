#Requires -Version 7
# 票 27 隔离集成验证：安装 → 无头启动 → cron 创建校验矩阵（宏/秒字段/受限字段星步进/
# 越界/偏移时区/五年无解 → 准确 script_input_invalid）→ A（*/2 Asia/Shanghai）自动触发一轮
# 并回读表达式/时区/下次时刻/脚本结果 → P（enabled:false）暂停不触发 → 杀宿主跨多个计划
# 时刻后冷重启：B（*/2 UTC）停机错过合并为最近一次 run（中间触发不留记录）、未来计划保留、
# 暂停编排不补跑。绝不触碰真实用户 profile（独立 DSH_HOME）；终止按端口监听进程杀（笔记 02）。
[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
  [switch]$KeepSandbox
)
$ErrorActionPreference = 'Stop'

$Node = 'C:\Users\cezre\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$Pnpm = 'C:\Users\cezre\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$Dsh = 'C:\Users\cezre\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$PkgName = '@local/dsh-script-orchestrator'

$Sandbox = Join-Path $RepoRoot '.sandbox\s27'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch27'
$ProfileDir = Join-Path $SbxHome "profiles\$ProfileName"
$PkgDir = (Join-Path $RepoRoot 'pkg') -replace '\\', '/'

$script:Failures = @()

function Step([string]$name) { Write-Host "`n=== $name ===" -ForegroundColor Cyan }
function Check([bool]$condition, [string]$message) {
  if ($condition) { Write-Host "  PASS  $message" -ForegroundColor Green }
  else {
    Write-Host "  FAIL  $message" -ForegroundColor Red
    $script:Failures += $message
  }
}

function New-SandboxProfile {
  Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $pkgJson = @"
{
  "name": "dsh-profile-orch27",
  "private": true,
  "dependencies": {
    "$PkgName": "file:$PkgDir"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "$PkgName"
      ]
    }
  }
}
"@
  Set-Content -Path (Join-Path $ProfileDir 'package.json') -Value $pkgJson -Encoding utf8NoBOM
  Set-Content -Path (Join-Path $ProfileDir 'pnpm-workspace.yaml') -Value "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false`n" -Encoding utf8NoBOM
  Set-Content -Path (Join-Path $ProfileDir 'cordis.yml') -Value '[]' -Encoding utf8NoBOM
  Set-Content -Path (Join-Path $ProfileDir 'cordis.patch.yml') -Value '[]' -Encoding utf8NoBOM
}

function Invoke-PnpmInstall([string]$workDir) {
  $env:PATH = (Split-Path $Node -Parent) + ';' + $env:PATH
  $env:CI = 'true'
  Push-Location $workDir
  try {
    & $Node $Pnpm install --no-frozen-lockfile --reporter=append-only 2>&1 | ForEach-Object { "$_" } | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败（$workDir）" }
  }
  finally { Pop-Location }
}

function Start-HeadlessHost {
  param([string]$logStem)
  $env:DSH_HOME = $SbxHome
  $env:PATH = (Split-Path $Node -Parent) + ';' + $env:PATH
  $out = "$logStem.out.log"
  $err = "$logStem.err.log"
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  # --port 0：OS 动态分配端口（从 token URL 解析），避免与其他并行验证沙箱互相顶掉默认 3080
  $proc = Start-Process -FilePath $env:ComSpec -ArgumentList "/c", "`"$Dsh`" --profile $ProfileName --port 0 --no-open" `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
  $url = $null
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $out) {
      $raw = Get-Content $out -Raw -ErrorAction SilentlyContinue
      if ($raw) {
        $m = [regex]::Match($raw, 'https?://[^\s"]+\?token=[A-Za-z0-9_-]+')
        if ($m.Success) { $url = $m.Value; break }
      }
    }
    if ($proc.HasExited) { break }
  }
  if (-not $url) {
    Get-ChildItem "$SbxHome\logs" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
      Select-Object -First 2 | ForEach-Object { Write-Host "---- $($_.FullName) ----"; Get-Content $_.FullName -Tail 40 | Write-Host }
    throw "无头宿主未在 120 秒内打印带 token 的 URL（stdout: $out；stderr: $err）"
  }
  $port = ([uri]$url).Port
  return @{ Url = $url; Port = $port; Proc = $proc; Out = $out; Err = $err }
}

function Stop-HeadlessHost([int]$Port) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  if (-not $pids) { Write-Host "  （端口 $Port 无监听进程）"; return }
  foreach ($pid0 in $pids) {
    Write-Host "  杀端口 $Port 监听进程 pid=$pid0 ($((Get-Process -Id $pid0 -ErrorAction SilentlyContinue).ProcessName))"
    Stop-Process -Id $pid0 -Force -ErrorAction SilentlyContinue
  }
  # 等端口真正释放（Windows 上 Stop-Process 异步，socket 清理可滞后；不等会让下次启动 EADDRINUSE）
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $still) { Write-Host "  端口 $Port 已释放"; return }
  }
  Write-Host "  警告：端口 $Port 在 20 秒后仍被监听（$($still.OwningProcess -join ','))，继续但有 EADDRINUSE 风险" -ForegroundColor Yellow
}

function Get-AuthenticatedSession([string]$url) {
  $resp = Invoke-WebRequest -Uri $url -SessionVariable web -MaximumRedirection 5 -UseBasicParsing
  return $web
}

# RPC 会话：长等待（分钟级 sleep）后 web 会话 cookie 会过期（401 unauthorized），
# 故封装为「401 自动用原 token URL 重建会话并重试一次」的单一入口。
$script:RpcUrl = $null
$script:RpcPort = 0
$script:RpcSession = $null

function Connect-Rpc([string]$url, [int]$port) {
  $script:RpcUrl = $url
  $script:RpcPort = $port
  $script:RpcSession = Get-AuthenticatedSession $url
}

function Invoke-Rpc([string]$endpoint, $payload, [string]$rpcId = 'verify27') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  $uri = "http://127.0.0.1:$($script:RpcPort)/script-orchestrator/$endpoint"
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      return Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $body -WebSession $script:RpcSession -TimeoutSec 30
    }
    catch {
      $status = $null
      if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
      if ($attempt -eq 1 -and ($status -eq 401 -or "$_" -match 'unauthorized')) {
        Write-Host "  （会话过期，重建 web 会话后重试 $endpoint）"
        $script:RpcSession = Get-AuthenticatedSession $script:RpcUrl
        continue
      }
      throw
    }
  }
}

function To-UtcMs($value) {
  if ($value -is [datetime]) {
    return ([DateTimeOffset]::new($value.ToUniversalTime())).ToUnixTimeMilliseconds()
  }
  return [DateTimeOffset]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds()
}

# 分钟边界判定（五位 cron 的匹配时刻秒/毫秒均为 0；Invoke-RestMethod 会把 ISO 字符串
# 反序列化为 DateTime，故一切边界断言经 To-UtcMs 走毫秒取模）
function Test-MinuteBoundary($ms) { return (($ms % 60000) -eq 0) }

function Get-LatestRun([string]$id) {
  $v = Invoke-Rpc 'view' @{ id = $id } "run-$id"
  return @{ orch = $v.result.value; run = @($v.result.value.runs)[0]; runsCount = @($v.result.value.runs).Count }
}

# cron 编排输入（统一绝对 node 路径执行）
function New-CronInput([string]$id, [string]$expression, [string]$timeZone, [hashtable]$over = @{}) {
  $input = @{
    id = $id
    title = "验证 $id"
    trigger = @{ kind = 'cron'; expression = $expression; timeZone = $timeZone }
    script = @{ command = $Node; args = @('-e', 'console.log("CRON-MARKER-OK")'); cwd = $RepoRoot }
    judge = @{ rules = @(); fallback = @() }
    actions = @{}
  }
  foreach ($k in $over.Keys) { $input[$k] = $over[$k] }
  return $input
}

# 非法 cron 创建：断言 script_input_invalid 的 field/reason（part 可选）
function Assert-InvalidCron([string]$label, $payload, [string]$field, [string]$reason, [string]$part = '') {
  $r = Invoke-Rpc 'create' $payload "inv-$label"
  $ok = ($r.result.ok -eq $false) -and ($r.result.error.code -eq 'script_input_invalid') -and
    ($r.result.error.details.field -eq $field) -and ($r.result.error.details.reason -eq $reason)
  if (-not [string]::IsNullOrEmpty($part)) { $ok = $ok -and ($r.result.error.details.part -eq $part) }
  $actualPart = if ($null -ne $r.result.error.details.part) { "$($r.result.error.details.part)" } else { '' }
  Check $ok "$label → script_input_invalid（$field/$reason$(if ($actualPart) { "/$actualPart" })）"
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在（$Node）"
  Check (Test-Path $Dsh) "dsh.cmd 存在（$Dsh）"
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\scheduler.js')) 'pkg/lib/scheduler.js 存在'

  Step '阶段 1 · 隔离 profile 建立（file: 依赖指向 worktree pkg）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\scheduler.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 2 · 无头启动 + cron 创建校验矩阵（准确 script_input_invalid）'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  Connect-Rpc $host1.Url $host1.Port
  $baseOver = @{ script = @{ command = $Node; args = @('-e', '1'); cwd = $RepoRoot } }

  Assert-InvalidCron '宏 @daily' (New-CronInput 'bad1' '@daily' 'UTC' $baseOver) 'trigger.expression' 'unsupported-part' 'macro'
  Assert-InvalidCron '秒字段（六位）' (New-CronInput 'bad2' '*/10 * * * * *' 'UTC' $baseOver) 'trigger.expression' 'unsupported-part' 'second-field'
  Assert-InvalidCron 'dow 星步进（受限字段）' (New-CronInput 'bad3' '0 3 * * */2' 'UTC' $baseOver) 'trigger.expression' 'unsupported-part' 'day-of-week'
  Assert-InvalidCron 'minute 越界' (New-CronInput 'bad4' '60 3 * * *' 'UTC' $baseOver) 'trigger.expression' 'range' 'minute'
  Assert-InvalidCron '偏移时区写法' (New-CronInput 'bad5' '0 3 * * *' 'UTC+8' $baseOver) 'trigger.timeZone' 'format'
  Assert-InvalidCron '时区缩写' (New-CronInput 'bad6' '0 3 * * *' 'CST' $baseOver) 'trigger.timeZone' 'format'
  Assert-InvalidCron '五年窗口无解（2 月 30）' (New-CronInput 'bad7' '0 3 30 2 *' 'UTC' $baseOver) 'trigger.expression' 'no-occurrence'
  Assert-InvalidCron '名称写法 MON' (New-CronInput 'bad8' '0 3 * * MON' 'UTC' $baseOver) 'trigger.expression' 'unsupported-part' 'day-of-week'

  # 失败矩阵后列表仍空：失败不产生任何记录
  $list0 = Invoke-Rpc 'list' @{} 'list0'
  Check ($list0.result.value.total -eq 0) '校验矩阵全部失败：不产生任何记录（total=0）'

  Step '阶段 3 · 创建 A（*/2 Asia/Shanghai）+ B（*/2 UTC，供停机错过）+ P（enabled:false 暂停）'
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $rA = Invoke-Rpc 'create' (New-CronInput 'verify-cron-a' '*/2 * * * *' 'Asia/Shanghai') 'cA'
  Check ($rA.result.ok -eq $true) "A 创建受理（kind=cron，next=$($rA.result.value.nextOccurrence)）"
  $aNext0 = To-UtcMs $rA.result.value.nextOccurrence
  Check (($aNext0 - $t0) -gt 0 -and ($aNext0 - $t0) -le 120000) 'A：首次计划在 (创建时刻, +120s] 内（严格晚于 createdAt 的下一匹配）'
  Check (Test-MinuteBoundary $aNext0) 'A：计划时刻落在分钟边界（五位 cron 分钟粒度）'

  $rB = Invoke-Rpc 'create' (New-CronInput 'verify-cron-b' '*/2 * * * *' 'UTC') 'cB'
  Check ($rB.result.ok -eq $true) "B 创建受理（next=$($rB.result.value.nextOccurrence)）"

  $rP = Invoke-Rpc 'create' (New-CronInput 'verify-cron-p' '*/2 * * * *' 'UTC' @{ enabled = $false }) 'cP'
  Check ($rP.result.ok -eq $true -and $rP.result.value.status -eq 'paused' -and $null -eq $rP.result.value.nextOccurrence) `
    'P：enabled:false → paused、nextOccurrence = null'

  Step '阶段 4 · 等 A 首次自动触发（≤130s）：run 持久化 + 下次时刻推进 + 面板字段回读'
  $wait = 130 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }

  $a = Get-LatestRun 'verify-cron-a'
  Check ($a.run -and $a.run.trigger -eq 'cron') "A：自动 run 已持久化（trigger=$($a.run.trigger) status=$($a.run.status)）"
  Check ($a.run.status -eq 'succeeded' -and $a.run.script.exitCode -eq 0 -and $a.run.script.stdoutTail -match 'CRON-MARKER-OK') `
    'A：run succeeded、exitCode=0、stdoutTail 含标记（脚本结果可回读）'
  $aSched = To-UtcMs $a.run.scheduledAt
  Check (($aSched - $t0) -gt 0 -and ($aSched - $t0) -le 130000 -and (Test-MinuteBoundary $aSched)) `
    "A：scheduledAt=计划时刻（分钟边界；$($a.run.scheduledAt)）"
  $aNext1 = To-UtcMs $a.orch.nextOccurrence
  Check (($aNext1 - $aSched) -eq 120000) "A：nextOccurrence = scheduledAt + 2 分钟（$($a.orch.nextOccurrence)）"
  # 面板回读字段：表达式、时区、下次时刻（OrchestrationView 原样）
  Check ($a.orch.trigger.kind -eq 'cron' -and $a.orch.trigger.expression -eq '*/2 * * * *' -and $a.orch.trigger.timeZone -eq 'Asia/Shanghai') `
    'A：view 回读 trigger 三件套（kind/expression/timeZone）'

  $p = Get-LatestRun 'verify-cron-p'
  Check ($p.runsCount -eq 0 -and $p.orch.status -eq 'paused' -and $null -eq $p.orch.nextOccurrence) 'P：暂停期间未触发（无 run、nextOccurrence=null）'

  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') '启动 stderr 无 script-orchestrator 错误'

  Step '阶段 5 · 记录 B 基线 → 杀宿主 → 停机跨多个计划时刻（300s）→ 冷重启'
  # 先等到 B 当前保留计划过去 ≥10s（该计划已触发并计入基线；杀宿主不再与在途计划竞态，
  # 否则杀前最后一刻的正常触发会被误计为停机新增 run）
  $b = Get-LatestRun 'verify-cron-b'
  if ($null -ne $b.orch.nextOccurrence) {
    $bNextRaw = To-UtcMs $b.orch.nextOccurrence
    $wait2 = [int](($bNextRaw + 10000 - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 1000) + 1
    if ($wait2 -gt 0) {
      Write-Host "  等待 B 保留计划（$($b.orch.nextOccurrence)）结算后取稳定基线（${wait2}s）…"
      Start-Sleep -Seconds $wait2
    }
  }
  $b = Get-LatestRun 'verify-cron-b'
  $bRuns0 = $b.runsCount
  $bNext0 = $null
  if ($null -ne $b.orch.nextOccurrence) { $bNext0 = To-UtcMs $b.orch.nextOccurrence }
  Write-Host "  B 基线：runs=$bRuns0 next=$($b.orch.nextOccurrence)"
  Stop-HeadlessHost $host1.Port
  Write-Host '  停机等待 300 秒（跨 2-3 个 */2 计划时刻）…'
  Start-Sleep -Seconds 300
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  Connect-Rpc $host2.Url $host2.Port
  Start-Sleep -Seconds 5 # 允许调度器处理过期计划（错过合并 → 触发）
  $bootAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $b2 = Get-LatestRun 'verify-cron-b'
  Check ($b2.runsCount -eq ($bRuns0 + 1)) "B：停机多次错过合并为 1 个 run（runs=$($b2.runsCount)，基线 $bRuns0 + 1，中间触发不留记录）"
  Check ($b2.run -and $b2.run.trigger -eq 'cron' -and $b2.run.status -eq 'succeeded') "B：补的 run 结算成功（trigger=$($b2.run.trigger) status=$($b2.run.status)）"
  $bSched = To-UtcMs $b2.run.scheduledAt
  $schedOk = (Test-MinuteBoundary $bSched) -and ($bSched -le $bootAt) -and
    ($null -eq $bNext0 -or $bSched -ge $bNext0)
  Check $schedOk "B：scheduledAt=最近一次错过的计划时刻（分钟边界 ≤ 重启时刻；$($b2.run.scheduledAt)）"
  $bNext2 = To-UtcMs $b2.orch.nextOccurrence
  Check (($bNext2 - $bootAt) -gt 0 -and ($bNext2 - $bootAt) -le 125000) "B：重启后 nextOccurrence 为未来计划（≤2 分钟内；$($b2.orch.nextOccurrence)）"
  $bSchedMin = [DateTimeOffset]::FromUnixTimeMilliseconds($bSched).UtcDateTime.Minute
  $bNextMin = [DateTimeOffset]::FromUnixTimeMilliseconds($bNext2).UtcDateTime.Minute
  Check (($bSchedMin % 2 -eq 0) -and ($bNextMin % 2 -eq 0)) "B：合并时刻与下一计划都在 */2 匹配边界（$bSchedMin / $bNextMin 分）"

  $p2 = Get-LatestRun 'verify-cron-p'
  Check ($p2.runsCount -eq 0 -and $p2.orch.status -eq 'paused' -and $null -eq $p2.orch.nextOccurrence) 'P：暂停的编排重启后不补跑（无 run、仍 paused）'

  # A 的未来计划在重启后同样保留（杀宿主时 A.next 已推进；重启时若已过期会合并补一次——只断言计划形状）
  $a2 = Get-LatestRun 'verify-cron-a'
  $aNext2Ms = $null
  if ($null -ne $a2.orch.nextOccurrence) { $aNext2Ms = To-UtcMs $a2.orch.nextOccurrence }
  Check ($a2.orch.status -eq 'active' -and $null -ne $aNext2Ms -and (Test-MinuteBoundary $aNext2Ms)) `
    "A：重启后仍 active 且计划在分钟边界（next=$($a2.orch.nextOccurrence)）"

  $bootErr2 = Get-Content $host2.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr2 -or $bootErr2 -notmatch 'script-orchestrator') '重启 stderr 无 script-orchestrator 错误'

  Stop-HeadlessHost $host2.Port
}
finally {
  Step '清理 · 杀沙箱宿主进程'
  foreach ($stem in 'boot1', 'boot2') {
    $log = Join-Path $Sandbox "$stem.out.log"
    if (Test-Path $log) {
      $raw = Get-Content $log -Raw -ErrorAction SilentlyContinue
      if ($raw) {
        $m = [regex]::Match($raw, 'https?://127\.0\.0\.1:(\d+)/')
        if ($m.Success) { Stop-HeadlessHost ([int]$m.Groups[1].Value) }
      }
    }
  }
  if (-not $KeepSandbox -and $script:Failures.Count -eq 0) {
    Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
    Write-Host '  沙箱已删除（-KeepSandbox 可保留）'
  }
}

Step '结果'
if ($script:Failures.Count -eq 0) {
  Write-Host '  全部断言通过 ✔' -ForegroundColor Green
  exit 0
}
else {
  Write-Host "  $($script:Failures.Count) 项失败：" -ForegroundColor Red
  $script:Failures | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
  exit 1
}

