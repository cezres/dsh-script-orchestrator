#Requires -Version 7.0
<#
.SYNOPSIS
  安装/更新本仓库的 dsh-script-orchestrator 插件到本机 DSH profile。

.DESCRIPTION
  本插件是单包双面（Host + Web client）、简化档零构建：`pkg/lib/` 与
  `pkg/cordis.patch.yml` 即交付物，无需 `pnpm build`。脚本流程：

    1. 预检仓库包（pkg/package.json、lib/index.js、lib/client.js、cordis.patch.yml）；
    2. 解析本机 DSH 自带的 node/pnpm（DSH_HOME\dsh-runtimes，缺失时回退 PATH）；
    3. 检查目标 profile 清单（file: 依赖、`dsh.profile.bundles` 选中）与已安装副本；
    4. 若已是最新，直接报告并退出；
    5. DSH 未运行（或指定 -AssumeStopped）：
         写 profile 清单 + 在 profile 目录 pnpm remove / pnpm add file:<本仓库 pkg>，
         随后逐文件校验安装副本；下次启动 DSH 生效；
    6. DSH 正在运行：
         脚本不直接改 profile（loader 会报 package-moved 并停用插件）。提示两条安全路径：
           a) 在 DSH 插件管理器中对该 bundle 执行 remove → install（自动热重载，无需重启；
              也可让 agent 调用 plugin_manager 工具：install_bundle file:<本仓库 pkg>）；
           b) 完全退出 DSH 后重新运行本脚本。
  说明：本插件不需要必填配置（使用默认值；`allowedRoots` 为空时不限制路径根并记录一条
  激活警告）。如需限制脚本/会话 cwd 或调整执行参数，可在 profile 的 `cordis.patch.yml`
  追加 `- id: script-orchestrator` + `config:`（字段见 docs/temp/12-packaging.md 与
  docs/temp/03-execution.md）。

.PARAMETER Profile
  profile 名。默认取 $env:DSH_PROFILE，否则 desktop（Electron 托管 profile）。

.PARAMETER DshHome
  DSH_HOME 目录。默认取 $env:DSH_HOME，否则 ~/.dsh。

.PARAMETER AssumeStopped
  假定 DSH 未运行：跳过进程检测，按离线路径执行安装/更新。
  用于对未运行的本机 DSH、其他 DSH_HOME 目录或 CI 预装。

.PARAMETER DryRun
  只打印将执行的操作，不写文件、不运行 pnpm。

.EXAMPLE
  pwsh -NoProfile -File .\scripts\install-script-orchestrator.ps1

.EXAMPLE
  pwsh -NoProfile -File .\scripts\install-script-orchestrator.ps1 -DryRun

.EXAMPLE
  pwsh -NoProfile -File .\scripts\install-script-orchestrator.ps1 -DshHome D:\other-dsh -Profile desktop -AssumeStopped
#>
[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$AssumeStopped,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageDir = Join-Path $repoRoot 'pkg'
$packageName = '@local/dsh-script-orchestrator'
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$manifestPath = Join-Path $profileDir 'package.json'
$lockPath = Join-Path $profileDir 'pnpm-lock.yaml'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$installedDir = Join-Path $profileDir 'node_modules\@local\dsh-script-orchestrator'
$desiredSpec = 'file:' + ($packageDir -replace '\\', '/')
$utf8 = [System.Text.UTF8Encoding]::new($false)
# 影响运行时行为的文件（逐文件哈希比较；文档改动不要求重装）
$runtimeFileList = @('cordis.patch.yml', 'package.json')
# 简化档零构建：这些文件必须存在（pkg/lib 即产物）
$requiredArtifacts = @(
  'package.json',
  'cordis.patch.yml',
  'lib\index.js',
  'lib\client.js'
)

function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}
function Write-Info([string]$Message) { Write-Host "    $Message" }
function Fail([string]$Message) { throw "install-script-orchestrator: $Message" }

function Read-JsonFile([string]$Path) {
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}
function Write-JsonFile([string]$Path, $Value) {
  $json = ($Value | ConvertTo-Json -Depth 100) + [Environment]::NewLine
  [System.IO.File]::WriteAllText($Path, $json, $utf8)
}

