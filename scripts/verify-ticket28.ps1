#Requires -Version 7
# 票 28 隔离集成验证：安装 → 无头启动（--port 0 动态端口）→ 经桥驱动：
# update 非调度不重锚 + 调度字段重锚（编辑表）→ CAS 冲突/匹配 → cron 更新无解拒绝 →
# pause/resume 幂等与恢复重锚 → 暂停期间不补跑（等待跨过计划时刻）→ run 受理即返回 +
# 手动 run 不改自动计划 + paused 手动放行 → delete 暂不支持准确错误。绝不触碰真实用户
# profile（独立 DSH_HOME）；终止按端口监听进程杀（笔记 02 + 票 27 Comments 自修经验）。
[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
  [switch]$KeepSandbox
)
$ErrorActionPreference = 'Stop'

$Node = 'C:\Users\cezre\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$Pnpm = 'C:\Users\cezre\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$Dsh = 'C:\Users\cezre\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$PkgName = '@echo/dsh-script-orchestrator'

$Sandbox = Join-Path $RepoRoot '.sandbox\s28'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch28'
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
  "name": "dsh-profile-orch28",
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
    & $Node $Pnpm install --no-frozen-lockfile --reporter=append-only 2>&1 | Select-Object -Last 3 | Write-Host
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
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $still) { Write-Host "  端口 $Port 已释放"; return }
  }
  Write-Host "  警告：端口 $Port 在 20 秒后仍被监听" -ForegroundColor Yellow
}

$script:RpcUrl = $null
$script:RpcPort = 0
$script:RpcSession = $null

function Connect-Rpc([string]$url, [int]$port) {
  $script:RpcUrl = $url
  $script:RpcPort = $port
  $resp = Invoke-WebRequest -Uri $url -SessionVariable web -MaximumRedirection 5 -UseBasicParsing
  $script:RpcSession = $web
}

