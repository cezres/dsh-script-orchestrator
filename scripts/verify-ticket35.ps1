#Requires -Version 7
# 票 35 隔离集成验证（Windows，两次冷启动）：
#   启动 1（maxRunsPerOrchestration=2）：A（短脚本）手动跑 2 次结算 → A 有 2 条 run；
#     B（30s 长脚本）手动跑后 2s 杀宿主 → B 的 run 在磁盘上仍为非终态。
#   改配置 maxRunsPerOrchestration=1 后启动 2（模拟运维在停机期调低保留上限）：
#     ① 启动维护：B 的 run 标 interrupted（settledAt=恢复时刻）；A 的 2 条 settled run
#       按启动保留对账补裁为 1 条（settledAt 定序，保留最新）；
#     ② 恢复后服务可用：list/view 权威回读、A 可再次手动执行且仍受保留上限约束（1 条）。
# 绝不触碰真实用户 profile（独立 DSH_HOME）；无头宿主 --port 0；终止按端口监听进程杀。
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

$Sandbox = Join-Path $RepoRoot '.sandbox\s35'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch35'
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

function Write-ProfileConfig([int]$maxRunsPerOrchestration) {
  $patch = @"
- id: script-orchestrator
  config:
    maxRunsPerOrchestration: $maxRunsPerOrchestration
"@
  Set-Content -Path (Join-Path $ProfileDir 'cordis.patch.yml') -Value $patch -Encoding utf8NoBOM
}

