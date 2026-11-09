#Requires -Version 7
# 票 33 隔离集成验证：ephemeral session 动作端到端（隔离沙箱 + 死端点 LLM，零真实 API/凭据）。
# 探针插件（@local/dsh-orch33-probe，inject agents/sessionController/sessions）职责：
#   ① 轮询插件 runs 存储发现 sessionId，再轮询 ctx.agents.get 记录 live↔cold 转移（dispose 的外部可观测面）
#   ② 按 probe-tasks.json 对指定 live 会话注入用户接管对话（followup 内联 UserMessage）——验证活动推迟回收
#   ③ 按 probe-phase2.json 对冷会话 resolveAgent 重开 + followup + flush——验证冷会话可重新打开
# 覆盖：创建（agents.create 链）、投递（banner/plain、缺省标题）、空闲收敛、零延迟 dispose、
#   延迟 dispose、用户活动推迟、失败不回收（单测面 + preset_unknown 宿主负向）、杀宿主 teardown 近似、
#   冷会话重开。删除编排级联属票 29；delivery_failed 宿主级触发不可达（票 32 同边界，单测覆盖）。
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
$ProbeName = '@local/dsh-orch33-probe'

$Sandbox = Join-Path $RepoRoot '.sandbox\s33'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch33'
$ProfileDir = Join-Path $SbxHome "profiles\$ProfileName"
$PkgDir = (Join-Path $RepoRoot 'pkg') -replace '\\', '/'
$ProbeDir = (Join-Path $Sandbox 'probe') -replace '\\', '/'
$WorkDir = Join-Path $Sandbox 'work'
$SessionsRoot = Join-Path $SbxHome 'sessions'
$ProbeLog = (Join-Path $Sandbox 'probe-results.jsonl') -replace '\\', '/'
$ProbeTasks = (Join-Path $Sandbox 'probe-tasks.json') -replace '\\', '/'
$ProbePhase2 = (Join-Path $Sandbox 'probe-phase2.json') -replace '\\', '/'
# JS 单引号字符串会吞反斜杠：嵌入探针的路径一律用正斜杠（Node 在 Windows 接受 /）
$RunsDirJs = (Join-Path $SbxHome 'storages\script_orchestrator\runs') -replace '\\', '/'
$RunsDir = Join-Path $SbxHome 'storages\script_orchestrator\runs'

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
  Set-Content -Path (Join-Path $ProbeDir 'cordis.patch.yml') -Value "- insert:`n    - id: orch33-probe`n      name: '$ProbeName'" -Encoding utf8NoBOM
  $probeJs = @"
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const LOG = '$ProbeLog'
const TASKS = '$ProbeTasks'
const PHASE2 = '$ProbePhase2'
const RUNS_DIR = '$RunsDirJs'

const log = (entry) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n')
const inlineUser = (text) => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

