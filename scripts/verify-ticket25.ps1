#Requires -Version 7
# 票 25 隔离集成验证：安装 → 无头启动 → 桥 create（every 合法/非法）→ list/view 契约形状 →
# 冷重启保持编排与下次时刻 → 磁盘记录检查 → 清理。绝不触碰真实用户 profile（独立 DSH_HOME）。
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
$PkgName = '@echo/dsh-script-orchestrator'
$PluginId = 'script-orchestrator'

$Sandbox = Join-Path $RepoRoot '.sandbox\s25'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch25'
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
  "name": "dsh-profile-orch25",
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

function Invoke-Rpc($session, [int]$port, [string]$endpoint, $payload, [string]$rpcId = 'verify25') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/script-orchestrator/$endpoint" `
    -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 30
}

# Invoke-RestMethod 会把 ISO 时间串反序列化为本地 DateTime（丢 Z 偏移）；统一换算 UTC 毫秒
function To-UtcMs($value) {
  if ($value -is [datetime]) {
    return ([DateTimeOffset]::new($value.ToUniversalTime())).ToUnixTimeMilliseconds()
  }
  return [DateTimeOffset]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds()
}

# 合法的 every 编排输入（契约 01 完整示例的 every 版）
function New-EveryInput([bool]$enabled = $true, [int]$everySeconds = 300) {
  return @{
    id = 'verify-every'
    title = '验证编排 every'
    enabled = $enabled
    trigger = @{ kind = 'every'; everySeconds = $everySeconds; mode = 'fixed-delay' }
    script = @{ command = 'pwsh'; args = @('-NoProfile', '-Command', 'Write-Output ok'); cwd = 'D:\projects'; timeoutSeconds = 60 }
    judge = @{ rules = @(@{ when = @{ exitCode = 0 }; actions = @('emit-ok') }); fallback = @() }
    actions = @{ 'emit-ok' = @{ kind = 'event'; name = 'verify-ok' } }
  }
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在（$Node）"
  Check (Test-Path $Dsh) "dsh.cmd 存在（$Dsh）"
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\client.js')) 'pkg/lib/client.js 存在'

  Step '阶段 1 · 隔离 profile 建立（file: 依赖指向 worktree pkg）'
  New-SandboxProfile
  Check (Test-Path (Join-Path $ProfileDir 'package.json')) "profile 四件套已写入 $ProfileDir"

  Step '阶段 2 · profile 依赖安装'
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\index.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 3 · 无头启动 → 桥 create 合法输入 → 契约形状断言'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  $session1 = Get-AuthenticatedSession $host1.Url
  $before = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $created = Invoke-Rpc $session1 $host1.Port 'create' (New-EveryInput)
  $after = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Check ($created.result.ok -eq $true) 'RPC create 返回 ok'
  $v = $created.result.value
  $shapeOk = ($null -ne $v) -and ($v.id -eq 'verify-every') -and ($v.status -eq 'active') -and ($v.enabled -eq $true) `
    -and ($v.overlap -eq 'skip') -and ($v.trigger.kind -eq 'every') -and ($v.trigger.everySeconds -eq 300) `
    -and ($v.trigger.mode -eq 'fixed-delay') -and ($null -ne $v.createdAt) -and ($v.updatedAt -eq $v.createdAt) `
    -and ($null -ne $v.actions.'emit-ok') -and ($null -ne $v.nextOccurrence)
  Check ([bool]$shapeOk) "create 返回完整 OrchestrationView（实际：$($v | ConvertTo-Json -Compress -Depth 10)）"
  # 首次计划 = createdAt + everySeconds（严格夹在创建调用前后 300 秒窗口内）
  $nextMs = To-UtcMs $v.nextOccurrence
  $createdMs = To-UtcMs $v.createdAt
  Check (($nextMs - $createdMs) -eq 300000) "nextOccurrence = createdAt + 300s（$($v.createdAt.ToString('o')) → $($v.nextOccurrence.ToString('o'))）"
  Check (($nextMs - $before) -ge 299000 -and ($nextMs - $after) -le 301000) "下次时刻落在创建调用时间窗内（不提前、不立即执行；next=$nextMs before=$before after=$after）"

  Step '阶段 4 · list / view 契约形状 + availableActions 空表'
  $list = Invoke-Rpc $session1 $host1.Port 'list' @{}
  $lv = $list.result.value
  Check (($list.result.ok -eq $true) -and ($lv.total -eq 1) -and ($null -eq $lv.nextOffset) -and ($lv.items[0].id -eq 'verify-every')) "list 恰含 verify-every（实际：$($lv | ConvertTo-Json -Compress -Depth 5)）"
  $view = Invoke-Rpc $session1 $host1.Port 'view' @{ id = 'verify-every' }
  $dv = $view.result.value
  $viewOk = ($view.result.ok -eq $true) -and ($dv.id -eq 'verify-every') -and (@($dv.runs).Count -eq 0) -and (@($dv.availableActions).Count -eq 0)
  Check ([bool]$viewOk) "view 返回记录 + runs: [] + availableActions: []（实际：runs=$(@($dv.runs).Count), actions=$(@($dv.availableActions).Count)）"

  Step '阶段 5 · 非法输入 → script_input_invalid，失败不产生任何记录'
  $bad1 = Invoke-Rpc $session1 $host1.Port 'create' (New-EveryInput $true 30) 'bad1'
  $b1 = $bad1.result.error
  Check (($bad1.result.ok -eq $false) -and ($b1.code -eq 'script_input_invalid') -and ($b1.details.field -eq 'trigger.everySeconds') -and ($b1.details.reason -eq 'too-frequent')) `
    "everySeconds=30 → script_input_invalid（too-frequent）（实际：$($b1 | ConvertTo-Json -Compress)）"
  $badPayload = New-EveryInput
  $badPayload.bogus = 1
  $bad2 = Invoke-Rpc $session1 $host1.Port 'create' $badPayload 'bad2'
  $b2 = $bad2.result.error
  Check (($bad2.result.ok -eq $false) -and ($b2.code -eq 'script_input_invalid') -and ($b2.details.field -eq 'bogus') -and ($b2.details.reason -eq 'unexpected')) `
    "多余字段 → script_input_invalid（unexpected）"
  $bad3 = Invoke-Rpc $session1 $host1.Port 'view' @{ id = 'nope' } 'bad3'
  Check (($bad3.result.ok -eq $false) -and ($bad3.result.error.code -eq 'script_unknown')) 'view 未知 id → script_unknown 透传'
  $listAfter = Invoke-Rpc $session1 $host1.Port 'list' @{}
  Check ($listAfter.result.value.total -eq 1) '非法 create 后列表仍只有 1 条（失败不产生任何记录）'
  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') '启动 stderr 无 script-orchestrator 错误'

  Step '阶段 6 · 冷重启 → 编排与下次时刻保持'
  $nextBeforeMs = To-UtcMs $v.nextOccurrence
  Stop-HeadlessHost $host1.Port
  # 磁盘记录检查：per-record 布局落盘且形状为完整记录
  $recordFile = Join-Path $SbxHome 'storages\script_orchestrator\orchestrations\verify-every.json'
  Check (Test-Path $recordFile) "磁盘存在编排记录文件（$recordFile）"
  if (Test-Path $recordFile) {
    $disk = Get-Content $recordFile -Raw | ConvertFrom-Json
    Check (($disk.record.id -eq 'verify-every') -and ($disk.record.status -eq 'active') -and ((To-UtcMs $disk.record.nextOccurrence) -eq $nextBeforeMs)) `
      '磁盘记录含 id/status/nextOccurrence（写入前显式 parse 的落盘形状）'
  }
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  $session2 = Get-AuthenticatedSession $host2.Url
  $view2 = Invoke-Rpc $session2 $host2.Port 'view' @{ id = 'verify-every' }
  $dv2 = $view2.result.value
  Check (($view2.result.ok -eq $true) -and ((To-UtcMs $dv2.nextOccurrence) -eq $nextBeforeMs) -and ($dv2.status -eq 'active')) `
    "冷重启后编排与下次时刻保持（nextOccurrence=$($dv2.nextOccurrence.ToString('o'))）"
  Check ((@($dv2.runs).Count -eq 0)) '冷重启后 runs 仍为空（创建不执行脚本，重启不补跑）'
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
