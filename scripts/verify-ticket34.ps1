#Requires -Version 7
# 票 34 隔离集成验证（Windows 实测）：
#   轮 1（maxOutputBytes 500 / maxSpillBytes 65536 / maxRunsPerOrchestration 2）：
#     A 输出 3200 字节 → truncated=true + spillPath 成立 → spill 端点读全量（同时含首末行）；
#     连跑 3 次 → 保留裁剪为 2 条（settledAt 定序）、被裁 run 的 spill 文件已 best-effort 删除；
#     手工删掉溢写文件 → spill 端点返回 script_storage_unavailable（文件已不存在排障态）。
#   轮 2（maxSpillBytes 500）：超 cap 撤回 → spillPath 缺省、truncated 仍 true、
#     内存尾部不受影响，spill 端点返回 spill-unavailable（W2b 复现）。
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

$Sandbox = Join-Path $RepoRoot '.sandbox\s34'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch34'
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

function Write-ProfileConfig([string]$maxSpillBytes) {
  $patch = @"
- id: script-orchestrator
  config:
    maxOutputBytes: 500
    maxSpillBytes: $maxSpillBytes
    maxRunsPerOrchestration: 2
"@
  Set-Content -Path (Join-Path $ProfileDir 'cordis.patch.yml') -Value $patch -Encoding utf8NoBOM
}

