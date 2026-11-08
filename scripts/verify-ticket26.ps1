#Requires -Version 7
# 票 26 隔离集成验证：安装 → 无头启动 → 并行创建 6 个 every 编排（fixed-rate 相位推进 /
# fixed-delay 等待结算与推进 / 超时兜底 terminate（后代拖死场景）/ spawn_failed（cwd 不存在）/
# 非零退出≠失败 / 崩溃恢复 interrupted）→ 自动触发一轮 → 断言 run 结果与下次时刻 →
# 杀宿主重启验证启动维护。绝不触碰真实用户 profile（独立 DSH_HOME）。
# 终止无头实例按笔记 02：杀端口监听进程（宿主本体）。
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

$Sandbox = Join-Path $RepoRoot '.sandbox\s26'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch26'
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
  "name": "dsh-profile-orch26",
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

function Invoke-Rpc($session, [int]$port, [string]$endpoint, $payload, [string]$rpcId = 'verify26') {
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

# 取该编排最新一条 run（view 默认按 scheduledAt 倒序）
function Get-LatestRun($session, [int]$port, [string]$id) {
  $v = Invoke-Rpc $session $port 'view' @{ id = $id } "run-$id"
  return @{ orch = $v.result.value; run = @($v.result.value.runs)[0] }
}

# 编排脚本统一用绝对 node 路径（宿主 PATH 不保证）；everySeconds=60 触发一轮
function New-Input([string]$id, [string]$mode, [string[]]$scriptArgs, [hashtable]$scriptOver = @{}) {
  $script = @{ command = $Node; args = $scriptArgs; cwd = $RepoRoot }
  foreach ($k in $scriptOver.Keys) { $script[$k] = $scriptOver[$k] }
  return @{
    id = $id
    title = "验证 $id"
    trigger = @{ kind = 'every'; everySeconds = 60; mode = $mode }
    script = $script
    judge = @{ rules = @(); fallback = @() }
    actions = @{}
  }
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在（$Node）"
  Check (Test-Path $Dsh) "dsh.cmd 存在（$Dsh）"
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\runner.js')) 'pkg/lib/runner.js 存在'

  Step '阶段 1 · 隔离 profile 建立（file: 依赖指向 worktree pkg）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\runner.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 2 · 无头启动 + 并行创建 6 个 every 编排'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  $session1 = Get-AuthenticatedSession $host1.Url
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  # A · fixed-rate 正常退出（判定零动作 → succeeded，相位按 scheduledAt 推进）
  $rA = Invoke-Rpc $session1 $host1.Port 'create' (New-Input 'verify-rate' 'fixed-rate' @('-e', 'console.log("MARKER-A-OK")')) 'cA'
  # B · fixed-delay 结算推进（脚本 8 秒：观察 running + next=null，再观察 settled + next=settledAt+60）
  $rB = Invoke-Rpc $session1 $host1.Port 'create' (New-Input 'verify-delay' 'fixed-delay' @('-e', 'new Promise(r => setTimeout(r, 8000)).then(() => console.log("MARKER-B-DONE"))')) 'cB'
  # C · 父退出留后代 + timeoutSeconds=3 → 超时兜底 terminate（Job 语义）+ 后代被清理
  $parentScript = 'const {spawn} = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"}); console.log("DESC:" + c.pid)'
  $rC = Invoke-Rpc $session1 $host1.Port 'create' (New-Input 'verify-desc' 'fixed-rate' @('-e', $parentScript) @{ timeoutSeconds = 3 }) 'cC'
  # D · cwd 不存在 → spawn 前预检 spawn_failed → failed
  $rD = Invoke-Rpc $session1 $host1.Port 'create' (New-Input 'verify-spawn' 'fixed-rate' @('-e', '1') @{ cwd = 'D:\definitely\missing\dir-26' }) 'cD'
  # E · 非零退出（exit 3）零动作 → 不是执行失败
  $rE = Invoke-Rpc $session1 $host1.Port 'create' (New-Input 'verify-exit3' 'fixed-rate' @('-e', 'process.exit(3)')) 'cE'
  # H · fixed-delay + 60 秒长脚本 → 用于崩溃恢复 interrupted（CJS 无顶层 await）
  $rH = Invoke-Rpc $session1 $host1.Port 'create' (New-Input 'verify-crash' 'fixed-delay' @('-e', 'new Promise(r => setTimeout(r, 60000)).then(() => console.log("H-DONE"))')) 'cH'
  foreach ($pair in @(@('A', $rA), @('B', $rB), @('C', $rC), @('D', $rD), @('E', $rE), @('H', $rH))) {
    Check ($pair[1].result.ok -eq $true) "create $($pair[0]) 受理（next=$($pair[1].result.value.nextOccurrence)）"
  }

  Step '阶段 3 · 等 T+63s：第一轮触发（B/H 仍在执行，A/C/D/E 已结算）'
  $wait = 63 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }

  $a = Get-LatestRun $session1 $host1.Port 'verify-rate'
  Check ($a.run -and $a.run.status -eq 'succeeded' -and $a.run.script.exitCode -eq 0) "A fixed-rate：run succeeded、exitCode=0（status=$($a.run.status) exit=$($a.run.script.exitCode)）"
  Check ($a.run.script.stdoutTail -match 'MARKER-A-OK') 'A：stdoutTail 含标记'
  $aNext = To-UtcMs $a.orch.nextOccurrence
  $aSched = To-UtcMs $a.run.scheduledAt
  Check (($aNext - $aSched) -eq 60000) "A：nextOccurrence 相位推进 = scheduledAt + 60s（不按结算时刻）"

  $b = Get-LatestRun $session1 $host1.Port 'verify-delay'
  Check ($b.run -and @('running', 'judging', 'dispatching') -contains $b.run.status) "B fixed-delay：run 未结算（status=$($b.run.status)，中途态经内存视图可见）"
  Check ($b.orch.nextOccurrence -eq $null) 'B：执行期间 nextOccurrence = null（等待结算）'

  # D/E：触发已发生（并发额度 2，A/B/C 先占槽；D/E 处于排队——终态断言在阶段 4）
  $d = Get-LatestRun $session1 $host1.Port 'verify-spawn'
  Check ($d.run -and $d.run.status) "D：run 记录已创建（status=$($d.run.status)）"
  $e = Get-LatestRun $session1 $host1.Port 'verify-exit3'
  Check ($e.run -and $e.run.status) "E：run 记录已创建（status=$($e.run.status)）"

  Step '阶段 4 · 等 T+80s：B 结算推进、C 超时兜底与后代清理、D/E 终态'
  $wait = 80 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }

  $b2 = Get-LatestRun $session1 $host1.Port 'verify-delay'
  Check ($b2.run.status -eq 'succeeded' -and $b2.run.script.stdoutTail -match 'MARKER-B-DONE') 'B：结算 succeeded、输出含标记'
  $bSettled = To-UtcMs $b2.run.settledAt
  $bNext = To-UtcMs $b2.orch.nextOccurrence
  Check (($bNext - $bSettled) -ge 59000 -and ($bNext - $bSettled) -le 61000) "B：nextOccurrence = settledAt + 60s（fixed-delay 从结算推进；settled=$bSettled next=$bNext）"

  $d2 = Get-LatestRun $session1 $host1.Port 'verify-spawn'
  Check ($d2.run.status -eq 'failed' -and ($d2.run.script.warnings -join '') -match 'spawn_failed') "D：目录不存在 → failed + warnings spawn_failed（status=$($d2.run.status)）"

  $e2 = Get-LatestRun $session1 $host1.Port 'verify-exit3'
  Check ($e2.run.status -eq 'succeeded' -and $e2.run.script.exitCode -eq 3) 'E：非零退出（exit 3）零动作 → succeeded（不是执行失败）'

  $c = Get-LatestRun $session1 $host1.Port 'verify-desc'
  Check ($c.run.status -eq 'succeeded' -and $c.run.script.timedOut -eq $true -and $c.run.script.exitCode -eq 1) `
    "C：父退出留后代 → 超时兜底 terminate → timedOut=true + Job 语义 exitCode=1（status=$($c.run.status) timedOut=$($c.run.script.timedOut) exit=$($c.run.script.exitCode)）"
  $m = [regex]::Match([string]$c.run.script.stdoutTail, 'DESC:(\d+)')
  if ($m.Success) {
    $descPid = [int]$m.Groups[1].Value
    Start-Sleep -Seconds 1
    $alive = $null -ne (Get-Process -Id $descPid -ErrorAction SilentlyContinue)
    Check (-not $alive) "C：后代进程 pid=$descPid 已被 terminate 清理（进程树生命周期以 run 为上限）"
  }
  else { Check $false 'C：stdoutTail 未包含 DESC:<pid> 标记' }

  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') '启动 stderr 无 script-orchestrator 错误'

  Step '阶段 5 · 杀宿主（H 的 run 仍在 running）→ 冷重启 → interrupted + fixed-delay 恢复推进'
  $h = Get-LatestRun $session1 $host1.Port 'verify-crash'
  Check ($h.run -and $h.run.status -eq 'running') "H：杀宿主前 run 仍在执行（status=$($h.run.status)）"
  Stop-HeadlessHost $host1.Port
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  $session2 = Get-AuthenticatedSession $host2.Url
  $bootAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $h2 = Get-LatestRun $session2 $host2.Port 'verify-crash'
  Check ($h2.run -and $h2.run.status -eq 'interrupted') "H：重启后 run 标 interrupted（status=$($h2.run.status)，启动维护收尾）"
  # nextOccurrence ≈ interrupted settledAt（启动维护时刻，早于 bootAt 数秒内）+ 60s
  $h2Next = To-UtcMs $h2.orch.nextOccurrence
  Check (($h2Next - $bootAt) -ge 54000 -and ($h2Next - $bootAt) -le 61000) `
    "H：fixed-delay 从恢复结算时刻推进（next ≈ 恢复时刻 + 60s；next=$h2Next bootAt=$bootAt）"
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
