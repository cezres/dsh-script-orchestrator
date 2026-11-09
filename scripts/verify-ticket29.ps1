#Requires -Version 7
# 票 29 隔离集成验证：安装 → 无头启动（--port 0 动态端口）→ 经桥驱动：
# 长脚本手动 run 在途 → delete 在途编排两阶段级联（取消 → 等结算 → 同槽先删编排后删 runs，
# run-settled(canceled) 由单测确定性覆盖，此处验证 removedRuns 与删除耗时上限＝取消而非等自然完成）→
# list 归零 / view 后 script_unknown → delete 的 CAS 不匹配拒绝 → paused 与无 run 的全状态删除 →
# stderr 检查。绝不触碰真实用户 profile（独立 DSH_HOME）；终止按端口监听进程杀（笔记 02 + 票 27/28
# Comments 自修经验：PS 参数强转、日期反序列化、杀宿主竞态、401 重连、端口释放等待）。
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

$Sandbox = Join-Path $RepoRoot '.sandbox\s29'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch29'
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
  "name": "dsh-profile-orch29",
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

function Invoke-Rpc([string]$endpoint, $payload, [string]$rpcId = 'verify29') {
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

function New-Input([string]$id, $trigger, [hashtable]$over = @{}) {
  $input = @{
    id = $id
    title = "验证 $id"
    trigger = $trigger
    script = @{ command = $Node; args = @('-e', 'console.log("T29-MARKER-OK")'); cwd = $RepoRoot }
    judge = @{ rules = @(); fallback = @() }
    actions = @{}
  }
  foreach ($k in $over.Keys) { $input[$k] = $over[$k] }
  return $input
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) 'node.exe 存在'
  Check (Test-Path $Dsh) 'dsh.cmd 存在'
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\service.js')) 'pkg/lib/service.js 存在'
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\runner.js')) 'pkg/lib/runner.js 存在'

  Step '阶段 1 · 隔离 profile 建立'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\service.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 2 · 无头启动 + 创建 L（长脚本 every 3600s）与 P（paused）'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  Connect-Rpc $host1.Url $host1.Port

  $longScript = @{ command = $Node; args = @('-e', 'setTimeout(function(){console.log("LATE29")},30000)'); cwd = $RepoRoot }
  $rL = Invoke-Rpc 'create' (New-Input 'v29-l' @{ kind = 'every'; everySeconds = 3600 } @{ script = $longScript }) 'cL'
  Check ($rL.result.ok -eq $true) 'L（every 3600s + 30s 长脚本）创建受理'
  $rP = Invoke-Rpc 'create' (New-Input 'v29-p' @{ kind = 'every'; everySeconds = 3600 } @{ enabled = $false }) 'cP'
  Check ($rP.result.ok -eq $true -and $rP.result.value.status -eq 'paused') 'P（enabled:false）创建为 paused'

  Step '阶段 3 · 在途 run → delete 两阶段级联（取消而非等自然完成）'
  $runL = Invoke-Rpc 'run' @{ id = 'v29-l' } 'rL'
  Check ($runL.result.ok -eq $true -and $runL.result.value.runId) "L：手动 run 受理即返回（runId=$($runL.result.value.runId)）"
  Start-Sleep -Seconds 2
  $lView = Invoke-Rpc 'view' @{ id = 'v29-l' } 'vL1'
  $lRun = @($lView.result.value.runs) | Select-Object -First 1
  Check ($lRun -and @('queued', 'running') -contains $lRun.status) "L：删除前 run 在途（status=$($lRun.status)）"

  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $delL = Invoke-Rpc 'edit' @{ id = 'v29-l'; action = 'delete' } 'delL'
  $t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Check ($delL.result.ok -eq $true -and $delL.result.value.id -eq 'v29-l') 'L：delete 受理成功'
  Check ([int]$delL.result.value.removedRuns -ge 1) "L：removedRuns 准确含在途 run（removedRuns=$($delL.result.value.removedRuns)）"
  Check (($t1 - $t0) -lt 20000) "L：delete 取消在途 run 而非等 30s 自然完成（耗时 $($t1 - $t0)ms）"

  $listAfter = Invoke-Rpc 'list' @{} 'list1'
  $remainingIds = @($listAfter.result.value.items | ForEach-Object { $_.id })
  Check ($listAfter.result.value.total -eq 1 -and $remainingIds.Count -eq 1 -and $remainingIds[0] -eq 'v29-p') "L 级联删除后列表仅剩 P（total=$($listAfter.result.value.total), ids=$($remainingIds -join ',')）"
  $viewGone = Invoke-Rpc 'view' @{ id = 'v29-l' } 'vL2'
  Check ($viewGone.result.ok -eq $false -and $viewGone.result.error.code -eq 'script_unknown') 'view 已删编排 → script_unknown'

  Step '阶段 4 · delete 的 CAS 不匹配拒绝 + 全状态删除'
  $rC = Invoke-Rpc 'create' (New-Input 'v29-c' @{ kind = 'every'; everySeconds = 3600 }) 'cC'
  Check ($rC.result.ok -eq $true) 'C 创建受理'
  $delStale = Invoke-Rpc 'edit' @{ id = 'v29-c'; action = 'delete'; expectedUpdatedAt = '2020-01-01T00:00:00.000Z' } 'delC0'
  Check ($delStale.result.ok -eq $false -and $delStale.result.error.code -eq 'script_conflict') 'C：CAS 不匹配 → script_conflict（删除拒绝）'
  $delC = Invoke-Rpc 'edit' @{ id = 'v29-c'; action = 'delete' } 'delC1'
  Check ($delC.result.ok -eq $true -and [int]$delC.result.value.removedRuns -eq 0) 'C：active 无 run 删除成功（removedRuns=0）'
  $delP = Invoke-Rpc 'edit' @{ id = 'v29-p'; action = 'delete' } 'delP'
  Check ($delP.result.ok -eq $true -and [int]$delP.result.value.removedRuns -eq 0) 'P：paused 状态删除成功（全状态可删）'
  $viewP = Invoke-Rpc 'view' @{ id = 'v29-p' } 'vP'
  Check ($viewP.result.ok -eq $false -and $viewP.result.error.code -eq 'script_unknown') 'P 删除后 view → script_unknown'

  $listFinal = Invoke-Rpc 'list' @{} 'list2'
  Check ($listFinal.result.value.total -eq 0 -and @($listFinal.result.value.items).Count -eq 0) '全部删除后 list 回读归零（无残留）'

  Step '阶段 5 · stderr 检查'
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