function New-SandboxProfile {
  Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $pkgJson = @"
{
  "name": "dsh-profile-orch34",
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
  Write-ProfileConfig 65536
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

function Invoke-Rpc([string]$endpoint, $payload, [string]$rpcId = 'verify34') {
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
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\retention.js')) 'pkg/lib/retention.js 存在'

  Step '阶段 1 · 隔离 profile 建立（轮 1 配置：maxOutputBytes 500 / maxSpillBytes 65536 / 每编排保留 2）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\retention.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 2 · 轮 1：spill 全量可读 + 保留裁剪 + 文件不存在排障态'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  Connect-Rpc $host1.Url $host1.Port

  $bigScript = 'for (let i = 0; i < 200; i++) console.log("line-" + String(i).padStart(4, "0"))'
  $rA = Invoke-Rpc 'create' (New-Input 'v34-a' $bigScript) 'cA'
  Check ($rA.result.ok -eq $true) 'A（200 行 3200 字节输出）创建受理'

  $run1 = Invoke-Rpc 'run' @{ id = 'v34-a' } 'rA1'
  $settled1 = Wait-RunSettled 'v34-a' $run1.result.value.runId
  Check ($settled1.status -eq 'succeeded' -and $settled1.script.truncated -eq $true) 'run1：succeeded 且 truncated=true（lossy）'
  Check ([string]$settled1.script.stdoutSpillPath -ne '') "run1：stdoutSpillPath 成立（溢写文件可排障）"
  $spillPath1 = [string]$settled1.script.stdoutSpillPath

  $spill1 = Invoke-Rpc 'spill' @{ runId = $settled1.runId; stream = 'stdout' } 'sp1'
  Check ($spill1.result.ok -eq $true) 'spill 端点读取 run1 stdout 成功'
  Check ($spill1.result.value.content -match 'line-0000' -and $spill1.result.value.content -match 'line-0199') 'spill 全量同时含首行与末行（内存尾部只留末段）'
  $expectedBytes = [Text.Encoding]::UTF8.GetByteCount([string]$spill1.result.value.content)
  Check ([int]$spill1.result.value.bytes -eq $expectedBytes) "spill bytes 与 UTF-8 内容一致（$($spill1.result.value.bytes) 字节）"
  Check ((Test-Path $spillPath1) -eq $true) 'run1 溢写文件在磁盘上存在'

  # 连跑两次触发每编排保留上限 2：run1 被裁、其 spill 文件 best-effort 删除
  $run2 = Invoke-Rpc 'run' @{ id = 'v34-a' } 'rA2'
  $settled2 = Wait-RunSettled 'v34-a' $run2.result.value.runId
  Check ($settled2.status -eq 'succeeded') 'run2 结算 succeeded'
  $run3 = Invoke-Rpc 'run' @{ id = 'v34-a' } 'rA3'
  $settled3 = Wait-RunSettled 'v34-a' $run3.result.value.runId
  Check ($settled3.status -eq 'succeeded') 'run3 结算 succeeded'

  $viewA = Invoke-Rpc 'view' @{ id = 'v34-a'; runs = 50 } 'vA'
  $keptIds = @($viewA.result.value.runs | ForEach-Object { $_.runId })
  Check ($keptIds.Count -eq 2) "保留裁剪：每编排上限 2 生效（实际 $($keptIds.Count) 条）"
  Check ($keptIds -notcontains $settled1.runId) '保留裁剪按 settledAt 定序：run1（最旧）被淘汰'
  Check ($keptIds -contains $settled3.runId) '最新 run3 保留'
  Check ((Test-Path $spillPath1) -eq $false) '被裁 run1 的 spill 文件已 best-effort 删除'
  $gone = Invoke-Rpc 'spill' @{ runId = $settled1.runId; stream = 'stdout' } 'sp-gone'
  Check ($gone.result.ok -eq $false -and $gone.result.error.code -eq 'script_unknown') '被裁 run 的 spill 读取 → script_unknown（记录已删）'

  # 文件已不存在排障态：手工删除 run3 的溢写文件后读取
  $spillPath3 = [string]$settled3.script.stdoutSpillPath
  Check ((Test-Path $spillPath3) -eq $true) 'run3 溢写文件存在'
  Remove-Item -Force $spillPath3
  $missing = Invoke-Rpc 'spill' @{ runId = $settled3.runId; stream = 'stdout' } 'sp-missing'
  Check ($missing.result.ok -eq $false -and $missing.result.error.code -eq 'script_storage_unavailable' -and
    "$($missing.result.error.message)" -match '已不存在') '溢写文件被删后读取 → script_storage_unavailable（文件已不存在）'

  # 最小形状校验
  $badSpill = Invoke-Rpc 'spill' @{ runId = $settled3.runId; stream = 'stdout2' } 'sp-bad'
  Check ($badSpill.result.ok -eq $false -and $badSpill.result.error.code -eq 'script_input_invalid') 'spill 非法 stream → script_input_invalid'

  $bootErr1 = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr1 -or $bootErr1 -notmatch 'script-orchestrator') '轮 1 stderr 无 script-orchestrator 错误'
  Stop-HeadlessHost $host1.Port

  Step '阶段 3 · 轮 2：超 spill cap 撤回（W2b 复现）'
  Write-ProfileConfig 500
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  Connect-Rpc $host2.Url $host2.Port
  $rB = Invoke-Rpc 'create' (New-Input 'v34-b' $bigScript) 'cB'
  Check ($rB.result.ok -eq $true) 'B 创建受理（轮 2 配置 maxSpillBytes=500）'
  $runB = Invoke-Rpc 'run' @{ id = 'v34-b' } 'rB1'
  $settledB = Wait-RunSettled 'v34-b' $runB.result.value.runId
  Check ($settledB.status -eq 'succeeded' -and $settledB.script.truncated -eq $true) 'B：truncated=true 不受 spill 是否存在影响'
  Check ($null -eq $settledB.script.stdoutSpillPath) 'B：超 cap 撤回 spillPath（字段缺省）'
  Check ("$($settledB.script.stdoutTail)" -match 'line-0199') 'B：内存尾部不受影响（末行仍在）'
  $spillB = Invoke-Rpc 'spill' @{ runId = $settledB.runId; stream = 'stdout' } 'spB'
  Check ($spillB.result.ok -eq $false -and $spillB.result.error.code -eq 'script_storage_unavailable' -and
    "$($spillB.result.error.message)" -match '无完整溢出文件') 'B：spill 端点返回 spill-unavailable（超 cap 撤回可解释）'

  $bootErr2 = Get-Content $host2.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr2 -or $bootErr2 -notmatch 'script-orchestrator') '轮 2 stderr 无 script-orchestrator 错误'
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
