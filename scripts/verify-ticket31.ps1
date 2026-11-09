#Requires -Version 7
# 票 31 隔离集成验证：安装（含注册能力探针插件）→ 无头启动 → 探针注册 6 个动作
#（含 selftest：坏名字/保留前缀/重名同步抛错）→ 创建 5 个编排 + 2 次非法 create：
#   O1 verify-register    ：probe.echo 被编排调用（payload 已渲染 + report 警告）
#   O2 verify-unregister  ：同 run 内 [drop2, call-echo2] → 摘除后实时查表 unknown_action（partial）
#   O3 verify-reregister  ：同 run 内 [recycle3, call-echo3] → 同步 disposer + 重注册 → 解析到新注册
#   O4 verify-timeout     ：timeoutSeconds=2 挂起 → failed timeout + 后续 event 动作照常（partial）
#   O5 verify-reserved    ：action='script-orchestrator.page'（格式合法的保留前缀）→ create 通过、
#                           运行时 unknown_action（静态只查格式、运行时实时查表）
# → 断言 view/listActions 快照、run 记录（结果/警告/错误码）与探针 JSONL 日志。
# 各编排用独立动作名，避免并发 run 互相干扰注册态。绝不触碰真实用户 profile（独立 DSH_HOME）；
# 终止无头实例按端口监听进程杀（笔记 02）；--port 0 由 OS 分配（避开并行 worktree 端口冲突）。
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
$ProbeName = '@local/dsh-orch-probe31'

$Sandbox = Join-Path $RepoRoot '.sandbox\s31'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch31'
$ProfileDir = Join-Path $SbxHome "profiles\$ProfileName"
$PkgDir = (Join-Path $RepoRoot 'pkg') -replace '\\', '/'
$ProbeDir = (Join-Path $Sandbox 'probe') -replace '\\', '/'
$ProbeLog = (Join-Path $Sandbox 'probe31.jsonl') -replace '\\', '/'

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
  # 注册能力探针：经 ctx.inject + ctx.effect 注册 6 个动作（契约 06 示例同款生命周期），
  # 全部调用/自检逐条 JSONL 落盘；探针自身代码不抛错（listener/动作纪律）。
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
  Set-Content -Path (Join-Path $ProbeDir 'cordis.patch.yml') -Value "- insert:`n    - id: orch-probe31`n      name: '$ProbeName'" -Encoding utf8NoBOM
  $probeJs = @"