function New-SandboxProfile {
  Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $pkgJson = @"
{
  "name": "dsh-profile-orch35",
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
  Write-ProfileConfig 2
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

function Invoke-Rpc([string]$endpoint, $payload, [string]$rpcId = 'verify35') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  $uri = "http://127.0.0.1:$($script:RpcPort)/script-orchestrator/$endpoint"
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      return Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json' -Body $body -WebSession $script:RpcSession -TimeoutSec 120
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

function New-Input([string]$id, [string]$scriptSource) {
  return @{
    id = $id
    title = "验证 $id"
    trigger = @{ kind = 'every'; everySeconds = 3600 }
    script = @{ command = $Node; args = @('-e', $scriptSource); cwd = $RepoRoot }
    judge = @{ rules = @(); fallback = @() }
    actions = @{}
  }
}

function Wait-RunSettled([string]$id, [string]$runId, [int]$timeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $view = Invoke-Rpc 'view' @{ id = $id; runs = 50 } 'poll'
    $run = @($view.result.value.runs) | Where-Object { $_.runId -eq $runId } | Select-Object -First 1
    if ($run -and @('succeeded', 'partial', 'failed', 'skipped', 'canceled', 'interrupted') -contains $run.status) { return $run }
  }
  throw "run $runId 未在 $timeoutSeconds 秒内结算"
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) 'node.exe 存在'
  Check (Test-Path $Dsh) 'dsh.cmd 存在'
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\storage.js')) 'pkg/lib/storage.js 存在'

  Step '阶段 1 · 隔离 profile 建立（启动 1 配置：maxRunsPerOrchestration=2）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\storage.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 2 · 启动 1：A 两次结算；B 长 run 在途后杀宿主'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  Connect-Rpc $host1.Url $host1.Port

  $rA = Invoke-Rpc 'create' (New-Input 'v35-a' 'console.log("A35")') 'cA'
  Check ($rA.result.ok -eq $true) 'A（短脚本）创建受理'
  $rB = Invoke-Rpc 'create' (New-Input 'v35-b' 'setTimeout(function(){console.log("B35-LATE")},30000)') 'cB'
  Check ($rB.result.ok -eq $true) 'B（30s 长脚本）创建受理'

  $aRun1 = Invoke-Rpc 'run' @{ id = 'v35-a' } 'rA1'
  $a1 = Wait-RunSettled 'v35-a' $aRun1.result.value.runId
  Check ($a1.status -eq 'succeeded') 'A：run1 结算 succeeded'
  $aRun2 = Invoke-Rpc 'run' @{ id = 'v35-a' } 'rA2'
  $a2 = Wait-RunSettled 'v35-a' $aRun2.result.value.runId
  Check ($a2.status -eq 'succeeded') 'A：run2 结算 succeeded'
  $aView1 = Invoke-Rpc 'view' @{ id = 'v35-a'; runs = 50 } 'vA1'
  Check (@($aView1.result.value.runs).Count -eq 2) 'A：停机前有 2 条 run（上限 2 内）'

  $bRun = Invoke-Rpc 'run' @{ id = 'v35-b' } 'rB1'
  Check ($bRun.result.ok -eq $true -and $bRun.result.value.runId) "B：长 run 受理（runId=$($bRun.result.value.runId)）"
  Start-Sleep -Seconds 2
  $bView = Invoke-Rpc 'view' @{ id = 'v35-b'; runs = 50 } 'vB1'
  $bRunView = @($bView.result.value.runs) | Select-Object -First 1
  Check ($bRunView -and @('queued', 'running') -contains $bRunView.status) "B：杀宿主前 run 在途（status=$($bRunView.status)）"
  $bRunId = [string]$bRunView.runId

  Stop-HeadlessHost $host1.Port
  Write-Host '  宿主已被杀（模拟崩溃：B 的 run 未结算即中断）'

  Step '阶段 3 · 改配置为 1 后启动 2：启动维护（interrupted + 保留对账）与恢复后服务'
  Write-ProfileConfig 1
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  Connect-Rpc $host2.Url $host2.Port

  # ① 启动维护：B 的在途 run → interrupted
  $bAfter = Invoke-Rpc 'view' @{ id = 'v35-b'; runs = 50 } 'vB2'
  $bRecovered = @($bAfter.result.value.runs) | Where-Object { $_.runId -eq $bRunId } | Select-Object -First 1
  Check ($bRecovered -and $bRecovered.status -eq 'interrupted') '重启恢复：B 的在途 run 被标 interrupted'
  Check ($null -ne $bRecovered.settledAt) '重启恢复：interrupted run 带恢复结算时刻（settledAt 非空）'
  Check ($null -eq $bRecovered.script.exitCode -or $bRecovered.script.exitCode -eq 0) '重启恢复：不自动重放/伪造退出码（如实保留未完成事实）'

  # ② 启动维护：A 的 2 条 settled run → 按新上限 1 对账补裁（保留最新 run2）
  $aAfter = Invoke-Rpc 'view' @{ id = 'v35-a'; runs = 50 } 'vA2'
  $aRuns = @($aAfter.result.value.runs)
  Check ($aRuns.Count -eq 1) "启动保留对账：A 的 run 补裁到 1 条（实际 $($aRuns.Count)）"
  Check ($aRuns[0].runId -eq $a2.runId) '启动保留对账：按 settledAt 定序保留最新一条（run2）'
  Check ($aRuns[0].status -eq 'succeeded') '启动保留对账：保留的是已结算 run'

  # ③ 恢复后权威回读 + 服务可用（队列/调度器已重建）
  $list = Invoke-Rpc 'list' @{} 'list1'
  Check ($list.result.value.total -eq 2) '重启恢复：list 权威回读（A/B 都在）'
  $aRun3 = Invoke-Rpc 'run' @{ id = 'v35-a' } 'rA3'
  $a3 = Wait-RunSettled 'v35-a' $aRun3.result.value.runId
  Check ($a3.status -eq 'succeeded') '重启恢复：A 可再次手动执行并结算（执行引擎重建）'
  $aView3 = Invoke-Rpc 'view' @{ id = 'v35-a'; runs = 50 } 'vA3'
  Check (@($aView3.result.value.runs).Count -eq 1) '重启恢复：保留上限持续生效（仍为 1 条）'
  Check ((@($aView3.result.value.runs)[0]).runId -eq $a3.runId) '重启恢复：新结算 run 取代旧 run（settledAt 定序）'

  $bootErr2 = Get-Content $host2.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr2 -or $bootErr2 -notmatch 'script-orchestrator') '启动 2 stderr 无 script-orchestrator 错误'
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