function Resolve-Toolchain {
  $runtimeRoot = Join-Path $DshHome 'dsh-runtimes'
  if (Test-Path -LiteralPath $runtimeRoot) {
    $runtimes = @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending)
    foreach ($runtime in $runtimes) {
      $nodeExe = Join-Path $runtime.FullName 'dependencies\node\bin\node.exe'
      $pnpmMjs = Join-Path $runtime.FullName 'dependencies\pnpm\bin\pnpm.mjs'
      if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $pnpmMjs)) {
        return [pscustomobject]@{ Node = $nodeExe; Runner = 'script'; Pnpm = $pnpmMjs }
      }
    }
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($node -and $pnpm) {
    return [pscustomobject]@{ Node = $node.Source; Runner = 'cli'; Pnpm = $pnpm.Source }
  }
  Fail '找不到 node/pnpm。请安装 Node.js ≥24.9 与 pnpm，或用 -DshHome 指向含 dsh-runtimes 的 DSH_HOME。'
}

function Get-ManifestState($Manifest) {
  $spec = $null
  if ($Manifest.PSObject.Properties['dependencies'] -and
      $Manifest.dependencies.PSObject.Properties[$packageName]) {
    $spec = $Manifest.dependencies.PSObject.Properties[$packageName].Value
  }
  $bundles = @()
  if ($Manifest.PSObject.Properties['dsh'] -and
      $Manifest.dsh.PSObject.Properties['profile'] -and
      $Manifest.dsh.profile.PSObject.Properties['bundles']) {
    $bundles = @($Manifest.dsh.profile.bundles)
  }
  return [pscustomobject]@{
    DependencySpec = $spec
    HasDependency = $null -ne $spec
    BundleSelected = $bundles -contains $packageName
  }
}

function Update-Manifest($Manifest) {
  $changed = $false

  if (-not $Manifest.PSObject.Properties['dependencies']) {
    $Manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
    $changed = $true
  }
  $dep = $Manifest.dependencies.PSObject.Properties[$packageName]
  if (-not $dep -or $dep.Value -ne $desiredSpec) {
    $Manifest.dependencies | Add-Member -NotePropertyName $packageName -NotePropertyValue $desiredSpec -Force
    $changed = $true
  }

  if (-not $Manifest.PSObject.Properties['dsh']) {
    $Manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{
        profile = [pscustomobject]@{ bundles = @($packageName) }
      }) -Force
    $changed = $true
  } elseif (-not $Manifest.dsh.PSObject.Properties['profile']) {
    $Manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{
        bundles = @($packageName)
      }) -Force
    $changed = $true
  } elseif (-not $Manifest.dsh.profile.PSObject.Properties['bundles']) {
    $Manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($packageName) -Force
    $changed = $true
  } elseif (-not (@($Manifest.dsh.profile.bundles) -contains $packageName)) {
    $Manifest.dsh.profile.bundles = @(@($Manifest.dsh.profile.bundles) + $packageName)
    $changed = $true
  }

  return $changed
}

function Invoke-PnpmCommand {
  param([string[]]$Arguments, [switch]$AllowFailure)
  Push-Location -LiteralPath $repoRoot
  try {
    if ($tools.Runner -eq 'script') { & $tools.Node $tools.Pnpm @Arguments } else { & $tools.Pnpm @Arguments }
    $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  } finally {
    Pop-Location
  }
  if ($code -ne 0) {
    if ($AllowFailure) {
      Write-Info "（预期中的 pnpm $($Arguments -join ' ') 退出码 $code，已忽略）"
      return $code
    }
    Fail "pnpm $($Arguments -join ' ') 失败（exit $code）"
  }
  return $code
}

