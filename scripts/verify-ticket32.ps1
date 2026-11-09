#Requires -Version 7
# 票 32 隔离集成验证：persistent session 动作端到端（隔离沙箱 + 死端点 LLM，零真实 API/凭据）。
# 覆盖：缺省 preset/model（Host compose 链）、banner 全文（经 session_projcache 的 titleInput 证明
#   user/message 已 append——banner 抬头 + JSON 事实块 + 渲染后 prompt）、framing plain、缺省/显式标题、
#   显式 preset、lastPromptAt 可观测性（kind=user）、session cwd 越界（allowedRoots 经 profile 配置注入）、
#   preset_unknown、每 run 新建会话（两轮触发两个 sessionId 与各自缺省标题）、宿主重启后已建会话留存
#   （编排/插件生命周期与已建会话解耦；删除级联属票 29，本票只证不触碰）。
# 观测面说明：原始 session.v4.jsonl.zstd 在死路由场景仅落 header（票 23 E6 同象，事件后缀不落盘）；
#   会话级事实（标题/modelSelection/titleInput 全文/lastPromptAt）以宿主持久化的 session_projcache 为准。
# 绝不触碰真实用户 profile（独立 DSH_HOME）；无头宿主 --port 0（OS 分配端口，避开并行沙箱冲突）；
# 终止按端口监听进程杀（笔记 02）。
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

