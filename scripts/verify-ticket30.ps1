#Requires -Version 7
# 票 30 隔离集成验证：安装（含事件探针插件）→ 无头启动 → 创建判定/动作编排
# （jsonPath 命中 + event 动作载荷渲染 + plugin 未注册 unknown_action → partial；
#   exitCode 未命中走 fallback → event 动作 succeeded；session prompt 渲空 → template_invalid）
# → 自动触发一轮 → 断言 run 记录（view 回读）与探针事件日志（全名/载荷/时序）。
# 绝不触碰真实用户 profile（独立 DSH_HOME）；终止无头实例按端口监听进程杀（笔记 02）。
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
$ProbeName = '@local/dsh-orch-probe'

$Sandbox = Join-Path $RepoRoot '.sandbox\s30'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch30'
$ProfileDir = Join-Path $SbxHome "profiles\$ProfileName"
$PkgDir = (Join-Path $RepoRoot 'pkg') -replace '\\', '/'
$ProbeDir = (Join-Path $Sandbox 'probe') -replace '\\', '/'
$ProbeLog = (Join-Path $Sandbox 'probe-events.jsonl') -replace '\\', '/'

$script:Failures = @()

function Step([string]$name) { Write-Host "`n=== $name ===" -ForegroundColor Cyan }
function Check([bool]$condition, [string]$message) {
  if ($condition) { Write-Host "  PASS  $message" -ForegroundColor Green }
  else {
    Write-Host "  FAIL  $message" -ForegroundColor Red
    $script:Failures += $message
  }
}

