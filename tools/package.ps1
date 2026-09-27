# Rebuild the release copy, both zip packages, and the desktop shortcut.
# Usage:  powershell -ExecutionPolicy Bypass -File tools\package.ps1
#         powershell -ExecutionPolicy Bypass -File tools\package.ps1 -NoShortcut -NoRuntime
# Saved as UTF-8 WITH BOM on purpose: PowerShell 5.1 reads BOM-less .ps1 as ANSI/GBK,
# which breaks the non-ASCII shortcut name. Keep the BOM if you edit this file.

[CmdletBinding()]
param(
  [string]$SourceDir   = '',
  [string]$ReleaseDir  = "$env:USERPROFILE\ds-voter-loop",
  [string]$ZipDir      = "$env:USERPROFILE",
  [string]$RuntimeNode = "D:\DSH\DeepSeek Harness\Open DeepSeek Harness Desktop\resources\runtime\win32-x64\node.exe",
  [string]$ShortcutName = 'ds投票循环器',
  [switch]$NoRuntime,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SourceDir)) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
  $SourceDir = Split-Path -Parent $scriptDir
}
$SourceDir = (Resolve-Path $SourceDir).Path
Write-Host "[package] source : $SourceDir"
Write-Host "[package] release: $ReleaseDir"

$files = @('start.cmd', 'publish-to-github.cmd', 'server.mjs', 'README.md', 'LICENSE', '.gitignore', 'icon.ico', 'icon.png', 'manifest.json')
$dirs  = @('lib', 'public', 'tools')

# 0) 重新封存完整性清单（必须在拷贝之前，保证发布副本和清单对得上）
Write-Host '[package] sealing manifest.json ...'
& node (Join-Path $SourceDir 'tools\make-manifest.mjs')
if ($LASTEXITCODE -ne 0) { throw "make-manifest.mjs failed with exit code $LASTEXITCODE" }

function Copy-App {
  param([string]$Target, [switch]$WithRuntime)
  # Sync instead of wipe: the app may be running from $Target, and Windows locks a
  # running node.exe, so deleting the whole folder fails with "access denied".
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  foreach ($d in $dirs) { New-Item -ItemType Directory -Path (Join-Path $Target $d) -Force | Out-Null }
  foreach ($f in $files) { Copy-Item (Join-Path $SourceDir $f) (Join-Path $Target $f) -Force }
  foreach ($d in $dirs) { Copy-Item (Join-Path $SourceDir "$d\*") (Join-Path $Target $d) -Force }
  if ($WithRuntime) {
    $rt = Join-Path $Target 'runtime'
    New-Item -ItemType Directory -Path $rt -Force | Out-Null
    $dest = Join-Path $rt 'node.exe'
    if (Test-Path $dest) {
      Write-Host '[package] node runtime already present (kept)'
    } elseif (Test-Path $RuntimeNode) {
      Copy-Item $RuntimeNode $dest -Force
      Write-Host ("[package] bundled node runtime: {0:N1} MB" -f ((Get-Item $RuntimeNode).Length / 1MB))
    } else {
      Write-Warning "[package] no node runtime at $RuntimeNode (shortcut will need a system Node)"
    }
  }
}

# 1) release copy (with runtime so the shortcut works without a system Node)
Copy-App -Target $ReleaseDir -WithRuntime:(-not $NoRuntime)

# 2) source-only zip (small)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("dsvoter-pack-" + [guid]::NewGuid().ToString('N'))
Copy-App -Target (Join-Path $tmp 'ds-voter-loop')
$zipSmall = Join-Path $ZipDir 'ds-voter-loop.zip'
if (Test-Path $zipSmall) { Remove-Item $zipSmall -Force }
Compress-Archive -Path (Join-Path $tmp 'ds-voter-loop') -DestinationPath $zipSmall -CompressionLevel Optimal
Remove-Item $tmp -Recurse -Force
Write-Host ("[package] source zip : {0}  ({1:N1} KB)" -f $zipSmall, ((Get-Item $zipSmall).Length / 1KB))

# 3) portable zip (with bundled node)
if (-not $NoRuntime) {
  $zipFull = Join-Path $ZipDir 'ds-voter-loop-portable.zip'
  if (Test-Path $zipFull) { Remove-Item $zipFull -Force }
  Compress-Archive -Path $ReleaseDir -DestinationPath $zipFull -CompressionLevel Optimal
  Write-Host ("[package] portable zip: {0}  ({1:N1} MB)" -f $zipFull, ((Get-Item $zipFull).Length / 1MB))
}

# 4) desktop shortcut (Unicode name is fine: WScript.Shell writes UTF-16)
if (-not $NoShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnkPath = Join-Path $desktop "$ShortcutName.lnk"
  if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force }
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = Join-Path $ReleaseDir 'start.cmd'
  $lnk.WorkingDirectory = $ReleaseDir
  $lnk.IconLocation = Join-Path $ReleaseDir 'icon.ico'
  $lnk.Description = 'ds-vs-ds vote loop: clear key -> reload -> wait new UUID -> click right -> repeat'
  $lnk.Save()
  Write-Host "[package] shortcut   : $lnkPath"
}

Write-Host '[package] done.'
