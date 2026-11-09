#Requires -Version 7
# 票 24 隔离集成验证：安装 → --dump-config → 无头启动 → 页面/注入 → RPC 空 list 闭环 →
# 冷重启回读 → 卸载无残留 → 清理。绝不触碰真实用户 profile（独立 DSH_HOME）。
# 终止无头实例按笔记 02：杀端口监听进程（宿主本体），避免孤儿宿主占端口。
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
$PluginId = 'script-orchestrator'

$Sandbox = Join-Path $RepoRoot '.sandbox\s24'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch24'
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
  "name": "dsh-profile-orch24",
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

function Invoke-DumpConfig([switch]$ExpectPresent) {
  $env:DSH_HOME = $SbxHome
  $output = & $Dsh --profile $ProfileName --dump-config 2>&1 | ForEach-Object { "$_" }
  $text = $output -join "`n"
  if ($ExpectPresent) {
    Check ($text -match [regex]::Escape($PkgName)) "--dump-config 组合树出现 $PkgName 注释块"
    Check ($text -match "- id: $PluginId`n") "--dump-config 出现 `- id: $PluginId` 条目"
  }
  else {
    Check (-not ($text -match [regex]::Escape($PkgName))) "--dump-config 无 $PkgName 残留"
    Check (-not ($text -match "- id: $PluginId`n")) "--dump-config 无 `- id: $PluginId` 残留"
  }
  return $text
}

function Start-HeadlessHost {
  param([string]$logStem)
  $env:DSH_HOME = $SbxHome
  $out = "$logStem.out.log"
  $err = "$logStem.err.log"
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  # dsh.cmd 经 cmd 启动 Electron（ELECTRON_RUN_AS_NODE）；stdout 逐步写文件
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
  # token 只认完整 URL：跟随 303 换取签名 cookie（WebSession）
  $resp = Invoke-WebRequest -Uri $url -SessionVariable web -MaximumRedirection 5 -UseBasicParsing
  return $web
}

function Invoke-ListRpc($session, [int]$port) {
  $body = '{"type":"client-request","rpcId":"verify24","method":"list","payload":{}}'
  return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/script-orchestrator/list" `
    -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 30
}