function Get-InstalledCopyMismatches([string]$InstalledRoot) {
  $mismatches = [System.Collections.Generic.List[string]]::new()
  if (-not (Test-Path -LiteralPath $InstalledRoot)) {
    $mismatches.Add('安装副本不存在')
    return ,$mismatches
  }
  $libRoot = Join-Path $packageDir 'lib'
  Get-ChildItem -LiteralPath $libRoot -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($libRoot.Length).TrimStart('\', '/')
    $target = Join-Path (Join-Path $InstalledRoot 'lib') $relative
    if (-not (Test-Path -LiteralPath $target)) {
      $mismatches.Add("缺少 lib/$relative")
    } elseif ((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -ne
              (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) {
      $mismatches.Add("内容不同 lib/$relative")
    }
  }
  foreach ($file in $runtimeFileList) {
    $source = Join-Path $packageDir $file
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $target = Join-Path $InstalledRoot $file
    if (-not (Test-Path -LiteralPath $target)) {
      $mismatches.Add("缺少 $file")
    } elseif ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
              (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) {
      $mismatches.Add("内容不同 $file")
    }
  }
  return ,$mismatches
}

function Assert-InstalledCopyMatches([string]$InstalledRoot) {
  $mismatches = Get-InstalledCopyMismatches -InstalledRoot $InstalledRoot
  if ($mismatches.Count -gt 0) {
    $detail = ($mismatches | Select-Object -First 8 | ForEach-Object { "  - $_" }) -join [Environment]::NewLine
    Fail "安装副本与仓库 pkg 不一致（共 $($mismatches.Count) 处）：`n$detail"
  }
  Write-Info '安装副本与仓库 pkg 逐文件一致（0 处差异）'
}

# ---- 前置检查 ----------------------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'package.json'))) {
  Fail "脚本必须位于仓库的 scripts 目录（找不到 $packageDir\package.json）。"
}
$repoManifest = Read-JsonFile (Join-Path $packageDir 'package.json')
if ($repoManifest.name -ne $packageName) {
  Fail "脚本所在仓库的 pkg 不是 $packageName（当前是 $($repoManifest.name)）。"
}
foreach ($artifact in $requiredArtifacts) {
  if (-not (Test-Path -LiteralPath (Join-Path $packageDir $artifact))) {
    Fail "缺少交付产物 pkg\$artifact（简化档零构建：请确认 lib/ 与 cordis.patch.yml 已提交）。"
  }
}
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Fail "找不到 profile 清单 $manifestPath。请在 DSH 中创建/启动该 profile，或用 -Profile/-DshHome 指定。"
}

$tools = Resolve-Toolchain
$env:PATH = (Split-Path -Parent $tools.Node) + [System.IO.Path]::PathSeparator + $env:PATH

$dshRunning = $false
if (-not $AssumeStopped) {
  $dshRunning = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0
}

Write-Step '目标'
Write-Info "仓库：$repoRoot"
Write-Info "包目录：$packageDir（零构建）"
Write-Info "包名：$packageName"
Write-Info "profile：$profileDir"
Write-Info "依赖 spec：$desiredSpec"
Write-Info "DSH 进程：$(if ($dshRunning) { '运行中' } else { '未运行/假定未运行' })"
Write-Info "node：$($tools.Node)"
Write-Info "pnpm：$($tools.Pnpm)（$($tools.Runner)）"

# ---- 状态判定 ----------------------------------------------------------------
$manifest = Read-JsonFile $manifestPath
$state = Get-ManifestState $manifest
$installedCopyExists = Test-Path -LiteralPath $installedDir
$mismatches = Get-InstalledCopyMismatches -InstalledRoot $installedDir
$upToDate = $state.HasDependency -and $state.DependencySpec -eq $desiredSpec -and
            $state.BundleSelected -and $installedCopyExists -and $mismatches.Count -eq 0

Write-Step 'profile 状态'
Write-Info "dependency：$(if ($state.HasDependency) { $state.DependencySpec } else { '（缺失）' })"
Write-Info "dsh.profile.bundles：$(if ($state.BundleSelected) { '已包含' } else { '（缺失）' })"
Write-Info "安装副本：$(if (-not $installedCopyExists) { '不存在' } elseif ($mismatches.Count -eq 0) { '与仓库 pkg 一致' } else { "落后于仓库 pkg（$($mismatches.Count) 处差异）" })"

if ($upToDate) {
  Write-Step '完成'
  Write-Info '已是最新：profile 安装副本与仓库 pkg 一致，无需更新。'
  if ($dshRunning) {
    Write-Info '提示：若此前只更新了文件而未重载，请在插件管理器 remove → install（或重启 DSH）让运行中的插件使用它。'
  }
  exit 0
}