import { appendFileSync } from 'node:fs'
const LOG = '$ProbeLog'
const log = (entry) => { try { appendFileSync(LOG, JSON.stringify(entry) + '\n') } catch {} }
export function* apply(ctx) {
  // 契约 06 示例同款生命周期：inject 等服务可用，effect 持有 disposer（所有权只属调用方）
  ctx.inject(['scriptOrchestrator'], (ctx) => {
    const svc = ctx.scriptOrchestrator
    // —— selftest：注册面同步校验（坏名字/保留前缀/重名），结果落盘 ——
    const selftest = (label, fn) => {
      try { fn(); log({ kind: 'selftest', case: label, threw: false }) }
      catch (error) { log({ kind: 'selftest', case: label, threw: true, message: String(error?.message ?? error) }) }
    }
    selftest('bad-name', () => svc.registerAction({ name: 'Bad.Name', run: async () => {} }))
    selftest('no-dot', () => svc.registerAction({ name: 'oncall', run: async () => {} }))
    selftest('reserved-prefix', () => svc.registerAction({ name: 'script-orchestrator.echo', run: async () => {} }))
    selftest('missing-run', () => svc.registerAction({ name: 'probe.missing' }))
    let disposeSelf = null
    selftest('duplicate-ok-first', () => { disposeSelf = svc.registerAction({ name: 'probe.selftest', run: async () => {} }) })
    selftest('duplicate-throws', () => svc.registerAction({ name: 'probe.selftest', run: async () => {} }))
    if (disposeSelf) { disposeSelf(); disposeSelf() } // 幂等

    // —— 动作注册（全部经 ctx.effect 持有 disposer：所有权只属调用方） ——
    const echoContext = (variant) => async (context) => {
      log({
        kind: 'echo', variant,
        marker: context.payload?.marker ?? null,
        payload: context.payload ?? null,
        orchestrationId: context.orchestration?.id ?? null,
        runId: context.run?.runId ?? null,
        runStatus: context.run?.status ?? null,
        hasSignal: typeof context.signal?.addEventListener === 'function',
        hasReport: typeof context.report === 'function',
      })
      context.report('echo-' + variant)
    }
    const disposeEcho2 = { current: null }
    const disposeEcho3 = { current: null }
    const registerEcho3 = (variant) => {
      disposeEcho3.current = svc.registerAction({
        name: 'probe.echo3',
        description: '回显 payload（recycle3 重注册目标）',
        run: echoContext(variant),
      })
    }
    ctx.effect(() => {
      const disposers = []
      disposers.push(svc.registerAction({
        name: 'probe.echo', description: '回显 payload（v1）', run: echoContext('v1'),
      }))
      disposeEcho2.current = svc.registerAction({
        name: 'probe.echo2', description: '回显 payload（摘除演示目标）', run: echoContext('echo2'),
      })
      disposers.push(() => disposeEcho2.current?.())
      disposers.push(svc.registerAction({
        name: 'probe.drop2',
        description: '摘除 probe.echo2（在途摘除演示）',
        run: async () => {
          disposeEcho2.current?.() // 真正摘除：本 run 内后续对 probe.echo2 的解析得到 unknown_action
          log({ kind: 'drop2' })
        },
      }))
      registerEcho3('echo3-v1')
      disposers.push(() => disposeEcho3.current?.())
      disposers.push(svc.registerAction({
        name: 'probe.recycle3',
        description: '摘除并重注册 probe.echo3（同步 disposer 演示）',
        run: async () => {
          disposeEcho3.current?.()      // 幂等摘除（同步完成）
          registerEcho3('echo3-v2b')    // 紧随重注册：不误冲突（token 精确删除）
          log({ kind: 'recycle3', reRegistered: true })
        },
      }))
      disposers.push(svc.registerAction({
        name: 'probe.hang',
        description: '永不结束（演示动作超时；signal 中止时记日志但不结算）',
        run: (context) => new Promise(() => {
          context.signal.addEventListener('abort', () => log({ kind: 'hang-aborted', runId: context.run?.runId ?? null }))
          context.report('hang started')
        }),
      }))
      return () => { for (const dispose of disposers) { try { dispose() } catch {} } }
    })
    log({ kind: 'probe-ready' })
  })
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
  "name": "dsh-profile-orch31",
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
  # --port 0：OS 分配空闲端口（避免与并行 worktree 的无头宿主抢默认 3080）
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

function Invoke-Rpc($session, [int]$port, [string]$endpoint, $payload, [string]$rpcId = 'verify31') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/script-orchestrator/$endpoint" `
    -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 30
}

function Get-LatestRun($session, [int]$port, [string]$id) {
  $v = Invoke-Rpc $session $port 'view' @{ id = $id } "run-$id"
  return @{ orch = $v.result.value; run = @($v.result.value.runs)[0] }
}

function Get-ProbeEntries([string]$kind) {
  if (-not (Test-Path $ProbeLog)) { return @() }
  Get-Content $ProbeLog | ForEach-Object {
    $entry = $_ | ConvertFrom-Json
    if ($entry.kind -eq $kind) { $entry }
  }
}