export const inject = ['agents', 'sessionController', 'sessions']
export function* apply(ctx) {
  // ① liveness：轮询 runs 存储（run.actions[].sessionId）发现会话，经 ctx.agents.get 记录 live↔cold 转移
  const known = new Map() // sessionId → last live (bool | null)
  const sessionsOfRuns = () => {
    const found = []
    if (!existsSync(RUNS_DIR)) return found
    for (const file of readdirSync(RUNS_DIR)) {
      if (!file.endsWith('.json')) continue
      try {
        const record = JSON.parse(readFileSync(RUNS_DIR + '/' + file, 'utf8')).record
        for (const action of record.actions ?? []) if (action.sessionId) found.push({ sessionId: action.sessionId, orchestrationId: record.orchestrationId })
      } catch { /* 读取竞态：下一轮再试 */ }
    }
    return found
  }
  const pollLiveness = () => {
    for (const { sessionId } of sessionsOfRuns()) {
      if (known.has(sessionId)) continue
      known.set(sessionId, null) // 首见：尚未观测
    }
    for (const [sessionId, last] of known) {
      const live = ctx.agents.get(sessionId) !== undefined
      if (live !== last) {
        known.set(sessionId, live)
        log({ kind: 'liveness', sessionId, live })
      }
    }
  }
  const livenessTimer = setInterval(pollLiveness, 300)

  // ② 接管对话注入：tasks 文件出现后，对每个任务 resolveAgent → 按偏移 followup（内联 UserMessage）。
  // 防炸纪律：定时回调绝不外溢同步 throw / unhandled rejection（实测会 fatal 整个宿主）；
  // 读后改名 .consumed，宿主重启不会重复消费同一任务。
  let tasksDone = false
  const pollTasks = async () => {
    if (tasksDone || !existsSync(TASKS)) return
    tasksDone = true
    try { renameSync(TASKS, TASKS + '.consumed') } catch { /* 下一轮按存在性退出 */ }
    let tasks = []
    try {
      tasks = JSON.parse(readFileSync(TASKS + '.consumed', 'utf8'))
      if (!Array.isArray(tasks)) tasks = [tasks]
    } catch (error) { log({ kind: 'tasks-error', error: String(error) }) }
    for (const task of tasks) {
      try {
        const resolved = await ctx.sessionController.resolveAgent(task.sessionId)
        if (!('agent' in resolved)) { log({ kind: 'followup-resolve-failed', sessionId: task.sessionId }); continue }
        const agent = resolved.agent
        log({ kind: 'followup-resolved', sessionId: task.sessionId, liveAtResolve: ctx.agents.get(task.sessionId) !== undefined })
        let n = 0
        const startedAt = Date.now()
        for (const offsetMs of task.followupAfterMs ?? []) {
          const remain = offsetMs - (Date.now() - startedAt)
          if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain))
          n += 1
          try {
            agent.followup(inlineUser('【验证】用户接管对话 ' + n + '：请继续整理。'))
            const flushed = await ctx.sessions.flush(agent.session)
            log({ kind: 'followup', sessionId: task.sessionId, n, ok: true, flush: flushed })
          } catch (error) {
            log({ kind: 'followup', sessionId: task.sessionId, n, ok: false, error: String(error) })
          }
        }
      } catch (error) { log({ kind: 'followup-error', sessionId: task.sessionId, error: String(error) }) }
    }
  }
  const tasksTimer = setInterval(() => {
    pollTasks().catch((error) => log({ kind: 'tasks-error', error: String(error) }))
  }, 500)

  // ③ phase2：冷会话重开（宿主重启后由验证脚本写入 PHASE2 再启动）
  if (existsSync(PHASE2)) {
    const runPhase2 = async () => {
      let ids = []
      try {
        ids = JSON.parse(readFileSync(PHASE2, 'utf8'))
        if (!Array.isArray(ids)) ids = [ids]
      } catch (error) { log({ kind: 'phase2-error', error: String(error) }) }
      for (const sessionId of ids) {
        try {
          const resolved = await ctx.sessionController.resolveAgent(sessionId)
          if (!('agent' in resolved)) { log({ kind: 'phase2', sessionId, reopened: false }); continue }
          const agent = resolved.agent
          let followupOk = false
          let flush = null
          try {
            agent.followup(inlineUser('【验证】冷会话重开续聊。'))
            followupOk = true
            flush = await ctx.sessions.flush(agent.session)
          } catch (error) { log({ kind: 'phase2-followup-error', sessionId, error: String(error) }) }
          log({ kind: 'phase2', sessionId, reopened: true, followupOk, flush, live: ctx.agents.get(sessionId) !== undefined })
        } catch (error) { log({ kind: 'phase2', sessionId, reopened: false, error: String(error) }) }
      }
    }
    setTimeout(() => {
      runPhase2().catch((error) => log({ kind: 'phase2-error', error: String(error) }))
    }, 3000)
  }

  ctx.effect(() => () => {
    clearInterval(livenessTimer)
    clearInterval(tasksTimer)
  })
  yield () => {}
}
"@
  Set-Content -Path (Join-Path $ProbeDir 'lib\index.js') -Value $probeJs -Encoding utf8NoBOM
}