function Invoke-Rpc([string]$endpoint, $payload, [string]$rpcId = 'verify28') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  $uri = "http://127.0.0.1:$($script:RpcPort)/script-orchestrator/$endpoint"
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      return Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $body -WebSession $script:RpcSession -TimeoutSec 60
    }
    catch {
      $status = $null
      if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
      if ($attempt -eq 1 -and ($status -eq 401 -or "$_" -match 'unauthorized')) {
        Write-Host "  （会话过期，重建 web 会话后重试 $endpoint）"
        $resp = Invoke-WebRequest -Uri $script:RpcUrl -SessionVariable web2 -MaximumRedirection 5 -UseBasicParsing
        $script:RpcSession = $web2
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

function New-Input([string]$id, $trigger, [hashtable]$over = @{}) {
  $input = @{
    id = $id
    title = "验证 $id"
    trigger = $trigger
    script = @{ command = $Node; args = @('-e', 'console.log("T28-MARKER-OK")'); cwd = $RepoRoot }
    judge = @{ rules = @(); fallback = @() }
    actions = @{}
  }
  foreach ($k in $over.Keys) { $input[$k] = $over[$k] }
  return $input
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在"
  Check (Test-Path $Dsh) 'dsh.cmd 存在'
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\service.js')) 'pkg/lib/service.js 存在'

  Step '阶段 1 · 隔离 profile 建立'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\service.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 2 · 无头启动 + 创建 A/B/C 三编排'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  Connect-Rpc $host1.Url $host1.Port

  $rA = Invoke-Rpc 'create' (New-Input 'v28-a' @{ kind = 'every'; everySeconds = 60 }) 'cA'
  $aCreateMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Check ($rA.result.ok -eq $true) "A（every 60s）创建受理（next=$($rA.result.value.nextOccurrence)）"
  $aNext0 = To-UtcMs $rA.result.value.nextOccurrence
  Check (($aNext0 - $aCreateMs) -gt 0 -and ($aNext0 - $aCreateMs) -le 60000) 'A：next = createdAt + 60s'

  $rB = Invoke-Rpc 'create' (New-Input 'v28-b' @{ kind = 'cron'; expression = '*/2 * * * *'; timeZone = 'Asia/Shanghai' }) 'cB'
  Check ($rB.result.ok -eq $true) "B（cron */2 上海）创建受理"
  $rC = Invoke-Rpc 'create' (New-Input 'v28-c' @{ kind = 'every'; everySeconds = 3600 } @{ enabled = $false }) 'cC'
  Check ($rC.result.ok -eq $true -and $rC.result.value.status -eq 'paused') 'C（enabled:false）创建为 paused'

  Step '阶段 3 · update：非调度不重锚、调度字段重锚、CAS'
  $a1 = Invoke-Rpc 'edit' @{ id = 'v28-a'; action = 'update'; patch = @{ title = 'renamed-a' } } 'eA1'
  Check ($a1.result.ok -eq $true -and $a1.result.value.title -eq 'renamed-a') 'A：title 更新生效'
  Check ((To-UtcMs $a1.result.value.nextOccurrence) -eq $aNext0) 'A：非调度编辑不重锚（nextOccurrence 不变）'

  # CAS：用过期 expectedUpdatedAt → conflict；用当前值 → 通过
  #（details.expected 反序列化为 DateTime，断言只验键存在与 code）
  $stale = Invoke-Rpc 'edit' @{ id = 'v28-a'; action = 'pause'; expectedUpdatedAt = '2020-01-01T00:00:00.000Z' } 'eA2'
  Check ($stale.result.ok -eq $false -and $stale.result.error.code -eq 'script_conflict' -and
    $null -ne $stale.result.error.details.expected -and $null -ne $stale.result.error.details.actual) 'A：CAS 不匹配 → script_conflict（expected/actual）'

  $tBeforeSched = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $a2 = Invoke-Rpc 'edit' @{ id = 'v28-a'; action = 'update'; expectedUpdatedAt = $a1.result.value.updatedAt; patch = @{ trigger = @{ kind = 'every'; everySeconds = 120; mode = 'fixed-rate' } } } 'eA3'
  $tAfterSched = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Check ($a2.result.ok -eq $true -and $a2.result.value.trigger.everySeconds -eq 120) 'A：调度编辑（60→120s）+ CAS 匹配通过'
  $aNext2 = To-UtcMs $a2.result.value.nextOccurrence
  Check (($aNext2 - $tBeforeSched) -ge 120000 -and ($aNext2 - $tAfterSched) -le 120000) "A：编辑表重锚 next = editedAt + 新间隔（next=$($a2.result.value.nextOccurrence)）"

  Step '阶段 4 · B（cron）更新：表达式重锚 + 无解拒绝'
  $b1 = Invoke-Rpc 'edit' @{ id = 'v28-b'; action = 'update'; patch = @{ trigger = @{ kind = 'cron'; expression = '0 3 * * *'; timeZone = 'Asia/Shanghai' } } } 'eB1'
  Check ($b1.result.ok -eq $true -and $b1.result.value.trigger.expression -eq '0 3 * * *') 'B：cron 表达式更新生效'
  $bNext = To-UtcMs $b1.result.value.nextOccurrence
  $bDate = [DateTimeOffset]::FromUnixTimeMilliseconds($bNext).UtcDateTime
  Check (($bDate.Hour -eq 19) -and ($bDate.Minute -eq 0) -and ($bDate.Second -eq 0)) "B：重锚到本地 03:00（UTC 19:00；next=$($b1.result.value.nextOccurrence)）"

  $bBad = Invoke-Rpc 'edit' @{ id = 'v28-b'; action = 'update'; patch = @{ trigger = @{ kind = 'cron'; expression = '0 3 30 2 *'; timeZone = 'UTC' } } } 'eB2'
  Check ($bBad.result.ok -eq $false -and $bBad.result.error.code -eq 'script_input_invalid' -and
    $bBad.result.error.details.field -eq 'trigger.expression' -and $bBad.result.error.details.reason -eq 'no-occurrence') 'B：更新到永无解 cron → no-occurrence 拒绝'
  $bCheck = Invoke-Rpc 'view' @{ id = 'v28-b' } 'vB'
  Check ($bCheck.result.value.trigger.expression -eq '0 3 * * *') 'B：拒绝后记录保持原表达式'

  Step '阶段 5 · run 手动执行：受理即返回、不改自动计划、paused 放行'
  $manualA = Invoke-Rpc 'run' @{ id = 'v28-a' } 'rA'
  Check ($manualA.result.ok -eq $true -and $manualA.result.value.runId -and
    @('queued', 'running', 'succeeded') -contains $manualA.result.value.status) "A：run 受理即返回简形（runId + status=$($manualA.result.value.status)）"
  Start-Sleep -Seconds 4
  $aView = Invoke-Rpc 'view' @{ id = 'v28-a' } 'vA'
  $manualRun = @($aView.result.value.runs) | Where-Object { $_.trigger -eq 'manual' } | Select-Object -First 1
  Check ($manualRun -and $manualRun.status -eq 'succeeded' -and $manualRun.script.exitCode -eq 0 -and
    $manualRun.script.stdoutTail -match 'T28-MARKER-OK') 'A：手动 run 结算 succeeded、输出含标记（view 回读）'
  Check ((To-UtcMs $aView.result.value.nextOccurrence) -eq $aNext2) 'A：手动 run 不改下次自动触发时刻'

  $manualC = Invoke-Rpc 'run' @{ id = 'v28-c' } 'rC'
  Check ($manualC.result.ok -eq $true) 'C：paused 编排手动执行放行（拒绝仅 id 不存在）'
  Start-Sleep -Seconds 4
  $cView = Invoke-Rpc 'view' @{ id = 'v28-c' } 'vC'
  $cRun = @($cView.result.value.runs) | Where-Object { $_.trigger -eq 'manual' } | Select-Object -First 1
  Check ($cRun -and $cRun.status -eq 'succeeded') 'C：paused 手动 run 结算成功（执行后编排状态不变）'
  Check ($cView.result.value.status -eq 'paused') 'C：手动执行后编排仍 paused'

  $runUnknown = Invoke-Rpc 'run' @{ id = 'nope' } 'rX'
  Check ($runUnknown.result.ok -eq $false -and $runUnknown.result.error.code -eq 'script_unknown') 'run 未知 id → script_unknown'

  Step '阶段 6 · pause/resume：幂等 no-op、恢复重锚、暂停期间不补跑'
  $pause1 = Invoke-Rpc 'edit' @{ id = 'v28-a'; action = 'pause' } 'pA'
  Check ($pause1.result.ok -eq $true -and $pause1.result.value.status -eq 'paused' -and
    $null -eq $pause1.result.value.nextOccurrence) 'A：pause 生效（paused + next=null）'
  $pauseAgain = Invoke-Rpc 'edit' @{ id = 'v28-a'; action = 'pause' } 'pA2'
  Check ($pauseAgain.result.value.updatedAt -eq $pause1.result.value.updatedAt) 'A：重复 pause 幂等 no-op（updatedAt 不变）'

  # 暂停后等待跨过 A 的自动计划时刻（next2 距 pause 约 ≤120s；等 130s 覆盖）
  $waitUntil = [DateTimeOffset]::UtcNow.AddSeconds(130)
  Write-Host "  暂停中等待跨过自动计划时刻（next=$($a2.result.value.nextOccurrence)）…"
  while ([DateTimeOffset]::UtcNow -lt $waitUntil) { Start-Sleep -Seconds 5 }

  $aPaused = Invoke-Rpc 'view' @{ id = 'v28-a' } 'vA2'
  $autoRuns = @($aPaused.result.value.runs) | Where-Object { $_.trigger -eq 'every' }
  Check ($autoRuns.Count -eq 0) "A：暂停期间不补跑（every run 数 = $($autoRuns.Count)）"
  Check ($aPaused.result.value.status -eq 'paused' -and $null -eq $aPaused.result.value.nextOccurrence) 'A：暂停状态与 next=null 保持'

  $resumeBefore = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $resume = Invoke-Rpc 'edit' @{ id = 'v28-a'; action = 'resume' } 'rsm'
  $resumeAfter = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Check ($resume.result.ok -eq $true -and $resume.result.value.status -eq 'active') 'A：resume 生效（active）'
  $rNext = To-UtcMs $resume.result.value.nextOccurrence
  Check (($rNext - $resumeBefore) -ge 120000 -and ($rNext - $resumeAfter) -le 120000) "A：恢复重锚 next = resumedAt + 120s（不补暂停期）"

  $resumeActive = Invoke-Rpc 'edit' @{ id = 'v28-a'; action = 'resume' } 'rsm2'
  Check ($resumeActive.result.value.nextOccurrence -eq $resume.result.value.nextOccurrence) 'A：active 上 resume 幂等 no-op（不重锚）'

  Step '阶段 7 · delete 已交付（票 29）：级联删除 + 记录不可见 + stderr 检查'
  $del = Invoke-Rpc 'edit' @{ id = 'v28-a'; action = 'delete' } 'del'
  Check ($del.result.ok -eq $true -and $del.result.value.id -eq 'v28-a' -and [int]$del.result.value.removedRuns -ge 1) "delete 级联删除 A 成功（removedRuns=$($del.result.value.removedRuns)）"
  $goneView = Invoke-Rpc 'view' @{ id = 'v28-a' } 'vA3'
  Check ($goneView.result.ok -eq $false -and $goneView.result.error.code -eq 'script_unknown') 'delete 后 view → script_unknown（记录不可见）'
  $listAfterDel = Invoke-Rpc 'list' @{} 'listDel'
  Check (@($listAfterDel.result.value.items | ForEach-Object { $_.id }) -notcontains 'v28-a') 'delete 后 list 不含已删编排'

  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') 'stderr 无 script-orchestrator 错误'

  Stop-HeadlessHost $host1.Port
}
finally {
  Step '清理 · 杀沙箱宿主进程'
  foreach ($stem in 'boot1') {
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