$Sandbox = Join-Path $RepoRoot '.sandbox\s32'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch32'
$ProfileDir = Join-Path $SbxHome "profiles\$ProfileName"
$PkgDir = (Join-Path $RepoRoot 'pkg') -replace '\\', '/'
$WorkDir = Join-Path $Sandbox 'work' # 脚本与会话的工作目录（在 allowedRoots=RepoRoot 之内）
$SessionsRoot = Join-Path $SbxHome 'sessions'
$LogReader = Join-Path $Sandbox 'read-session.cjs'

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
  New-Item -ItemType Directory -Force -Path $ProfileDir, $WorkDir | Out-Null
  $pkgJson = @"
{
  "name": "dsh-profile-orch32",
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
  # 死端点 LLM（原型票 23 样本）+ 本插件 allowedRoots 配置（session cwd 与脚本 cwd 同受限制）
  $patch = @"
# 死端点 LLM：模型选择链真实存在，实际调用立即连接拒绝（零真实 API、零凭据）。
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
- id: script-orchestrator
  config:
    allowedRoots:
      - $($RepoRoot -replace '\\', '\\')
"@
  Set-Content -Path (Join-Path $ProfileDir 'cordis.patch.yml') -Value $patch -Encoding utf8NoBOM

  # 会话日志读取器（zstd 解压 → 事实抽取；Node 24 内置 zstdDecompressSync）
  $reader = @'
const { readFileSync, readdirSync } = require('fs')
const { join } = require('path')
const { zstdDecompressSync } = require('zlib')
const root = process.argv[2]
const id = process.argv[3]
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
for (const f of walk(root)) {
  if (!f.endsWith('.zstd') || !f.includes(id)) continue
  const text = zstdDecompressSync(readFileSync(f)).toString('utf8')
  const lines = text.split('\n').filter(Boolean)
  console.log(JSON.stringify({
    file: f,
    lineCount: lines.length,
    flags: {
      header: lines[0] ?? '',
      hasUserMessage: text.includes('"user/message"'),
      hasTitleEvent: text.includes('"session/title"'),
      hasModelSelection: text.includes('"model/selection"'),
      hasNoModelError: text.includes('has no provider/model'),
      titleEvents: lines.filter((l) => l.includes('"session/title"')),
      modelSelectionEvents: lines.filter((l) => l.includes('"model/selection"')),
    },
  }))
}
'@
  Set-Content -Path $LogReader -Value $reader -Encoding utf8NoBOM
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

function Invoke-Rpc($session, [int]$port, [string]$endpoint, $payload, [string]$rpcId = 'verify32') {
  $body = @{ type = 'client-request'; rpcId = $rpcId; method = $endpoint; payload = $payload } | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/script-orchestrator/$endpoint" `
    -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 30
}

function Get-Runs($session, [int]$port, [string]$id, [int]$count = 1) {
  $v = Invoke-Rpc $session $port 'view' @{ id = $id; runs = $count } "view-$id"
  return @{ orch = $v.result.value; runs = @($v.result.value.runs) | Select-Object -First $count }
}

function Read-SessionLog([string]$sessionId) {
  $json = & $Node $LogReader $SessionsRoot $sessionId 2>$null | Select-Object -First 1
  if (-not $json) { return $null }
  return $json | ConvertFrom-Json
}

function Read-SessionProjcache([string]$sessionId) {
  # 宿主会话投影缓存（session_projcache）：本场景下持久化的权威观测面——
  # 标题 / modelSelection / agentPreset / titleInput（含首条消息全文）/ lastPromptAt。
  # （原始 session.v4.jsonl.zstd 的事件后缀在死路由场景不落盘，票 23 E6 同象——见 Comments。）
  $file = Join-Path $SbxHome "storages\session_projcache\sessions\$sessionId.json"
  if (-not (Test-Path $file)) { return $null }
  return (Get-Content $file -Raw | ConvertFrom-Json).record
}

function Get-SessionDirCount {
  if (-not (Test-Path $SessionsRoot)) { return 0 }
  return @(Get-ChildItem $SessionsRoot -Recurse -Filter 'session.v4.jsonl.zstd' -ErrorAction SilentlyContinue).Count
}

try {
  Step '阶段 0 · 环境预检'
  Check (Test-Path $Node) "node.exe 存在（$Node）"
  Check (Test-Path $Dsh) "dsh.cmd 存在（$Dsh）"
  Check (Test-Path (Join-Path $RepoRoot 'pkg\lib\session-action.js')) 'pkg/lib/session-action.js 存在'

  Step '阶段 1 · 隔离 profile 建立（worktree pkg + 死端点 LLM + allowedRoots 配置）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\session-action.js")) 'file: 依赖落到 profile node_modules'

  Step '阶段 2 · 无头启动 + 创建四个 session 编排'
  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  $session1 = Get-AuthenticatedSession $host1.Url
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $nodeScript = 'console.log("SESSION-ORCH-MARKER"); process.exit(0)'
  $baseScript = @{ command = $Node; args = @('-e', $nodeScript); cwd = $WorkDir }

  # A1 · 缺省链：不设 preset/model/title/framing → Host compose 默认；缺省标题；banner
  $inputA1 = @{
    id = 'verify-session-defaults'
    title = '缺省链巡检'
    trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
    script = $baseScript
    judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('open-triage') } ); fallback = @() }
    actions = @{ 'open-triage' = @{ kind = 'session'; prompt = '巡检退出码 {{exitCode}}，stdout：{{stdoutTail}}。请排查。' } }
  }
  # A2 · 显式 preset/model/title + framing plain
  $inputA2 = @{
    id = 'verify-session-explicit'
    title = '显式配置巡检'
    trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
    script = $baseScript
    judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('open-triage') } ); fallback = @() }
    actions = @{ 'open-triage' = @{
      kind = 'session'
      prompt = '显式配置场景，plain 正文。'
      preset = 'standard'
      model = @{ provider = 'probe-dead'; model = 'probe-dead-model' }
      title = '显式标题排查'
      framing = 'plain'
    } }
  }
  # B · session cwd 越界（allowedRoots = 仓库根；C:\Windows 在界外）
  $inputB = @{
    id = 'verify-session-cwd'
    title = '越界会话'
    trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
    script = $baseScript
    judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('open-triage') } ); fallback = @() }
    actions = @{ 'open-triage' = @{ kind = 'session'; prompt = 'p'; cwd = 'C:\Windows' } }
  }
  # C · preset 不存在
  $inputC = @{
    id = 'verify-session-preset'
    title = '未知预设'
    trigger = @{ kind = 'every'; everySeconds = 60; mode = 'fixed-rate' }
    script = $baseScript
    judge = @{ rules = @( @{ when = @{ exitCode = 0 }; actions = @('open-triage') } ); fallback = @() }
    actions = @{ 'open-triage' = @{ kind = 'session'; prompt = 'p'; preset = 'no-such-preset' } }
  }
  foreach ($pair in @(@('A1', $inputA1), @('A2', $inputA2), @('B', $inputB), @('C', $inputC))) {
    $r = Invoke-Rpc $session1 $host1.Port 'create' $pair[1] "c$($pair[0])"
    Check ($r.result.ok -eq $true) "create $($pair[0]) 受理"
  }

  Step '阶段 3 · 等 T+70s：四个编排各自动触发一轮并结算'
  $wait = 70 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait -gt 0) { Start-Sleep -Seconds $wait }

  $a1 = Get-Runs $session1 $host1.Port 'verify-session-defaults'
  $a1run = $a1.runs[0]
  Check ($a1run -and $a1run.status -eq 'succeeded') "A1：run succeeded（status=$($a1run.status)）"
  $a1action = @($a1run.actions)[0]
  Check ($a1action.status -eq 'succeeded' -and $a1action.sessionId -match '^session-[0-9a-f-]{36}$') `
    "A1：session 动作 succeeded 且记录 sessionId（$($a1action.sessionId)）"
  Check ($null -eq $a1action.warnings -or @($a1action.warnings).Count -eq 0) 'A1：动作无 warnings（rename/flush 均被接受）'
  $a1log = Read-SessionLog $a1action.sessionId
  Check ($null -ne $a1log) 'A1：会话日志文件存在（header 已持久化）'
  $a1cache = Read-SessionProjcache $a1action.sessionId
  Check ($null -ne $a1cache) 'A1：会话投影缓存存在（session_projcache）'
  if ($a1log) {
    Check ($a1log.flags.header -match [regex]::Escape($a1action.sessionId)) 'A1：日志 header 含 sessionId（requestedId == actualId）'
    Check ($a1log.flags.header -match '"agentPreset":"standard"') 'A1：缺省 preset 由 Host compose 解析为 standard（header.agentPreset）'
    Check (-not $a1log.flags.hasNoModelError) 'A1：缺省 model 链无 "has no provider/model"（agent-default-model 死端点选择真实生效）'
  }
  if ($a1cache) {
    $runTail = $a1run.runId.Substring($a1run.runId.Length - 4)
    $expectedTitle = "缺省链巡检 · $runTail"
    Check ($a1cache.rows.title.val -eq $expectedTitle) "A1：缺省标题生效（$($a1cache.rows.title.val)）"
    Check ($a1cache.rows.agentPreset.val -eq 'standard') 'A1：投影 agentPreset = standard（Host 默认）'
    Check ($a1cache.rows.modelSelection.val.lastUsed.provider -eq 'probe-dead' -and $a1cache.rows.modelSelection.val.lastUsed.model -eq 'probe-dead-model') `
      'A1：缺省 model 链真实生效（modelSelection.lastUsed = agent-default-model 配置的死端点）'
    $firstText = $a1cache.rows.titleInput.val.first.text
    Check ($firstText.StartsWith('[SCRIPT ORCHESTRATOR]' + "`n" + 'This message was triggered by a scheduled script, not typed by the user.')) `
      'A1：首条消息 = banner 抬头（projcache titleInput 全文证明 user/message 已 append）'
    Check ($firstText -match ([regex]::Escape('{"runId":"' + $a1run.runId + '","orchestrationId":"verify-session-defaults","status":"succeeded","exitCode":0,"timedOut":false,"durationMs":'))) `
      'A1：banner JSON 事实块字段与 run 事实一致（runId/orchestrationId/status/exitCode/timedOut/durationMs）'
    Check ($firstText -match '巡检退出码 0，stdout：SESSION-ORCH-MARKER') 'A1：prompt 模板变量已渲染（{{exitCode}}/{{stdoutTail}}）'
    Check ($a1cache.rows.sessionListMetadata.val.lastPromptAt -ne $null -and $a1cache.rows.sessionListMetadata.val.blank -eq $false) `
      'A1：source.kind=user 可观测性——lastPromptAt 已更新、会话非 blank（决策 21 #1）'
  }

  $a2 = Get-Runs $session1 $host1.Port 'verify-session-explicit'
  $a2run = $a2.runs[0]
  $a2action = @($a2run.actions)[0]
  Check ($a2run.status -eq 'succeeded' -and $a2action.status -eq 'succeeded' -and $a2action.sessionId) 'A2：run 与 session 动作均 succeeded，sessionId 已记录'
  Check ($null -eq $a2action.warnings -or @($a2action.warnings).Count -eq 0) 'A2：动作无 warnings'
  $a2log = Read-SessionLog $a2action.sessionId
  Check ($null -ne $a2log) 'A2：会话日志文件存在'
  $a2cache = Read-SessionProjcache $a2action.sessionId
  Check ($null -ne $a2cache) 'A2：会话投影缓存存在'
  if ($a2log) {
    Check ($a2log.flags.header -match '"agentPreset":"standard"') 'A2：显式 preset standard 进 header'
  }
  if ($a2cache) {
    Check ($a2cache.rows.title.val -eq '显式标题排查') "A2：显式 title 生效（$($a2cache.rows.title.val)）"
    Check ($a2cache.rows.titleInput.val.first.text -eq '显式配置场景，plain 正文。') 'A2：framing=plain——首条消息无 banner，仅 prompt 本身'
    Check ($a2cache.rows.modelSelection.val.lastUsed.provider -eq 'probe-dead' -and $a2cache.rows.modelSelection.val.lastUsed.model -eq 'probe-dead-model') `
      'A2：model 选择链生效（显式 select 未破坏投递；值与缺省同指向死端点，select 传参面由单测覆盖）'
    Check ($a2cache.rows.sessionListMetadata.val.lastPromptAt -ne $null) 'A2：lastPromptAt 已更新（plain 消息同样 kind=user）'
  }
  Check ($a1action.sessionId -ne $a2action.sessionId) 'A1/A2：不同编排不同 run 各自新建会话（不复用）'

  $b = Get-Runs $session1 $host1.Port 'verify-session-cwd'
  $baction = @($b.runs[0].actions)[0]
  Check ($b.runs[0].status -eq 'failed' -and $baction.error.code -eq 'cwd_not_allowed') 'B：session cwd 越界 → failed cwd_not_allowed'
  Check ($null -eq $baction.sessionId -or $baction.sessionId -eq '') 'B：无 sessionId（未创建会话）'

  $c = Get-Runs $session1 $host1.Port 'verify-session-preset'
  $caction = @($c.runs[0].actions)[0]
  Check ($c.runs[0].status -eq 'failed' -and $caction.error.code -eq 'preset_unknown') 'C：preset 不存在 → failed preset_unknown'
  Check ($null -eq $caction.sessionId -or $caction.sessionId -eq '') 'C：无 sessionId（未创建会话）'

  Check ((Get-SessionDirCount) -eq 2) "B/C 未创建任何会话目录（sessions 目录数 = $(Get-SessionDirCount)，应为 2）"

  Step '阶段 4 · 等 T+130s：A1/A2 第二次触发 → 每 run 新建会话'
  $wait2 = 135 - [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) / 1000)
  if ($wait2 -gt 0) { Start-Sleep -Seconds $wait2 }
  $a1b = Get-Runs $session1 $host1.Port 'verify-session-defaults' 2
  Check ($a1b.runs.Count -ge 2) "A1：已积累 $($a1b.runs.Count) 个 run"
  $secondAction = @($a1b.runs[0].actions)[0]
  Check ($a1b.runs[0].status -eq 'succeeded' -and $secondAction.sessionId -ne $a1action.sessionId) `
    "A1：第二轮 run 新建会话（$($secondAction.sessionId) ≠ $($a1action.sessionId)，不复用旧会话）"
  $secondCache = Read-SessionProjcache $secondAction.sessionId
  Check ($null -ne $secondCache -and $secondCache.rows.title.val -eq "缺省链巡检 · $($a1b.runs[0].runId.Substring($a1b.runs[0].runId.Length - 4))") `
    "A1：第二轮缺省标题带自己的 runId 尾 4 位（$($secondCache.rows.title.val)）"
  # 两轮 A1 + 两轮 A2 = 4（A2 同为 every 60s，也二次触发）
  Check ((Get-SessionDirCount) -eq 4) "会话目录数 = $(Get-SessionDirCount)（两轮 A1 + 两轮 A2，应为 4）"

  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') '启动 stderr 无 script-orchestrator 错误'

  Stop-HeadlessHost $host1.Port

  Step '阶段 5 · 冷重启：编排记录与会话留存互不触碰（删除级联属票 29，本票只证解耦）'
  $host2 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot2')
  $session2 = Get-AuthenticatedSession $host2.Url
  $a1c = Get-Runs $session2 $host2.Port 'verify-session-defaults' 5
  Check ($a1c.orch.id -eq 'verify-session-defaults' -and $a1c.runs.Count -ge 2) '重启后：编排与 run 历史（含 sessionId）经权威回读仍在'
  Check ((Get-SessionDirCount) -eq 4) "重启后：4 个已建会话目录原样留存（宿主/插件重启不触碰 persistent 会话；当前 $(Get-SessionDirCount)）"
  $cacheAfterRestart = Read-SessionProjcache $a1action.sessionId
  Check ($null -ne $cacheAfterRestart -and $cacheAfterRestart.rows.title.val -match '缺省链巡检') '重启后：会话投影缓存（标题等）留存可读'
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