function New-SandboxProfile {
  Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
  New-ProbePackage
  New-Item -ItemType Directory -Force -Path $ProfileDir, $WorkDir | Out-Null
  $pkgJson = @"
{
  "name": "dsh-profile-orch33",
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
  $patch = @"
# 死端点 LLM（票 23 样本）：模型选择链真实存在、实际调用立即连接拒绝。
- id: llm-probe
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      probe-dead:
        displayName: 探针死端点
        api: openai-completions
        baseURL: http://127.0.0.1:1/v1
        headers:
          Authorization: Bearer probe
        models:
          - id: probe-dead-model
            name: Probe Dead Model
            contextWindow: 8192
            maxTokens: 1024
            input:
              - text
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: probe-dead
    model: probe-dead-model
"@
  Set-Content -Path (Join-Path $ProfileDir 'cordis.patch.yml') -Value $patch -Encoding utf8NoBOM
}

function Invoke-PnpmInstall([string]$workDir) {
  $env:PATH = (Split-Path $Node -Parent) + ';' + $env:PATH
  $env:CI = 'true'
  Push-Location $workDir
  try {
    & $Node $Pnpm install --no-frozen-lockfile --reporter=append-only 2>&1 | ForEach-Object { "$_" } | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host '  （pnpm install exit 1：已知 ERR_PNPM_IGNORED_BUILDS，预编译可用即正常）' }
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

function Invoke-Rpc($session, [int]$port, [string]$endpoint, $payload, [string]$rpcId = 'verify33') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/script-orchestrator/$endpoint" `
    -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 30
}

function Get-LatestRun($session, [int]$port, [string]$id) {
  $v = Invoke-Rpc $session $port 'view' @{ id = $id } "view-$id"
  return @($v.result.value.runs)[0]
}

function Read-SessionProjcache([string]$sessionId) {
  $file = Join-Path $SbxHome "storages\session_projcache\sessions\$sessionId.json"
  if (-not (Test-Path $file)) { return $null }
  return (Get-Content $file -Raw | ConvertFrom-Json).record
}

function Get-SessionDirCount {
  if (-not (Test-Path $SessionsRoot)) { return 0 }
  return @(Get-ChildItem $SessionsRoot -Recurse -Filter 'session.v4.jsonl.zstd' -ErrorAction SilentlyContinue).Count
}

function Read-ProbeLines([string]$kind, [string]$sessionId) {
  if (-not (Test-Path $ProbeLog)) { return @() }
  $entries = @()
  foreach ($line in (Get-Content $ProbeLog)) {
    try {
      $entry = $line | ConvertFrom-Json
      if ($entry.kind -eq $kind -and $entry.sessionId -eq $sessionId) { $entries += $entry }
    } catch { /* 追加写竞态的半行：跳过 */ }
  }
  return $entries
}

function Get-LiveState([string]$sessionId) {
  # 探针 liveness 转移日志的末态（true=live、false=cold）；从未观测返回 $null
  $lines = @(Read-ProbeLines 'liveness' $sessionId)
  if ($lines.Count -eq 0) { return $null }
  return [bool]($lines | Select-Object -Last 1).live
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在（$Node）"
  Check (Test-Path $Dsh) "dsh.cmd 存在（$Dsh）"
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\ephemeral-lifecycle.js')) 'pkg/lib/ephemeral-lifecycle.js 存在'

  Step '阶段 1 · 隔离 profile 建立（worktree pkg + liveness/接管探针 + 死端点 LLM）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\ephemeral-lifecycle.js")) 'file: 依赖落到 profile node_modules'
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$ProbeName\lib\index.js")) '探针插件落到 profile node_modules'

  Step '阶段 2 · 无头启动 + 创建五个 ephemeral 编排'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  $session1 = Get-AuthenticatedSession $host1.Url
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $baseScript = @{ command = $Node; args = @('-e', 'console.log("EPH-MARKER"); process.exit(0)'); cwd = $WorkDir }
  $judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('summarize') } ); fallback = @() }

  $inputs = @{
    'eph-zero' = @{
      id = 'eph-zero'; title = '零延迟整理'; trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
      script = $baseScript; judge = $judge
      actions = @{ summarize = @{ kind = 'session'; mode = 'ephemeral'; prompt = '整理退出码 {{exitCode}}，stdout：{{stdoutTail}}。' } }
    }
    'eph-delay' = @{
      id = 'eph-delay'; title = '延迟回收整理'; trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
      script = $baseScript; judge = $judge
      actions = @{ summarize = @{ kind = 'session'; mode = 'ephemeral'; prompt = 'plain 正文整理。'; idleDisposeSeconds = 30; framing = 'plain'; title = '临时整理现场'; preset = 'standard' } }
    }
    'eph-activity' = @{
      id = 'eph-activity'; title = '活动推迟整理'; trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
      script = $baseScript; judge = $judge
      actions = @{ summarize = @{ kind = 'session'; mode = 'ephemeral'; prompt = '等待用户接管。'; idleDisposeSeconds = 15 } }
    }
    'eph-long' = @{
      id = 'eph-long'; title = '长驻整理'; trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
      script = $baseScript; judge = $judge
      actions = @{ summarize = @{ kind = 'session'; mode = 'ephemeral'; prompt = '长驻。'; idleDisposeSeconds = 600; model = @{ provider = 'probe-dead'; model = 'probe-dead-model' } } }
    }
    'eph-preset' = @{
      id = 'eph-preset'; title = '未知预设整理'; trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
      script = $baseScript; judge = $judge
      actions = @{ summarize = @{ kind = 'session'; mode = 'ephemeral'; prompt = 'p'; preset = 'no-such-preset' } }
    }
  }
  foreach ($name in @('eph-zero', 'eph-delay', 'eph-activity', 'eph-long', 'eph-preset')) {
    $r = Invoke-Rpc $session1 $host1.Port 'create' $inputs[$name] "c-$name"
    Check ($r.result.ok -eq $true) "create $name 受理"
  }

  Step '阶段 3 · 等 T+70s：五个编排各自动触发一轮并结算'
  $wait = 70 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }

  $runs = @{}
  foreach ($name in $inputs.Keys) { $runs[$name] = Get-LatestRun $session1 $host1.Port $name }
  foreach ($name in @('eph-zero', 'eph-delay', 'eph-activity', 'eph-long')) {
    $action = @($runs[$name].actions)[0]
    Check ($runs[$name].status -eq 'succeeded' -and $action.status -eq 'succeeded' -and $action.sessionId -match '^session-[0-9a-f-]{36}$') `
      "$name：run 与 session 动作 succeeded，sessionId 已记录（$($action.sessionId)）"
  }
  $presetAction = @($runs['eph-preset'].actions)[0]
  Check ($runs['eph-preset'].status -eq 'failed' -and $presetAction.error.code -eq 'preset_unknown' -and $null -eq $presetAction.sessionId) `
    'eph-preset：preset 解析失败 → failed preset_unknown 且未创建会话（失败在 agents.create 之前）'
  Check ((Get-SessionDirCount) -eq 4) "会话目录数 = $(Get-SessionDirCount)（四个成功编排各一，应为 4）"

  # projcache 观测面（票 32 Comments 偏差 1）：标题 / titleInput 全文 / modelSelection / agentPreset
  $zeroId = @($runs['eph-zero'].actions)[0].sessionId
  $zeroCache = Read-SessionProjcache $zeroId
  Check ($null -ne $zeroCache) 'eph-zero：会话投影缓存存在'
  if ($zeroCache) {
    $runTail = $runs['eph-zero'].runId.Substring($runs['eph-zero'].runId.Length - 4)
    Check ($zeroCache.rows.title.val -eq "零延迟整理 · $runTail") "eph-zero：缺省标题生效（$($zeroCache.rows.title.val)）"
    Check ($zeroCache.rows.titleInput.val.first.text.StartsWith('[SCRIPT ORCHESTRATOR]')) 'eph-zero：banner 首条消息（titleInput 全文）'
    Check ($zeroCache.rows.titleInput.val.first.text -match '整理退出码 0，stdout：EPH-MARKER') 'eph-zero：prompt 模板已渲染'
    Check ($zeroCache.rows.agentPreset.val -eq 'standard') 'eph-zero：缺省 preset 解析为 standard（resolve→mount 链）'
    Check ($zeroCache.rows.modelSelection.val.lastUsed.model -eq 'probe-dead-model') 'eph-zero：缺省 model = currentSelection（agent-default-model 死端点）'
  }
  $delayId = @($runs['eph-delay'].actions)[0].sessionId
  $delayCache = Read-SessionProjcache $delayId
  if ($delayCache) {
    Check ($delayCache.rows.title.val -eq '临时整理现场') 'eph-delay：显式标题生效'
    Check ($delayCache.rows.titleInput.val.first.text -eq 'plain 正文整理。') 'eph-delay：framing=plain（titleInput 恰为 prompt 本身）'
  }

  # 写入接管任务（数组形状：-InputObject @() 免管道解包；偏移为绝对毫秒）：eph-activity
  # （idleDisposeSeconds=15 → 无活动将于 ~T+76 回收；三次接管对话 0.5/3/6s 后到达，
  # 回收推迟到最后一次活动 +15s ≈ T+92）
  $activityId = @($runs['eph-activity'].actions)[0].sessionId
  ConvertTo-Json -InputObject @(
    @{ sessionId = $activityId; followupAfterMs = @(500, 3000, 6000) }
  ) -Depth 5 | Set-Content -Path ($ProbeTasks -replace '/', '\') -Encoding utf8NoBOM

  Step '阶段 4 · T+80s：零延迟已回收、延迟/活动/长驻仍 live（liveness 探针）'
  $wait = 80 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }
  $longId = @($runs['eph-long'].actions)[0].sessionId
  Check ((Get-LiveState $zeroId) -eq $false) 'eph-zero：零延迟已 dispose（agents 注册表已注销，冷会话）'
  Check ((Get-LiveState $delayId) -eq $true) 'eph-delay（30s）：仍 live（延迟未到）'
  Check ((Get-LiveState $activityId) -eq $true) 'eph-activity：仍 live（无活动将于 T+76 回收——接管对话已推迟回收）'
  Check ((Get-LiveState $longId) -eq $true) 'eph-long（600s）：仍 live'
  $followups = @(Read-ProbeLines 'followup' $activityId)
  Check ($followups.Count -eq 3 -and ($followups | Where-Object { $_.ok -ne $true }).Count -eq 0) `
    "eph-activity：三次用户接管对话均被接受（followup+flush；探针记录 $($followups.Count) 条）"

  Step '阶段 5 · T+105s：延迟与活动会话均已 dispose；目录与投影留存'
  $wait = 108 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }
  Check ((Get-LiveState $delayId) -eq $false) 'eph-delay：30s 延迟到点后已 dispose'
  Check ((Get-LiveState $activityId) -eq $false) 'eph-activity：最后一次接管后 15s 已 dispose'
  Check ((Get-LiveState $longId) -eq $true) 'eph-long：仍未到 600s，保持 live'
  Check ((Get-SessionDirCount) -eq 4) "会话目录数 = $(Get-SessionDirCount)（dispose 是 teardown 不是删除——历史留存）"
  $zeroCacheAfter = Read-SessionProjcache $zeroId
  Check ($null -ne $zeroCacheAfter -and $zeroCacheAfter.rows.title.val -match '零延迟整理') 'eph-zero：dispose 后投影缓存（标题/历史）仍可读'

  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') '启动 stderr 无 script-orchestrator 错误'
  Stop-HeadlessHost $host1.Port

  Step '阶段 6 · 冷重启：冷会话重开（phase2 探针）——杀宿主 = owner-fiber teardown 近似（契约先例）'
  # 插件重启不重新认领历史 ephemeral：冷会话原样留存，重开由探针显式触发
  ConvertTo-Json -InputObject @($zeroId, $delayId, $activityId, $longId) | Set-Content -Path ($ProbePhase2 -replace '/', '\') -Encoding utf8NoBOM
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  $phase2Deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Seconds 2
    $phase2 = @($zeroId, $delayId, $activityId, $longId) | ForEach-Object { @(Read-ProbeLines 'phase2' $_) | Select-Object -First 1 }
  } while (($phase2 | Where-Object { $null -ne $_ }).Count -lt 4 -and (Get-Date) -lt $phase2Deadline)
  foreach ($pair in @(@('eph-zero', $zeroId), @('eph-delay', $delayId), @('eph-activity', $activityId), @('eph-long', $longId))) {
    $entry = @(Read-ProbeLines 'phase2' $pair[1]) | Select-Object -First 1
    Check ($null -ne $entry -and $entry.reopened -eq $true -and $entry.followupOk -eq $true -and $entry.flush -eq $true) `
      "$($pair[0])：冷会话重开成功（resolveAgent → followup 接受 → flush true）"
  }
  Check ((Get-SessionDirCount) -eq 4) "重启后：会话目录仍为 4（持久化日志与目录不因重启/重开变化；当前 $(Get-SessionDirCount)）"
  $boot2Err = Get-Content $host2.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $boot2Err -or $boot2Err -notmatch 'script-orchestrator') '重启 stderr 无 script-orchestrator 错误'
  Stop-HeadlessHost $host2.Port
}
finally {
  Step '清理 · 杀沙箱宿主进程'
  foreach ($stem in @('boot1', 'boot2')) {
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