if ($DryRun) {
  Write-Step '[dry-run] 将执行'
  if ($dshRunning) {
    Write-Info '检测到 DSH 正在运行：真实运行只做报告、不改 profile；随后提示走插件管理器 remove → install，或退出 DSH 后重跑。'
  } else {
    if ($state.HasDependency -or $installedCopyExists) {
      Write-Info "1) pnpm --dir `"$profileDir`" remove $packageName"
    } else {
      Write-Info '1) 跳过 remove（尚未安装）'
    }
    Write-Info "2) pnpm --dir `"$profileDir`" add $desiredSpec"
    if (-not $state.HasDependency -or -not $state.BundleSelected) {
      Write-Info '3) 更新 profile package.json（file: 依赖 + dsh.profile.bundles 选中）'
    } else {
      Write-Info '3) 确认 profile package.json（依赖与 bundles 已就绪）'
    }
    Write-Info '4) 逐文件校验安装副本与仓库 pkg 一致'
    Write-Info '5) 完成（DSH 未运行：下次启动时加载新插件）'
  }
  Write-Info 'dry-run：未写入任何文件。'
  exit 0
}

if ($dshRunning) {
  Write-Step '需要重载，但 DSH 正在运行'
  Write-Info '外部脚本不能在运行中安全地重装该 bundle（loader 会报 package-moved 并停用插件）。'
  Write-Info ''
  Write-Info '请任选一种安全路径：'
  Write-Info '  A) 让 agent 调用 plugin_manager：install_bundle 目标为：'
  Write-Info "       $desiredSpec"
  Write-Info '     （若已装旧版本，可先 remove_bundle 再 install_bundle；live profile 会立即生效）'
  Write-Info '  B) 完全退出 DSH 后重新运行本脚本（脚本会更新 profile，下次启动生效）。'
  throw 'install-script-orchestrator: DSH 正在运行，已停止在安全边界；请按上面的 A 或 B 完成安装/更新。'
}

# ---- 离线安装 / 更新 ---------------------------------------------------------
$snapshot = @{}
foreach ($path in @($manifestPath, $lockPath)) {
  $snapshot[$path] = if (Test-Path -LiteralPath $path) { [System.IO.File]::ReadAllBytes($path) } else { $null }
}

try {
  if ($state.HasDependency -or $installedCopyExists) {
    Write-Step '移除旧安装（pnpm remove）'
    Invoke-PnpmCommand -Arguments @('--dir', $profileDir, 'remove', $packageName) -AllowFailure | Out-Null
  } else {
    Write-Step '跳过 remove（尚未安装）'
  }

  Write-Step '安装到 profile（pnpm add）'
  Invoke-PnpmCommand -Arguments @('--dir', $profileDir, 'add', $desiredSpec) | Out-Null

  $manifest = Read-JsonFile $manifestPath
  if (Update-Manifest $manifest) {
    Write-Step '更新 profile 清单（依赖 spec / dsh.profile.bundles）'
    Write-JsonFile -Path $manifestPath -Value $manifest
    Write-Info '已写回 profile package.json'
  }
} catch {
  foreach ($path in @($manifestPath, $lockPath)) {
    $bytes = $snapshot[$path]
    if ($null -eq $bytes) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    } else {
      [System.IO.File]::WriteAllBytes($path, $bytes)
    }
  }
  Fail "安装失败：$($_.Exception.Message)`n已恢复 profile 清单与锁文件；可重新运行本脚本，或在 DSH 插件管理器（remove → install）中重试。"
}

Write-Step '校验安装副本'
Assert-InstalledCopyMatches -InstalledRoot $installedDir

# ---- 配置提示与总结 ----------------------------------------------------------
Write-Step '配置提示（可选）'
if ((Test-Path -LiteralPath $patchPath) -and
    ([System.IO.File]::ReadAllText($patchPath) -notmatch '(?m)^-\s+id:\s*script-orchestrator\s*$')) {
  Write-Info 'profile patch 中没有 `script-orchestrator` 配置行：插件将以默认配置加载（allowedRoots 不限制路径根，激活时记录一条警告）。'
  Write-Info "如需限制脚本/会话 cwd 或调整执行参数，可在 $patchPath 追加："
  Write-Info '  - id: script-orchestrator'
  Write-Info '    config:'
  Write-Info "      allowedRoots: ['$($repoRoot -replace '\\', '\\')']"
} else {
  Write-Info '未发现可追加的配置需求（或已存在 script-orchestrator 配置行）。'
}

$finalState = Get-ManifestState (Read-JsonFile $manifestPath)
Write-Step '完成'
Write-Info "profile：$profileDir"
Write-Info "dependency：$($finalState.DependencySpec)"
Write-Info "dsh.profile.bundles：$(if ($finalState.BundleSelected) { "已包含 $packageName" } else { '未包含（异常）' })"
Write-Info "安装副本：$installedDir"
Write-Info '下次启动 DSH 时生效；修改代码后重新运行本脚本即可更新（DSH 运行中请走插件管理器 remove → install）。'