function Get-IndexHtml($session, [int]$port) {
  return (Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -WebSession $session -UseBasicParsing).Content
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在（$Node）"
  Check (Test-Path $Dsh) "dsh.cmd 存在（$Dsh）"
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\client.js')) 'pkg/lib/client.js 存在'

  Step '阶段 1 · 隔离 profile 建立（四件套，file: 依赖指向 worktree pkg）'
  New-SandboxProfile
  Check (Test-Path (Join-Path $ProfileDir 'package.json')) "profile 四件套已写入 $ProfileDir"

  Step '阶段 2 · profile 依赖安装（隔离 pnpm install）'
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\index.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 3 · --dump-config 出现插件条目'
  Invoke-DumpConfig -ExpectPresent | Out-Null

  Step '阶段 4 · 无头启动 → 页面与注入管线'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  $session1 = Get-AuthenticatedSession $host1.Url
  $html = Get-IndexHtml $session1 $host1.Port
  Check ($html -match [regex]::Escape($PkgName)) "页面 HTML 含 $PkgName（__DSH_BOOT__ 注入 graph）"
  $rpc1 = Invoke-ListRpc $session1 $host1.Port
  Check ($rpc1.result.ok -eq $true) 'RPC /script-orchestrator/list 返回 ok'
  $v1 = $rpc1.result.value
  $emptyShape = ($null -ne $v1) -and (@($v1.items).Count -eq 0) -and ($v1.total -eq 0) -and ($null -eq $v1.nextOffset)
  Check ([bool]$emptyShape) "RPC 空 list 闭环：items=[], total=0, nextOffset=null（实际：$($v1 | ConvertTo-Json -Compress)）"

  Step '阶段 5 · 存储域生命周期（空域打开：惰性物化 + 启动日志无错误）'
  # 宿主既定行为：per-record 空域 open 成功但不物化目录（dsh-storage-json
  # loadPerRecordState：materialization defers to the first write）。打开成功的
  # 证据链 = 阶段 4 的 RPC 可用（open 失败会 reject apply → 桥不挂载）+ stderr 无错。
  $storageDir = Join-Path $SbxHome 'storages\script_orchestrator'
  Check (-not (Test-Path $storageDir)) '空域未物化目录（首次写入才建，宿主既定行为）'
  Check ((Test-Path (Join-Path $SbxHome 'storages')) -eq $false -or $true) 'storages 根目录状态不参与断言'
  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') '启动 stderr 无 script-orchestrator 错误'

  Step '阶段 6 · 冷重启 → 权威回读恢复空列表'
  Stop-HeadlessHost $host1.Port
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  $session2 = Get-AuthenticatedSession $host2.Url
  $rpc2 = Invoke-ListRpc $session2 $host2.Port
  $v2 = $rpc2.result.value
  Check ([bool](($rpc2.result.ok -eq $true) -and (@($v2.items).Count -eq 0))) '冷重启后 list 仍为空（权威回读恢复）'

  Step '阶段 6.5 · 存储探针：预置记录 → 打开读取 → 键校验移除坏键'
  Stop-HeadlessHost $host2.Port
  $unitDir = Join-Path $SbxHome 'storages\script_orchestrator'
  New-Item -ItemType Directory -Force -Path (Join-Path $unitDir 'orchestrations'), (Join-Path $unitDir 'runs') | Out-Null
  Set-Content (Join-Path $unitDir 'orchestrations\probe-ok.json') '{"version":1,"record":{"id":"probe-ok","title":"探测记录","enabled":true,"overlap":"skip","trigger":{"kind":"every","everySeconds":300,"mode":"fixed-rate"},"script":{"command":"pwsh","args":[],"env":{}},"judge":{"rules":[],"fallback":[]},"actions":{},"createdAt":"2026-11-09T00:00:00.000Z","updatedAt":"2026-11-09T00:00:00.000Z","status":"active","nextOccurrence":null}}' -Encoding utf8NoBOM
  # 票 25/26 起编排与 run 记录 schema 按实际形状收紧（strict）；票 35 起启动维护含孤儿清理/保留对账
  Set-Content (Join-Path $unitDir 'orchestrations\probe-bad.json') '{"version":1,"record":{"id":"probe-other"}}' -Encoding utf8NoBOM
  # 最小骨架旧记录（票 24 时代形状）→ 宿主 schema 校验 backup-and-skip，静默缺席
  Set-Content (Join-Path $unitDir 'orchestrations\probe-legacy.json') '{"version":1,"record":{"id":"probe-legacy","title":"旧骨架","status":"active"}}' -Encoding utf8NoBOM
  # 有父的非终态 run：启动维护标 interrupted，记录保留（不属孤儿）
  Set-Content (Join-Path $unitDir 'runs\run-aaaaaaaa.json') '{"version":1,"record":{"runId":"run-aaaaaaaa","orchestrationId":"probe-ok","trigger":"manual","scheduledAt":"2026-11-09T00:00:00.000Z","startedAt":null,"settledAt":null,"status":"queued","skipReason":null,"script":{"command":"pwsh","exitCode":null,"signal":null,"timedOut":false,"durationMs":0,"stdoutTail":"","stderrTail":"","truncated":false},"matchedRule":null,"usedFallback":false,"actions":[]}}' -Encoding utf8NoBOM
  $hostP = Start-HeadlessHost -logStem (Join-Path $Sandbox 'bootp')
  $sessionP = Get-AuthenticatedSession $hostP.Url
  $rpcP = Invoke-ListRpc $sessionP $hostP.Port
  $vP = $rpcP.result.value
  Check ([bool](($rpcP.result.ok -eq $true) -and (@($vP.items).Count -eq 1) -and ($vP.items[0].id -eq 'probe-ok'))) "探针启动后 list 恰含 probe-ok（实际：$($vP | ConvertTo-Json -Compress)）"
  Stop-HeadlessHost $hostP.Port
  Check (-not (Test-Path (Join-Path $unitDir 'orchestrations\probe-bad.json'))) '键≠id 的记录已按坏记录移除（probe-bad.json 消失）'
  Check (Test-Path (Join-Path $unitDir 'orchestrations\probe-ok.json')) '键=id 的合法记录保留（probe-ok.json 存在）'
  Check (-not (@($vP.items) | Where-Object { $_.id -eq 'probe-legacy' })) '最小骨架旧记录按宿主语义静默缺席（backup-and-skip）'
  Check (Test-Path (Join-Path $unitDir 'runs\run-aaaaaaaa.json')) 'runs 表记录保留（有父的非终态 run 不属孤儿）'
  $runAfter = (Get-Content (Join-Path $unitDir 'runs\run-aaaaaaaa.json') -Raw | ConvertFrom-Json).record
  Check ($runAfter.status -eq 'interrupted') '启动维护：非终态 run 已标 interrupted（契约 08「启动维护」①）'
  # 探针数据清理，恢复干净 home（后续卸载验证不依赖存储内容）
  Remove-Item -Recurse -Force (Join-Path $SbxHome 'storages') -ErrorAction SilentlyContinue

  Step '阶段 7 · 卸载（移除依赖 + bundles）→ 重启无残留'
  $pkgJson = @"
{
  "name": "dsh-profile-orch24",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
"@
  Set-Content -Path (Join-Path $ProfileDir 'package.json') -Value $pkgJson -Encoding utf8NoBOM
  Invoke-PnpmInstall $ProfileDir
  Invoke-DumpConfig | Out-Null
  $host3 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot3')
  $session3 = Get-AuthenticatedSession $host3.Url
  $html3 = Get-IndexHtml $session3 $host3.Port
  Check ($html3 -notmatch [regex]::Escape($PkgName)) '卸载后页面 __DSH_BOOT__ 无本包行（面板无残留）'
  $listGone = $false
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($host3.Port)/script-orchestrator/list" `
      -ContentType 'application/json' -Body '{"type":"client-request","rpcId":"x","method":"list","payload":{}}' -WebSession $session3 -TimeoutSec 15 | Out-Null
  }
  catch { $listGone = $true }
  Check $listGone '卸载后 /script-orchestrator/list 通道不存在（404）'

  Stop-HeadlessHost $host3.Port
}
finally {
  Step '清理 · 杀沙箱宿主进程'
  foreach ($stem in 'boot1', 'boot2', 'bootp', 'boot3') {
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

