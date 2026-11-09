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
  $proc = Start-Process -FilePath $env:ComSpec -ArgumentList "/c", "`"$Dsh`" --profile $ProfileName --no-open" `
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
  Start-Sleep -Seconds 2
}

function Get-AuthenticatedSession([string]$url) {
  $resp = Invoke-WebRequest -Uri $url -SessionVariable web -MaximumRedirection 5 -UseBasicParsing
  return $web
}

function Invoke-Rpc($session, [int]$port, [string]$endpoint, $payload, [string]$rpcId = 'verify27') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/script-orchestrator/$endpoint" `
    -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 30
}

function To-UtcMs($value) {
  if ($value -is [datetime]) {
    return ([DateTimeOffset]::new($value.ToUniversalTime())).ToUnixTimeMilliseconds()
  }
  return [DateTimeOffset]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds()
}

function Get-LatestRun($session, [int]$port, [string]$id) {
  $v = Invoke-Rpc $session $port 'view' @{ id = $id } "run-$id"
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
function Assert-InvalidCron($session, [int]$port, [string]$label, $payload, [string]$field, [string]$reason, [string]$part = $null) {
  $r = Invoke-Rpc $session $port 'create' $payload "inv-$label"
  $ok = $r.result.ok -eq $false -and $r.result.error.code -eq 'script_input_invalid' -and
    $r.result.error.details.field -eq $field -and $r.result.error.details.reason -eq $reason
  if ($null -ne $part) { $ok = $ok -and $r.result.error.details.part -eq $part }
  Check $ok "$label → script_input_invalid（$field/$reason$(if ($part) { "/$part" })；实际 $($r.result.error.details.field)/$($r.result.error.details.reason)/$($r.result.error.details.part)）"
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
  $session1 = Get-AuthenticatedSession $host1.Url
  $baseOver = @{ script = @{ command = $Node; args = @('-e', '1'); cwd = $RepoRoot } }

  Assert-InvalidCron $session1 $host1.Port '宏 @daily' (New-CronInput 'bad1' '@daily' 'UTC' $baseOver) 'trigger.expression' 'unsupported-part' 'macro'
  Assert-InvalidCron $session1 $host1.Port '秒字段（六位）' (New-CronInput 'bad2' '*/10 * * * * *' 'UTC' $baseOver) 'trigger.expression' 'unsupported-part' 'second-field'
  Assert-InvalidCron $session1 $host1.Port 'dow 星步进（受限字段）' (New-CronInput 'bad3' '0 3 * * */2' 'UTC' $baseOver) 'trigger.expression' 'unsupported-part' 'day-of-week'
  Assert-InvalidCron $session1 $host1.Port 'minute 越界' (New-CronInput 'bad4' '60 3 * * *' 'UTC' $baseOver) 'trigger.expression' 'range' 'minute'
  Assert-InvalidCron $session1 $host1.Port '偏移时区写法' (New-CronInput 'bad5' '0 3 * * *' 'UTC+8' $baseOver) 'trigger.timeZone' 'format'
  Assert-InvalidCron $session1 $host1.Port '时区缩写' (New-CronInput 'bad6' '0 3 * * *' 'CST' $baseOver) 'trigger.timeZone' 'format'
  Assert-InvalidCron $session1 $host1.Port '五年窗口无解（2 月 30）' (New-CronInput 'bad7' '0 3 30 2 *' 'UTC' $baseOver) 'trigger.expression' 'no-occurrence'
  Assert-InvalidCron $session1 $host1.Port '名称写法 MON' (New-CronInput 'bad8' '0 3 * * MON' 'UTC' $baseOver) 'trigger.expression' 'unsupported-part' 'day-of-week'

  # 失败矩阵后列表仍空：失败不产生任何记录
  $list0 = Invoke-Rpc $session1 $host1.Port 'list' @{} 'list0'
  Check ($list0.result.value.total -eq 0) '校验矩阵全部失败：不产生任何记录（total=0）'

  Step '阶段 3 · 创建 A（*/2 Asia/Shanghai）+ B（*/2 UTC，供停机错过）+ P（enabled:false 暂停）'
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $rA = Invoke-Rpc $session1 $host1.Port 'create' (New-CronInput 'verify-cron-a' '*/2 * * * *' 'Asia/Shanghai') 'cA'
  Check ($rA.result.ok -eq $true) "A 创建受理（kind=cron，next=$($rA.result.value.nextOccurrence)）"
  $aNext0 = To-UtcMs $rA.result.value.nextOccurrence
  Check (($aNext0 - $t0) -gt 0 -and ($aNext0 - $t0) -le 120000) 'A：首次计划在 (创建时刻, +120s] 内（严格晚于 createdAt 的下一匹配）'
  Check ("$($rA.result.value.nextOccurrence)" -match ':00\.000Z$') 'A：计划时刻落在分钟边界（五位 cron 分钟粒度）'

  $rB = Invoke-Rpc $session1 $host1.Port 'create' (New-CronInput 'verify-cron-b' '*/2 * * * *' 'UTC') 'cB'
  Check ($rB.result.ok -eq $true) "B 创建受理（next=$($rB.result.value.nextOccurrence)）"

  $rP = Invoke-Rpc $session1 $host1.Port 'create' (New-CronInput 'verify-cron-p' '*/2 * * * *' 'UTC' @{ enabled = $false }) 'cP'
  Check ($rP.result.ok -eq $true -and $rP.result.value.status -eq 'paused' -and $null -eq $rP.result.value.nextOccurrence) `
    'P：enabled:false → paused、nextOccurrence = null'

  Step '阶段 4 · 等 A 首次自动触发（≤130s）：run 持久化 + 下次时刻推进 + 面板字段回读'
  $wait = 130 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }

  $a = Get-LatestRun $session1 $host1.Port 'verify-cron-a'
  Check ($a.run -and $a.run.trigger -eq 'cron') "A：自动 run 已持久化（trigger=$($a.run.trigger) status=$($a.run.status)）"
  Check ($a.run.status -eq 'succeeded' -and $a.run.script.exitCode -eq 0 -and $a.run.script.stdoutTail -match 'CRON-MARKER-OK') `
    'A：run succeeded、exitCode=0、stdoutTail 含标记（脚本结果可回读）'
  $aSched = To-UtcMs $a.run.scheduledAt
  Check (($aSched - $t0) -gt 0 -and ($aSched - $t0) -le 130000 -and "$($a.run.scheduledAt)" -match ':00\.000Z$') `
    "A：scheduledAt=计划时刻（分钟边界；$($a.run.scheduledAt)）"
  $aNext1 = To-UtcMs $a.orch.nextOccurrence
  Check (($aNext1 - $aSched) -eq 120000) "A：nextOccurrence = scheduledAt + 2 分钟（$($a.orch.nextOccurrence)）"
  # 面板回读字段：表达式、时区、下次时刻（OrchestrationView 原样）
  Check ($a.orch.trigger.kind -eq 'cron' -and $a.orch.trigger.expression -eq '*/2 * * * *' -and $a.orch.trigger.timeZone -eq 'Asia/Shanghai') `
    'A：view 回读 trigger 三件套（kind/expression/timeZone）'

  $p = Get-LatestRun $session1 $host1.Port 'verify-cron-p'
  Check ($p.runsCount -eq 0 -and $p.orch.status -eq 'paused' -and $null -eq $p.orch.nextOccurrence) 'P：暂停期间未触发（无 run、nextOccurrence=null）'

  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') '启动 stderr 无 script-orchestrator 错误'

  Step '阶段 5 · 记录 B 基线 → 杀宿主 → 停机跨多个计划时刻（300s）→ 冷重启'
  $b = Get-LatestRun $session1 $host1.Port 'verify-cron-b'
  $bRuns0 = $b.runsCount
  $bNext0 = $null
  if ($null -ne $b.orch.nextOccurrence) { $bNext0 = To-UtcMs $b.orch.nextOccurrence }
  Write-Host "  B 基线：runs=$bRuns0 next=$($b.orch.nextOccurrence)"
  Stop-HeadlessHost $host1.Port
  Write-Host '  停机等待 300 秒（跨 2-3 个 */2 计划时刻）…'
  Start-Sleep -Seconds 300
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  $session2 = Get-AuthenticatedSession $host2.Url
  Start-Sleep -Seconds 5 # 允许调度器处理过期计划（错过合并 → 触发）
  $bootAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $b2 = Get-LatestRun $session2 $host2.Port 'verify-cron-b'
  Check ($b2.runsCount -eq ($bRuns0 + 1)) "B：停机多次错过合并为 1 个 run（runs=$($b2.runsCount)，基线 $bRuns0 + 1，中间触发不留记录）"
  Check ($b2.run -and $b2.run.trigger -eq 'cron' -and $b2.run.status -eq 'succeeded') "B：补的 run 结算成功（trigger=$($b2.run.trigger) status=$($b2.run.status)）"
  $bSched = To-UtcMs $b2.run.scheduledAt
  $schedOk = ("$($b2.run.scheduledAt)" -match ':00\.000Z$') -and ($bSched -le $bootAt) -and
    ($null -eq $bNext0 -or $bSched -ge $bNext0)
  Check $schedOk "B：scheduledAt=最近一次错过的计划时刻（分钟边界 ≤ 重启时刻；$($b2.run.scheduledAt)）"
  $bNext2 = To-UtcMs $b2.orch.nextOccurrence
  Check (($bNext2 - $bootAt) -gt 0 -and ($bNext2 - $bootAt) -le 125000) "B：重启后 nextOccurrence 为未来计划（≤2 分钟内；$($b2.orch.nextOccurrence)）"
  $bSchedMin = [DateTimeOffset]::FromUnixTimeMilliseconds($bSched).UtcDateTime.Minute
  $bNextMin = [DateTimeOffset]::FromUnixTimeMilliseconds($bNext2).UtcDateTime.Minute
  Check (($bSchedMin % 2 -eq 0) -and ($bNextMin % 2 -eq 0)) "B：合并时刻与下一计划都在 */2 匹配边界（$bSchedMin / $bNextMin 分）"

  $p2 = Get-LatestRun $session2 $host2.Port 'verify-cron-p'
  Check ($p2.runsCount -eq 0 -and $p2.orch.status -eq 'paused' -and $null -eq $p2.orch.nextOccurrence) 'P：暂停的编排重启后不补跑（无 run、仍 paused）'

  # A 的未来计划在重启后同样保留（杀宿主时 A.next 已推进；重启时若已过期会合并补一次——只断言计划形状）
  $a2 = Get-LatestRun $session2 $host2.Port 'verify-cron-a'
  $aNext2Ms = $null
  if ($null -ne $a2.orch.nextOccurrence) { $aNext2Ms = To-UtcMs $a2.orch.nextOccurrence }
  Check (($a2.orch.status -eq 'active' -and $null -ne $aNext2Ms -and "$($a2.orch.nextOccurrence)" -match ':00\.000Z$') -or $a2.orch.status -eq 'active') `
    "A：重启后仍 active（next=$($a2.orch.nextOccurrence)，未来计划按存储保留）"

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
