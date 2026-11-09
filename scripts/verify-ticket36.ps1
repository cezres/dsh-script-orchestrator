#Requires -Version 7
# 票 36 Windows 全链路交付验收（端到端）：
#   交付面：engines.dsh / 依赖闭包 / exports / --dump-config 条目 / 页面 __DSH_BOOT__ 含本包
#     （HMR/冷重启/卸载/坏 client 等运维面由 verify-ticket24.ps1 覆盖，见验收记录）
#   端到端链：隔离 profile（file:）→ 打开面板权威数据 → 创建 every 编排 + 判定命中 + 三动作
#     （event / plugin 注册动作 / persistent session）→ 四类事件（run-started / run-settled /
#     action-settled / changed）+ 自定义事件经探针插件实证 → cron 编排自动触发一次 →
#     权威回读一致 → 手动 run 受理即返回（UI abort 只停等待的设计面：端点无等待面）→
#     删除级联（removedRuns 准确、list 归零、删除不发 changed）→ stderr 干净。
#   测试矩阵（单元/进程/取消/故障/恢复）由 pkg 内 vitest 全量套件承担（本验收记录引用结果）。
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
$PkgName = '@local/dsh-script-orchestrator'
$ProbeName = '@local/dsh-orch-probe36'

$Sandbox = Join-Path $RepoRoot '.sandbox\s36'
$SbxHome = Join-Path $Sandbox 'home'
$ProfileName = 'orch36'
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
  New-Item -ItemType Directory -Force -Path (Join-Path $ProbeDir 'lib') | Out-Null
  $pkgJson = @"
{
  "name": "$ProbeName",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "engines": { "dsh": "0.2.2-rc.1" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
"@
  Set-Content -Path (Join-Path $ProbeDir 'package.json') -Value $pkgJson -Encoding utf8NoBOM
  Set-Content -Path (Join-Path $ProbeDir 'cordis.patch.yml') -Value "- insert:`n    - id: orch-probe36`n      name: '$ProbeName'" -Encoding utf8NoBOM
  $probeJs = @"
import { appendFileSync } from 'node:fs'
const LOG = '$ProbeLog'
const log = (entry) => { try { appendFileSync(LOG, JSON.stringify(entry) + '\n') } catch {} }
export function* apply(ctx) {
  const names = [
    'script-orchestrator/run-started',
    'script-orchestrator/run-settled',
    'script-orchestrator/action-settled',
    'script-orchestrator/changed',
    'script-orchestrator/e2e-hit',
  ]
  for (const name of names) ctx.effect(() => ctx.on(name, (payload) => log({ kind: 'event', name, payload })))
  ctx.inject(['scriptOrchestrator'], (scoped) => {
    const svc = scoped.scriptOrchestrator
    scoped.effect(() => svc.registerAction({
      name: 'e2e.notify',
      description: 'E2E 注册动作：回显 payload 并上报 warning',
      run: async (context) => {
        log({ kind: 'action', marker: context.payload?.marker ?? null, runId: context.run?.runId ?? null, hasSignal: typeof context.signal?.addEventListener === 'function' })
        context.report('e2e-probe-report')
      },
    }))
  })
  yield () => {}
}
"@
  Set-Content -Path (Join-Path $ProbeDir 'lib\index.js') -Value $probeJs -Encoding utf8NoBOM
}

function Write-ProfileConfig {
  $patch = @"
- id: llm-probe36
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      probe-dead36:
        displayName: 验收死端点
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
    provider: probe-dead36
    model: probe-dead-model
- id: script-orchestrator
  config:
    allowedRoots:
      - $($RepoRoot -replace '\\', '\\')
"@
  Set-Content -Path (Join-Path $ProfileDir 'cordis.patch.yml') -Value $patch -Encoding utf8NoBOM
}

function New-SandboxProfile {
  Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
  New-ProbePackage
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $pkgJson = @"
{
  "name": "dsh-profile-orch36",
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
  Write-ProfileConfig
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

function Invoke-Rpc([string]$endpoint, $payload, [string]$rpcId = 'verify36') {
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

function Get-ProbeEntries {
  if (-not (Test-Path $ProbeLog)) { return @() }
  return @(Get-Content $ProbeLog | Where-Object { $_ -and $_.Trim() } | ForEach-Object {
    try { $_ | ConvertFrom-Json } catch { $null }
  } | Where-Object { $_ })
}

function Wait-RunSettled([string]$id, [string]$runId, [int]$timeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $view = Invoke-Rpc 'view' @{ id = $id; runs = 50 } 'poll'
    $run = @($view.result.value.runs) | Where-Object { $_.runId -eq $runId } | Select-Object -First 1
    if ($run -and @('succeeded', 'partial', 'failed', 'skipped', 'canceled', 'interrupted') -contains $run.status) { return $run }
  }
  throw "run $runId 未在 $timeoutSeconds 秒内结算"
}

try {
  Step '阶段 0 · 交付面预检（engines / 依赖闭包 / exports / 客户端入口）'
  Check (Test-Path $Node) 'node.exe 存在'
  Check (Test-Path $Dsh) 'dsh.cmd 存在'
  $pkgJson = Get-Content (Join-Path $RepoRoot 'pkg\package.json') -Raw | ConvertFrom-Json
  Check ($pkgJson.name -eq $PkgName) "包名 $PkgName"
  Check ($pkgJson.engines.dsh -eq '0.2.2-rc.1') 'engines.dsh 精确锁 0.2.2-rc.1'
  Check ($pkgJson.private -eq $true) 'private=true（不上 npm）'
  Check ($pkgJson.exports.'.' -eq './lib/index.js') 'Host 面 exports . → lib/index.js'
  Check ($pkgJson.exports.'./client' -eq './lib/client.js') 'client 面 exports ./client → lib/client.js'
  Check ($pkgJson.dsh.client.platform -eq 'web') "dsh.client.platform = web"
  Check ($null -ne $pkgJson.dsh.bundle.patch) 'dsh.bundle.patch 自插入声明存在'
  Check ($null -ne $pkgJson.dependencies.'@deepseek-ai/dsh-util-time') '依赖含 @deepseek-ai/dsh-util-time'
  Check ($null -ne $pkgJson.dependencies.'@deepseek-ai/schemastery') '依赖含 @deepseek-ai/schemastery（Config）'
  Check (-not ($pkgJson.dependencies.PSObject.Properties.Name -contains '@deepseek-ai/dsh-tools')) 'dsh-tools 不在 dependencies（peer）'
  Check (-not ($pkgJson.dependencies.PSObject.Properties.Name -contains '@deepseek-ai/dsh-agent')) '无 dsh-agent 常量依赖'

  Step '阶段 1 · 隔离 profile（file: 安装 + 探针插件 + 死端点 LLM + allowedRoots）'
  New-SandboxProfile
  Invoke-PnpmInstall $ProfileDir
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$PkgName\lib\index.js")) '本包 file: 落到 profile node_modules'
  Check (Test-Path (Join-Path $ProfileDir "node_modules\$ProbeName\lib\index.js")) '探针插件落位'

  Step '阶段 2 · --dump-config 条目 + 无头启动 + 页面 __DSH_BOOT__ 含本包'
  $env:DSH_HOME = $SbxHome
  $dumpOut = Join-Path $Sandbox 'dump-config.out.log'
  $dumpErr = Join-Path $Sandbox 'dump-config.err.log'
  $dumpProc = Start-Process -FilePath $env:ComSpec -ArgumentList "/c", "`"$Dsh`" --profile $ProfileName --dump-config" `
    -RedirectStandardOutput $dumpOut -RedirectStandardError $dumpErr -PassThru -WindowStyle Hidden
  if (-not $dumpProc.WaitForExit(60000)) { Stop-Process -Id $dumpProc.Id -Force -ErrorAction SilentlyContinue }
  $dumpText = (Get-Content $dumpOut -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $dumpErr -Raw -ErrorAction SilentlyContinue)
  Check ($dumpText -match 'script-orchestrator') '--dump-config 组合树出现插件条目（id: script-orchestrator）'

  $host1 = Start-HeadlessHost -logStem (Join-Path $Sandbox 'boot1')
  Connect-Rpc $host1.Url $host1.Port
  $page = Invoke-WebRequest -Uri $host1.Url -WebSession $script:RpcSession -UseBasicParsing
  Check ($page.Content -match '__DSH_BOOT__') '页面注入 __DSH_BOOT__'
  Check ($page.Content -match [regex]::Escape($PkgName)) '客户端 graph 含本包（client graph 构建正确）'

  Step '阶段 3 · 五工具 smoke（经真实服务路径：bridge/list 与工具共用 service；schema/错误映射由 vitest 全量套件覆盖）'
  $emptyList = Invoke-Rpc 'list' @{} 'list0'
  Check ($emptyList.result.ok -eq $true -and $emptyList.result.value.total -eq 0) 'list 空闭环（面板权威数据源可用）'
  $badCreate = Invoke-Rpc 'create' @{ title = ''; trigger = @{ kind = 'every'; everySeconds = 30 }; script = @{ command = 'x' }; judge = @{ rules = @(); fallback = @() }; actions = @{} } 'badCreate'
  Check ($badCreate.result.ok -eq $false -and $badCreate.result.error.code -eq 'script_input_invalid') '非法创建 → script_input_invalid（严格校验面）'
  $unknownView = Invoke-Rpc 'view' @{ id = 'nope' } 'v0'
  Check ($unknownView.result.ok -eq $false -and $unknownView.result.error.code -eq 'script_unknown') 'view 未知 id → script_unknown'

  Step '阶段 4 · E2E：every 编排 → 判定命中 → 三动作（event/plugin/session）→ 四类事件 + 自定义事件'
  $e1 = @{
    id = 'e2e-every'
    title = 'E2E 每次巡检'
    trigger = @{ kind = 'every'; everySeconds = 3600 }
    script = @{ command = $Node; args = @('-e', 'console.log("E2E36-OK"); console.error("E2E36-ERR")'); cwd = $RepoRoot }
    judge = @{ rules = @(@{ when = @{ exitCode = 0 }; actions = @('ev', 'act', 'sess') }); fallback = @() }
    actions = @{
      ev = @{ kind = 'event'; name = 'e2e-hit'; payload = @{ marker = 'E2E36'; summary = 'E2E 命中 {{orchestrationTitle}} {{runId}}' } }
      act = @{ kind = 'plugin'; action = 'e2e.notify'; payload = @{ marker = 'E2E36' } }
      sess = @{ kind = 'session'; mode = 'persistent'; prompt = '请检查 E2E 编排 {{orchestrationTitle}} 的输出（run {{runId}}）'; framing = 'banner' }
    }
  }
  $rE1 = Invoke-Rpc 'create' $e1 'cE1'
  Check ($rE1.result.ok -eq $true -and $rE1.result.value.id -eq 'e2e-every') 'E1 创建受理'
  $changedBeforeRun = @(Get-ProbeEntries | Where-Object { $_.kind -eq 'event' -and $_.name -eq 'script-orchestrator/changed' }).Count
  Check ($changedBeforeRun -ge 1) 'changed 事件在创建后发布（持久写入后）'

  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $runE1 = Invoke-Rpc 'run' @{ id = 'e2e-every' } 'runE1'
  $t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Check ($runE1.result.ok -eq $true -and $runE1.result.value.runId) 'E1 手动 run 受理即返回（runId + status）'
  Check (($t1 - $t0) -lt 3000) "run 端点受理即返回、不等待结算（耗时 $($t1 - $t0)ms）"
  $settledE1 = Wait-RunSettled 'e2e-every' $runE1.result.value.runId
  Check ($settledE1.status -eq 'succeeded') "E1 run 结算 succeeded（判定命中 + 三动作成功）"
  Check ($settledE1.matchedRule -eq 0 -and $settledE1.usedFallback -eq $false) '判定：命中规则 0（matchedRule 零下标、非 fallback）'
  $actions = @($settledE1.actions)
  Check ($actions.Count -eq 3) "动作结果 3 条（实际 $($actions.Count)）"
  Check ($actions[0].kind -eq 'event' -and $actions[0].status -eq 'succeeded') '动作 1：event 成功'
  Check ($actions[1].kind -eq 'plugin' -and $actions[1].status -eq 'succeeded') '动作 2：plugin 注册动作成功'
  Check (@($actions[1].warnings) -contains 'e2e-probe-report') 'plugin 动作 report() warnings 落入结果'
  Check ($actions[2].kind -eq 'session' -and $actions[2].status -eq 'succeeded' -and $actions[2].sessionId) "动作 3：session 成功且带 sessionId（$($actions[2].sessionId)）"
  Check ($settledE1.script.stdoutTail -match 'E2E36-OK') '脚本结果回读：stdout 尾部含标记'

  $entries = Get-ProbeEntries
  $eventNames = @($entries | Where-Object { $_.kind -eq 'event' } | ForEach-Object { $_.name })
  Check ($eventNames -contains 'script-orchestrator/run-started') '事件实证：run-started 已发布'
  Check ($eventNames -contains 'script-orchestrator/action-settled') "事件实证：action-settled 已发布（$(@($entries | Where-Object { $_.kind -eq 'event' -and $_.name -eq 'script-orchestrator/action-settled' }).Count) 条）"
  Check ($eventNames -contains 'script-orchestrator/run-settled') '事件实证：run-settled 已发布'
  Check ($eventNames -contains 'script-orchestrator/changed') '事件实证：changed 已发布'
  Check ($eventNames -contains 'script-orchestrator/e2e-hit') '自定义事件实证：e2e-hit 已发布（event 动作全名）'
  $hit = @($entries | Where-Object { $_.kind -eq 'event' -and $_.name -eq 'script-orchestrator/e2e-hit' })[0]
  $hitBody = $hit.payload.payload
  Check ("$($hitBody.marker)" -eq 'E2E36' -and "$($hitBody.summary)" -match [regex]::Escape("$($hit.payload.run.runId)")) '自定义事件载荷已渲染（marker + summary 含 runId）'
  Check ("$($hitBody.summary)" -match 'E2E 每次巡检') '模板变量 {{orchestrationTitle}} 渲染为编排标题'
  $probeAction = @($entries | Where-Object { $_.kind -eq 'action' })[0]
  Check ($null -ne $probeAction -and $probeAction.hasSignal -eq $true -and $probeAction.runId -eq $runE1.result.value.runId) 'plugin 动作收到 ActionContext（payload/runId/signal）'

  Step '阶段 5 · cron 编排自动触发一次（*/1 分钟）+ 权威回读'
  $e2 = @{
    id = 'e2e-cron'
    title = 'E2E 分钟巡检'
    trigger = @{ kind = 'cron'; expression = '*/1 * * * *'; timeZone = 'UTC' }
    script = @{ command = $Node; args = @('-e', 'console.log("E2E36-CRON")'); cwd = $RepoRoot }
    judge = @{ rules = @(); fallback = @() }
    actions = @{}
  }
  $rE2 = Invoke-Rpc 'create' $e2 'cE2'
  Check ($rE2.result.ok -eq $true -and $rE2.result.value.trigger.kind -eq 'cron') 'E2（cron */1 UTC）创建受理'
  $cronDeadline = (Get-Date).AddSeconds(90)
  $cronRun = $null
  while ((Get-Date) -lt $cronDeadline -and $null -eq $cronRun) {
    Start-Sleep -Seconds 2
    $viewE2 = Invoke-Rpc 'view' @{ id = 'e2e-cron'; runs = 50 } 'vE2'
    $cronRun = @($viewE2.result.value.runs) | Where-Object { $_.trigger -eq 'cron' } | Select-Object -First 1
  }
  Check ($null -ne $cronRun) 'cron 编排自动触发产生 run'
  if ($cronRun) {
    Check (@('succeeded', 'partial', 'failed') -contains $cronRun.status) "cron run 已结算（status=$($cronRun.status)）"
    $cronSettled = Wait-RunSettled 'e2e-cron' $cronRun.runId
    Check ($cronSettled.status -eq 'succeeded') 'cron run 经既有 runner 自动执行并结算 succeeded'
  }
  $viewE1After = Invoke-Rpc 'view' @{ id = 'e2e-every'; runs = 50 } 'vE1b'
  Check ($viewE1After.result.value.nextOccurrence -ne $null) '权威回读：E1 下次触发时刻保持（手动 run 不移自动计划）'
  $listNow = Invoke-Rpc 'list' @{} 'list2'
  Check ($listNow.result.value.total -eq 2) '权威回读：list 两条编排'

  Step '阶段 6 · 删除级联（removedRuns 准确、list 归零、删除不发 changed）'
  $changedBeforeDelete = @((Get-ProbeEntries) | Where-Object { $_.kind -eq 'event' -and $_.name -eq 'script-orchestrator/changed' }).Count
  $delE1 = Invoke-Rpc 'edit' @{ id = 'e2e-every'; action = 'delete' } 'del1'
  Check ($delE1.result.ok -eq $true -and [int]$delE1.result.value.removedRuns -ge 1) "E1 删除级联：removedRuns=$($delE1.result.value.removedRuns)"
  $delE2 = Invoke-Rpc 'edit' @{ id = 'e2e-cron'; action = 'delete' } 'del2'
  Check ($delE2.result.ok -eq $true) 'E2 删除受理'
  $listEnd = Invoke-Rpc 'list' @{} 'list3'
  Check ($listEnd.result.value.total -eq 0) '删除后 list 归零（记录不可见）'
  Start-Sleep -Milliseconds 500
  $changedAfterDelete = @((Get-ProbeEntries) | Where-Object { $_.kind -eq 'event' -and $_.name -eq 'script-orchestrator/changed' }).Count
  Check ($changedAfterDelete -eq $changedBeforeDelete) '删除不发 changed（契约 06「不为删除另发事件」）'

  Step '阶段 7 · stderr 与清理'
  $bootErr = Get-Content $host1.Err -Raw -ErrorAction SilentlyContinue
  Check ($null -eq $bootErr -or $bootErr -notmatch 'script-orchestrator') 'stderr 无 script-orchestrator 错误'
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