# ISO 时刻（可能被 Invoke-RestMethod/ConvertFrom-Json 反序列化为 [datetime]，Kind=Utc）
# → Unix 毫秒。直接 [DateTimeOffset]::Parse([string]$dt) 会丢 Kind 标记、按本地时区
# 解释而差 8 小时（实测踩坑），必须显式构造偏移。
function ConvertTo-UnixMs($value) {
  if ($value -is [datetime]) {
    if ($value.Kind -eq 'Utc') { return [DateTimeOffset]::new($value, [TimeSpan]::Zero).ToUnixTimeMilliseconds() }
    return [DateTimeOffset]::new($value.ToUniversalTime(), [TimeSpan]::Zero).ToUnixTimeMilliseconds()
  }
  return [DateTimeOffset]::Parse([string]$value).ToUnixTimeMilliseconds()
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在（$Node）"
  Check (Test-Path $Dsh) "dsh.cmd 存在（$Dsh）"
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\actions.js')) 'pkg/lib/actions.js 存在'

  Step '阶段 1 · 隔离 profile 建立（worktree pkg + 注册能力探针插件）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\actions.js")) 'file: 依赖落到 profile node_modules'
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$ProbeName\lib\index.js")) '探针插件落到 profile node_modules'

  Step '阶段 2 · 无头启动 + 注册面自检 + 创建编排'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  $session1 = Get-AuthenticatedSession $host1.Url

  # 等探针就绪（inject 回调跑完自检与注册；上限 20 秒）
  $readyDeadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $readyDeadline) {
    if (@(Get-ProbeEntries 'probe-ready').Count -ge 1) { break }
    Start-Sleep -Milliseconds 500
  }
  Check (@(Get-ProbeEntries 'probe-ready').Count -ge 1) '探针插件完成注册（probe-ready）'

  # 探针 selftest：注册面同步校验全部生效
  $selftests = @(Get-ProbeEntries 'selftest')
  Check ($selftests.Count -ge 6) "探针 selftest 全部落盘（$($selftests.Count) 条）"
  foreach ($case in @('bad-name', 'no-dot', 'reserved-prefix', 'missing-run', 'duplicate-throws')) {
    $entry = $selftests | Where-Object { $_.case -eq $case } | Select-Object -First 1
    Check ($null -ne $entry -and $entry.threw -eq $true) "selftest '$case' 同步抛错（消息：$($entry.message)）"
  }
  $dupOk = $selftests | Where-Object { $_.case -eq 'duplicate-ok-first' } | Select-Object -First 1
  Check ($null -ne $dupOk -and $dupOk.threw -eq $false) 'selftest 首次注册 probe.selftest 成功（duplicate 前置）'

  # listActions 桥端点：6 个动作按名称排序、带 description（与 view.availableActions 同源）
  $la = Invoke-Rpc $session1 $host1.Port 'listActions' @{} 'la1'
  $names = @($la.result.value | ForEach-Object { $_.name })
  $namesSorted = ($names | Sort-Object) -join ','
  Check ($la.result.ok -eq $true) '桥 listActions 端点可用'
  Check ($names.Count -eq 6 -and ($names -join ',') -eq $namesSorted) `
    "listActions 返回 6 个动作且按名称排序（$($names -join ', ')）"
  $echoDesc = ($la.result.value | Where-Object { $_.name -eq 'probe.echo' }).description
  Check ("$echoDesc" -ne '') 'listActions 携带 description（probe.echo）'

  $nodeScript = @{ command = $Node; args = @('-e', 'process.exit(0)'); cwd = $RepoRoot }
  $mk = {
    param([string]$id, [string]$title, $actions, [string[]]$actionKeys)
    @{
      id = $id; title = $title
      trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
      script = $nodeScript
      judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = $actionKeys } ); fallback = @() }
      actions = $actions
    }
  }

  # O1 · probe.echo 被编排调用（payload 模板已渲染 + report 警告）
  $inputO1 = & $mk 'verify-register' '验证注册动作' @{
    'call-echo' = @{ kind = 'plugin'; action = 'probe.echo'; payload = @{
      marker = 'first'; summary = '{{orchestrationTitle}} 退出码 {{exitCode}}' } }
  } @('call-echo')
  # O2 · 同 run 内先摘除再调用 → 实时查表 unknown_action（partial）
  $inputO2 = & $mk 'verify-unregister' '验证注销' @{
    'drop-echo' = @{ kind = 'plugin'; action = 'probe.drop2' }
    'call-echo' = @{ kind = 'plugin'; action = 'probe.echo2'; payload = @{ marker = 'second' } }
  } @('drop-echo', 'call-echo')
  # O3 · 同步 disposer + 紧随重注册 → 后续解析命中新注册（token 精确删除）
  $inputO3 = & $mk 'verify-reregister' '验证重注册' @{
    'recycle-echo' = @{ kind = 'plugin'; action = 'probe.recycle3' }
    'call-echo' = @{ kind = 'plugin'; action = 'probe.echo3'; payload = @{ marker = 'third' } }
  } @('recycle-echo', 'call-echo')
  # O4 · 动作超时（timeoutSeconds=2）+ 后续动作照常（失败隔离，partial）
  $inputO4 = & $mk 'verify-timeout' '验证动作超时' @{
    'hang-page' = @{ kind = 'plugin'; action = 'probe.hang'; timeoutSeconds = 2 }
    'emit-after' = @{ kind = 'event'; name = 'after-timeout' }
  } @('hang-page', 'emit-after')
  # O5 · 保留前缀名：格式合法 → create 通过；运行时实时查表 → unknown_action（不静默跳过）
  $inputO5 = & $mk 'verify-reserved' '验证保留前缀运行时拒配' @{
    'reserved-page' = @{ kind = 'plugin'; action = 'script-orchestrator.page' }
  } @('reserved-page')

  $created = @()
  $latestNextMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach ($pair in @(
    @('O1', $inputO1), @('O2', $inputO2), @('O3', $inputO3), @('O4', $inputO4), @('O5', $inputO5)
  )) {
    $r = Invoke-Rpc $session1 $host1.Port 'create' $pair[1] "c-$($pair[0])"
    $created += ,@($pair[0], $r)
    Check ($r.result.ok -eq $true) "create $($pair[0]) 受理（next=$($r.result.value.nextOccurrence)）"
    if ($r.result.ok) {
      $nextMs = ConvertTo-UnixMs $r.result.value.nextOccurrence
      if ($nextMs -gt $latestNextMs) { $latestNextMs = $nextMs }
    }
  }

  # 非法创建：两段以上点号的注册动作名 → script_input_invalid(format) 不落库
  $badFormat = Invoke-Rpc $session1 $host1.Port 'create' (& $mk 'verify-bad-format' '非法注册名' @{
    'page' = @{ kind = 'plugin'; action = 'ops.oncall.extra' }
  } @('page')) 'cBad1'
  Check ($badFormat.result.ok -eq $false -and $badFormat.result.error.code -eq 'script_input_invalid' `
    -and $badFormat.result.error.details.reason -eq 'format') '非法创建（两段点号）→ script_input_invalid(format) 不落库'
  $listBad = Invoke-Rpc $session1 $host1.Port 'list' @{} 'cBad2'
  Check (@($listBad.result.value.items).Count -eq 5) '非法 create 后列表仍 5 条（未落库）'

  # view.availableActions 与桥 listActions 一致
  $v1 = Invoke-Rpc $session1 $host1.Port 'view' @{ id = 'verify-register' } 'v1'
  $availNames = @($v1.result.value.availableActions | ForEach-Object { $_.name })
  Check ($availNames.Count -eq 6 -and ($availNames -join ',') -eq ($names -join ',')) `
    'script_view 的 availableActions 与 listActions 同源一致'

  Step '阶段 3 · 等到最晚 nextOccurrence + 15s：五个编排各自动触发一轮并结算（O4 含 2 秒动作超时）'
  # 等待基于编排自己的 nextOccurrence（创建有先后；O4 结算需 +2s 超时，留 15s 余量）
  $wait = ($latestNextMs + 15000) - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-Host "  等待 $([int]$wait) ms（最晚 nextOccurrence=$latestNextMs + 15s）"
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }

  $o1 = Get-LatestRun $session1 $host1.Port 'verify-register'
  Check ($o1.run -and $o1.run.status -eq 'succeeded') "O1：run succeeded（status=$($o1.run.status)）"
  $o1a = @($o1.run.actions)[0]
  Check ($o1a.status -eq 'succeeded' -and $o1a.kind -eq 'plugin') 'O1：call-echo succeeded（plugin）'
  Check (($o1a.warnings -join '|') -match 'echo-v1') "O1：动作 warnings 含 report() 输出（$($o1a.warnings -join ' | ')）"
  $echo1 = @(Get-ProbeEntries 'echo') | Where-Object { $_.marker -eq 'first' } | Select-Object -First 1
  Check ($null -ne $echo1) 'O1：探针收到 probe.echo 调用（marker=first）'
  if ($echo1) {
    Check ($echo1.payload.summary -match '^验证注册动作 退出码 0$') "O1：ActionContext.payload 递归渲染（$($echo1.payload.summary)）"
    Check ($echo1.orchestrationId -eq 'verify-register' -and "$($echo1.runId)" -like 'run-*') 'O1：ActionContext 含 orchestration.id 与 run.runId'
    Check ($echo1.runStatus -eq 'succeeded') 'O1：ActionContext.run.status = succeeded（脚本阶段完成口径）'
    Check ($echo1.hasSignal -eq $true -and $echo1.hasReport -eq $true) 'O1：ActionContext 提供 signal 与 report'
  }

  $o2 = Get-LatestRun $session1 $host1.Port 'verify-unregister'
  Check ($o2.run -and $o2.run.status -eq 'partial') "O2：run partial（摘除后一成一败；status=$($o2.run.status)）"
  $o2a0 = @($o2.run.actions)[0]
  $o2a1 = @($o2.run.actions)[1]
  Check ($o2a0.status -eq 'succeeded') 'O2：drop-echo succeeded（摘除动作自身成功）'
  Check ($o2a1.status -eq 'failed' -and $o2a1.error.code -eq 'unknown_action') `
    "O2：摘除后同 run 内再次调用 → failed unknown_action（实时查表，不静默跳过）"
  Check ((@(Get-ProbeEntries 'echo') | Where-Object { $_.marker -eq 'second' }).Count -eq 0) 'O2：probe.echo2 未被调用（摘除生效）'
  Check (@(Get-ProbeEntries 'drop2').Count -eq 1) 'O2：探针收到 drop2 调用'

  $o3 = Get-LatestRun $session1 $host1.Port 'verify-reregister'
  Check ($o3.run -and $o3.run.status -eq 'succeeded') "O3：run succeeded（status=$($o3.run.status)）"
  $o3a1 = @($o3.run.actions)[1]
  Check ($o3a1.status -eq 'succeeded' -and ($o3a1.warnings -join '|') -match 'echo3-v2b') `
    "O3：重注册后调用命中新注册（report 标记 echo3-v2b；warnings=$($o3a1.warnings -join ' | ')）"
  Check (@(Get-ProbeEntries 'recycle3').Count -eq 1) 'O3：探针收到 recycle3（同步 disposer + 紧随重注册不误冲突）'
  $echo3 = @(Get-ProbeEntries 'echo') | Where-Object { $_.marker -eq 'third' } | Select-Object -First 1
  Check ($null -ne $echo3 -and $echo3.variant -eq 'echo3-v2b') 'O3：调用解析到重注册后的实现（variant=echo3-v2b）'

  $o4 = Get-LatestRun $session1 $host1.Port 'verify-timeout'
  Check ($o4.run -and $o4.run.status -eq 'partial') "O4：run partial（超时失败 + 后续成功；status=$($o4.run.status)）"
  $o4a0 = @($o4.run.actions)[0]
  $o4a1 = @($o4.run.actions)[1]
  Check ($o4a0.status -eq 'failed' -and $o4a0.error.code -eq 'timeout' -and $o4a0.error.message -match '2') `
    "O4：hang-page failed timeout（消息含秒数：$($o4a0.error.message)）"
  Check ($o4a1.status -eq 'succeeded' -and $o4a1.kind -eq 'event') 'O4：后续 event 动作照常执行（串行不挂死）'
  Check ((@(Get-ProbeEntries 'hang-aborted')).Count -ge 1) 'O4：超时中止了 ActionContext.signal（探针记录 hang-aborted）'
  Check (($o4a0.warnings -join '|') -match 'hang started') "O4：超时前 report() 的警告保留在失败记录（$($o4a0.warnings -join ' | ')）"

  $o5 = Get-LatestRun $session1 $host1.Port 'verify-reserved'
  Check ($o5.run -and $o5.run.status -eq 'failed') "O5：run failed（保留前缀名不可注册 → 运行时 unknown_action；status=$($o5.run.status)）"
  $o5a0 = @($o5.run.actions)[0]
  Check ($o5a0.error.code -eq 'unknown_action') 'O5：reserved-page failed unknown_action（create 只查格式、运行时实时查表）'

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