function New-ProbePackage {
  # 事件探针：订阅 script-orchestrator/* 与本验证要发出的自定义事件，逐条 JSONL 落盘。
  # （宿主 emit 无 per-listener 隔离；探针自身同步代码不抛错——契约 06 listener 纪律。）
  New-Item -ItemType Directory -Force -Path (Join-Path $ProbeDir 'lib') | Out-Null
  $pkgJson = @"
{
  "name": "$ProbeName",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "engines": { "dsh": "0.2.2-rc.1" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
"@
  Set-Content -Path (Join-Path $ProbeDir 'package.json') -Value $pkgJson -Encoding utf8NoBOM
  Set-Content -Path (Join-Path $ProbeDir 'cordis.patch.yml') -Value "- insert:`n    - id: orch-probe`n      name: '$ProbeName'" -Encoding utf8NoBOM
  $probeJs = @"
import { appendFileSync } from 'node:fs'
const LOG = '$ProbeLog'
const NAMES = [
  'script-orchestrator/run-started',
  'script-orchestrator/run-settled',
  'script-orchestrator/action-settled',
  'script-orchestrator/deploy-degraded',
  'script-orchestrator/deploy-ok',
  'script-orchestrator/deploy-bad',
]
export const inject = []
export function* apply(ctx) {
  for (const name of NAMES) {
    ctx.effect(() => ctx.on(name, (payload) => appendFileSync(LOG, JSON.stringify({ seq: globalThis.__probeSeq = (globalThis.__probeSeq ?? 0) + 1, name, payload }) + '\n')))
  }
  yield () => {}
}
"@
  Set-Content -Path (Join-Path $ProbeDir 'lib\index.js') -Value $probeJs -Encoding utf8NoBOM
}

function New-SandboxProfile {
  Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
  New-ProbePackage
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $pkgJson = @"
{
  "name": "dsh-profile-orch30",
  "private": true,
  "dependencies": {
    "$PkgName": "file:$PkgDir",
    "$ProbeName": "file:$ProbeDir"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "$PkgName",
        "$ProbeName"
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
  # --port 0：OS 分配空闲端口（避免与并行 worktree 的无头宿主抢默认 3080；
  # 实际端口从打印的 token URL 解析）
  $proc = Start-Process -FilePath $env:ComSpec -ArgumentList "/c", "`"$Dsh`" --profile $ProfileName --no-open --port 0" `
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

function Invoke-Rpc($session, [int]$port, [string]$endpoint, $payload, [string]$rpcId = 'verify30') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/script-orchestrator/$endpoint" `
    -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 30
}

function Get-LatestRun($session, [int]$port, [string]$id) {
  $v = Invoke-Rpc $session $port 'view' @{ id = $id } "run-$id"
  return @{ orch = $v.result.value; run = @($v.result.value.runs)[0] }
}

function Get-ProbeLines([string]$orchestrationId) {
  if (-not (Test-Path $ProbeLog)) { return @() }
  Get-Content $ProbeLog | ForEach-Object {
    $entry = $_ | ConvertFrom-Json
    if ($entry.payload -and $entry.payload.orchestrationId -eq $orchestrationId) { $entry }
    elseif ($entry.name -like 'script-orchestrator/deploy-*' -and $entry.payload.orchestration.id -eq $orchestrationId) { $entry }
  }
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在（$Node）"
  Check (Test-Path $Dsh) "dsh.cmd 存在（$Dsh）"
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\actions.js')) 'pkg/lib/actions.js 存在'

  Step '阶段 1 · 隔离 profile 建立（worktree pkg + 事件探针插件）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\actions.js")) 'file: 依赖落到 profile node_modules'
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$ProbeName\lib\index.js")) '探针插件落到 profile node_modules'

  Step '阶段 2 · 无头启动 + 创建三个判定/动作编排'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  $session1 = Get-AuthenticatedSession $host1.Url
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  # A · jsonPath 命中 → event 载荷渲染 + plugin 未注册 unknown_action → partial
  $scriptA = @{
    command = $Node
    args = @('-e', 'console.log(JSON.stringify({status:"degraded",count:3})); process.exit(0)')
    cwd = $RepoRoot
  }
  $inputA = @{
    id = 'verify-dispatch'
    title = '验证派发'
    trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
    script = $scriptA
    judge = @{
      rules = @(
        @{ when = @{ stdout = @{ jsonPath = '$.status'; equals = 'degraded' } }; actions = @('emit-degraded', 'page-missing') },
        @{ when = @{ exitCode = 0 }; actions = @('emit-ok') }
      )
      fallback = @('emit-bad')
    }
    actions = @{
      'emit-degraded' = @{ kind = 'event'; name = 'deploy-degraded'; payload = @{
        summary = '{{orchestrationTitle}} → {{json:$.status}} x{{json:$.count}}（{{durationMs}}ms）'
        unknown = '{{nope}}'
      } }
      'page-missing' = @{ kind = 'plugin'; action = 'ops.oncall' }
      'emit-ok' = @{ kind = 'event'; name = 'deploy-ok' }
      'emit-bad' = @{ kind = 'event'; name = 'deploy-bad' }
    }
  }
  $rA = Invoke-Rpc $session1 $host1.Port 'create' $inputA 'cA'

  # B · exitCode 7 不中任何规则 → fallback → event 动作 succeeded（usedFallback=true）
  $inputB = @{
    id = 'verify-fallback'
    title = '验证回退'
    trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
    script = @{ command = $Node; args = @('-e', 'process.exit(7)'); cwd = $RepoRoot }
    judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('emit-ok') } ); fallback = @('emit-bad') }
    actions = @{
      'emit-ok' = @{ kind = 'event'; name = 'deploy-ok' }
      'emit-bad' = @{ kind = 'event'; name = 'deploy-bad' }
    }
  }
  $rB = Invoke-Rpc $session1 $host1.Port 'create' $inputB 'cB'

  # C · session prompt 渲染后为空（未知变量）→ template_invalid；单动作全败 → failed
  $inputC = @{
    id = 'verify-template'
    title = '验证模板'
    trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
    script = @{ command = $Node; args = @('-e', 'console.log("plain")'); cwd = $RepoRoot }
    judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('open-triage') } ); fallback = @() }
    actions = @{ 'open-triage' = @{ kind = 'session'; prompt = '  {{unknown-var}}  ' } }
  }
  $rC = Invoke-Rpc $session1 $host1.Port 'create' $inputC 'cC'
  foreach ($pair in @(@('A', $rA), @('B', $rB), @('C', $rC))) {
    Check ($pair[1].result.ok -eq $true) "create $($pair[0]) 受理（next=$($pair[1].result.value.nextOccurrence)）"
  }

  # 非法配置不落库：保留名事件短名 + 引用未定义动作键
  $badReserved = Invoke-Rpc $session1 $host1.Port 'create' @{
    id = 'verify-bad-reserved'; title = '非法保留名'
    trigger = @{ kind = 'every'; everySeconds = 60 }
    script = @{ command = $Node; args = @('-e', '0'); cwd = $RepoRoot }
    judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('x') } ); fallback = @() }
    actions = @{ x = @{ kind = 'event'; name = 'run-settled' } }
  } 'cD1'
  Check ($badReserved.result.ok -eq $false -and $badReserved.result.error.code -eq 'script_input_invalid' -and $badReserved.result.error.details.reason -eq 'reserved') `
    '非法配置（保留事件短名）→ script_input_invalid(reserved) 不落库'
  $badRef = Invoke-Rpc $session1 $host1.Port 'create' @{
    id = 'verify-bad-ref'; title = '非法引用'
    trigger = @{ kind = 'every'; everySeconds = 60 }
    script = @{ command = $Node; args = @('-e', '0'); cwd = $RepoRoot }
    judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('ghost') } ); fallback = @() }
    actions = @{ x = @{ kind = 'event'; name = 'ok-thing' } }
  } 'cD2'
  Check ($badRef.result.ok -eq $false -and $badRef.result.error.details.reason -eq 'missing' -and $badRef.result.error.details.field -eq 'judge.rules[0].actions[0]') `
    '非法配置（引用未定义动作键）→ script_input_invalid(missing, judge.rules[0].actions[0]) 不落库'
  $listBad = Invoke-Rpc $session1 $host1.Port 'list' @{} 'cD3'
  Check (@($listBad.result.value.items).Count -eq 3) '两次非法 create 后列表仍只有 3 条（未落库）'

  Step '阶段 3 · 等 T+70s：三个编排各自动触发一轮并结算'
  $wait = 70 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }

  $a = Get-LatestRun $session1 $host1.Port 'verify-dispatch'
  Check ($a.run -and $a.run.status -eq 'partial') "A：run partial（一成一败；status=$($a.run.status)）"
  Check ($a.run.matchedRule -eq 0 -and $a.run.usedFallback -eq $false) 'A：命中规则 0（jsonPath $.status=degraded）、未走 fallback'
  $actionA0 = @($a.run.actions)[0]
  $actionA1 = @($a.run.actions)[1]
  Check ($actionA0.status -eq 'succeeded' -and $actionA0.kind -eq 'event') "A：emit-degraded succeeded（warnings=$($actionA0.warnings -join ' | ')）"
  Check (($actionA0.warnings -join '') -match 'unknown variable: \{\{nope\}\}') 'A：emit-degraded warnings 含未知变量确定性文案'
  Check ($actionA1.status -eq 'failed' -and $actionA1.error.code -eq 'unknown_action') "A：page-missing failed unknown_action（ops.oncall 未注册不静默跳过）"

  $b = Get-LatestRun $session1 $host1.Port 'verify-fallback'
  Check ($b.run -and $b.run.status -eq 'succeeded' -and $b.run.matchedRule -eq $null -and $b.run.usedFallback -eq $true) `
    "B：fallback 命中（usedFallback=true）→ emit-bad succeeded"
  Check (@($b.run.actions)[0].name -eq 'emit-bad' -and @($b.run.actions)[0].status -eq 'succeeded') 'B：run.actions[0] = emit-bad succeeded'

  $c = Get-LatestRun $session1 $host1.Port 'verify-template'
  Check ($c.run -and $c.run.status -eq 'failed') "C：单动作 template_invalid → failed（status=$($c.run.status)）"
  $actionC0 = @($c.run.actions)[0]
  Check ($actionC0.error.code -eq 'template_invalid') "C：动作错误码 template_invalid（prompt 渲染后为空）"
  Check (($actionC0.warnings -join '') -match 'unknown variable: \{\{unknown-var\}\}') 'C：warnings 含模板警告'

  Step '阶段 4 · 探针事件日志：全名、载荷与时序（run-started → 自定义事件 → action-settled×N → run-settled）'
  $linesA = @(Get-ProbeLines 'verify-dispatch')
  Check ($linesA.Count -eq 5) "A 探针行数 = 5（run-started + deploy-degraded + action-settled×2 + run-settled；实际 $($linesA.Count)）"
  if ($linesA.Count -ge 5) {
    Check (($linesA | ForEach-Object { $_.name }) -is [array]) 'A：探针行可解析'
    $namesA = @($linesA | Sort-Object seq | ForEach-Object { $_.name })
    Check ($namesA[0] -eq 'script-orchestrator/run-started') 'A[0] = run-started'
    Check ($namesA[1] -eq 'script-orchestrator/deploy-degraded') 'A[1] = 自定义事件 deploy-degraded（派发期间先于 action-settled）'
    Check ($namesA[2] -eq 'script-orchestrator/action-settled' -and $namesA[3] -eq 'script-orchestrator/action-settled') 'A[2..3] = action-settled ×2（写 2 之后按执行序）'
    Check ($namesA[4] -eq 'script-orchestrator/run-settled') 'A[4] = run-settled 收尾'
    $customA = ($linesA | Where-Object { $_.name -eq 'script-orchestrator/deploy-degraded' } | Select-Object -First 1).payload
    Check ($customA.name -eq 'deploy-degraded' -and $customA.orchestration.id -eq 'verify-dispatch') 'A：自定义事件载荷 name/orchestration 正确'
    Check ($customA.payload.summary -match '^验证派发 → degraded x3（\d+ms）$') "A：payload.summary 模板已渲染（$($customA.payload.summary)）"
    Check ($customA.payload.unknown -eq '') 'A：未知变量渲染为空串（不整体失败）'
    Check ($customA.run.exitCode -eq 0 -and $customA.run.status -eq 'succeeded') 'A：载荷 run.exitCode=0、run.status=succeeded（脚本阶段完成口径）'
    $settledA = ($linesA | Where-Object { $_.name -eq 'script-orchestrator/run-settled' } | Select-Object -First 1).payload
    Check ($settledA.status -eq 'partial' -and $settledA.matchedRule -eq 0) 'A：run-settled 载荷 status=partial、matchedRule=0'
    Check (@($settledA.actions).Count -eq 2 -and -not (@($settledA.actions) | Where-Object { $_.PSObject.Properties['error'] })) 'A：run-settled 载荷 actions 只含 {name,kind,status}'
    $as1 = ($linesA | Where-Object { $_.name -eq 'script-orchestrator/action-settled' } | Select-Object -Skip 1 -First 1).payload
    Check ($as1.name -eq 'page-missing' -and $as1.status -eq 'failed' -and $as1.error.code -eq 'unknown_action') 'A：action-settled(page-missing) 携带 error.code=unknown_action'
  }

  $linesB = @(Get-ProbeLines 'verify-fallback')
  $namesB = @($linesB | Sort-Object seq | ForEach-Object { $_.name })
  Check ($namesB -contains 'script-orchestrator/deploy-bad') 'B：探针收到 deploy-bad（fallback 路径的自定义事件）'
  $settledB = ($linesB | Where-Object { $_.name -eq 'script-orchestrator/run-settled' } | Select-Object -First 1).payload
  Check ($settledB.usedFallback -eq $true -and $settledB.matchedRule -eq $null) 'B：run-settled 载荷 usedFallback=true、matchedRule=null'

  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') '启动 stderr 无 script-orchestrator 错误'

  Stop-HeadlessHost $host1.Port
}
finally {
  Step '清理 · 杀沙箱宿主进程'
  $log = Join-Path $Sandbox 'boot1.out.log'
  if (Test-Path $log) {
    $raw = Get-Content $log -Raw -ErrorAction SilentlyContinue
    if ($raw) {
      $m = [regex]::Match($raw, 'https?://127\.0\.0\.1:(\d+)/')
      if ($m.Success) { Stop-HeadlessHost ([int]$m.Groups[1].Value) }
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
