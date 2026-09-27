# Publish this project to GitHub over the REST API - no git installation needed.
#
#   powershell -ExecutionPolicy Bypass -File tools\publish-github.ps1
#   powershell -ExecutionPolicy Bypass -File tools\publish-github.ps1 -Owner me -Repo ds-voter-loop -Public
#   powershell -ExecutionPolicy Bypass -File tools\publish-github.ps1 -ReleaseZip C:\path\to\ds-voter-loop-portable.zip
#
# The token is read with a hidden prompt and never written to disk.
# Needed scope: classic "repo", or fine-grained "Contents: Read and write" (+ "Administration: write" to create the repo).
# Saved as UTF-8 WITH BOM on purpose (PowerShell 5.1 reads BOM-less .ps1 as ANSI/GBK).

[CmdletBinding()]
param(
  [string]$Owner = '',
  [string]$Repo  = 'ds-voter-loop',
  [string]$Token = '',
  [string]$SourceDir = '',
  [string]$ReleaseZip = "$env:USERPROFILE\ds-voter-loop-portable.zip",
  [switch]$Public,
  [switch]$DryRun,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
  $SourceDir = Split-Path -Parent $scriptDir
}
$SourceDir = (Resolve-Path $SourceDir).Path

$Api = 'https://api.github.com'
$Ua  = 'ds-voter-loop-publisher'

function Api-Call {
  param([string]$Method, [string]$Path, $Body, [string]$ContentType = 'application/json')
  $headers = @{ 'User-Agent' = $Ua; 'Accept' = 'application/vnd.github+json' }
  if ($Token) { $headers['Authorization'] = "token $Token" }
  $req = @{ Method = $Method; Uri = "$Api$Path"; Headers = $headers; ContentType = $ContentType }
  if ($null -ne $Body) { $req['Body'] = $Body }
  try {
    return Invoke-RestMethod @req
  } catch {
    $resp = $_.Exception.Response
    $code = if ($resp) { [int]$resp.StatusCode } else { 0 }
    $text = ''
    try { $text = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { }
    return [pscustomobject]@{ __error = $true; status = $code; body = $text }
  }
}

# ---------- 1) 收集要上传的文件 ----------
$skipPatterns = @('\\runtime\\', '\\node_modules\\', '\\\.git\\', '\.zip$', '\.jpg$', '\.jpeg$', '\.lnk$', '\\_pack\\')
function Should-Skip([string]$rel) {
  foreach ($p in $skipPatterns) { if ($rel -match $p) { return $true } }
  return $false
}

$rootFiles = @('start.cmd', 'server.mjs', 'README.md', 'LICENSE', 'manifest.json', 'icon.ico', 'icon.png', '.gitignore')
$dirs = @('lib', 'public', 'tools')

$list = @()
foreach ($f in $rootFiles) {
  $full = Join-Path $SourceDir $f
  if (Test-Path $full) { $list += [pscustomobject]@{ rel = $f; full = $full } }
}
foreach ($d in $dirs) {
  $full = Join-Path $SourceDir $d
  if (-not (Test-Path $full)) { continue }
  foreach ($item in Get-ChildItem $full -Recurse -File) {
    $rel = $item.FullName.Substring($SourceDir.Length + 1).Replace('\', '/')
    if (Should-Skip $rel) { continue }
    $list += [pscustomobject]@{ rel = $rel; full = $item.FullName }
  }
}
$list = $list | Sort-Object rel
Write-Host "[publish] 待上传 $($list.Count) 个文件："
foreach ($x in $list) { Write-Host ("           {0,-42} {1,8:N1} KB" -f $x.rel, ((Get-Item $x.full).Length / 1KB)) }

if ($DryRun) { Write-Host '[publish] -DryRun：只列清单，不上传，也不需要 token。'; return }

# ---------- 1.5) 自检：不需要 token，只验证网络与错误处理 ----------
if ($SelfTest) {
  Write-Host '[publish] 自检（不需要 token）：'
  $ping = Api-Call GET '/'
  if ($ping.__error) { Write-Host "  ❌ 连不上 api.github.com（HTTP $($ping.status)）—— 检查网络或代理" }
  else { Write-Host '  ✅ 能连上 api.github.com' }

  $anon = Api-Call GET '/repos/this-repo-should-not-exist-9f3a/this-repo-should-not-exist-9f3a'
  Write-Host "  ✅ HTTP 错误能被正确捕获（HTTP $($anon.status)）"

  $noauth = Api-Call GET '/user'
  Write-Host "  ✅ 未授权请求能被识别（HTTP $($noauth.status)，401/403 属正常）"

  if (Test-Path $ReleaseZip) {
    Write-Host ("  ✅ 便携包就位：{0}  ({1:N1} MB)" -f $ReleaseZip, ((Get-Item $ReleaseZip).Length / 1MB))
  } else {
    Write-Host "  ⚠️ 没找到便携包：$ReleaseZip （那就只传源码，不建 Release 附件）"
  }
  Write-Host '[publish] 自检完成。没问题就去掉 -SelfTest 再跑一次（那次会要 token）。'
  return
}

# ---------- 2) token ----------
if (-not $Token) {
  $sec = Read-Host '请粘贴 GitHub Personal Access Token（输入时不显示）' -AsSecureString
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
$Token = $Token.Trim()   # 粘贴常带空格/换行，先清掉，否则会 401
if ([string]::IsNullOrWhiteSpace($Token)) { throw '没有 token，退出。' }

$me = Api-Call GET '/user'
if ($me.__error) {
  throw ("token 校验失败（HTTP $($me.status)）。`n" +
         "  · 401 = token 不对/已过期/复制时少了字符；`n" +
         "  · 403 = token 权限不够（经典 token 要勾 repo）；`n" +
         "  重新生成一个再跑一次本脚本即可。返回内容：$($me.body)")
}
if (-not $Owner) { $Owner = $me.login }
Write-Host "[publish] 账号: $($me.login)   仓库: $Owner/$Repo"

# ---------- 3) 建仓库（已存在就沿用）----------
$create = Api-Call POST '/user/repos' (@{ name = $Repo; private = (-not $Public); description = 'ds-vs-ds vote loop (own site only)'; has_issues = $true; has_wiki = $false } | ConvertTo-Json)
if ($create.__error) {
  if ($create.status -eq 422) { Write-Host '[publish] 仓库已存在，直接往里传。' }
  elseif ($create.status -eq 403 -or $create.status -eq 404) {
    throw ("建仓库失败（HTTP $($create.status)）：这个 token 没有「新建仓库」的权限。`n" +
           "  办法一：用经典 token（classic），勾选 repo 权限；`n" +
           "  办法二：先去 https://github.com/new 手动建一个叫 $Repo 的公开仓库，再重跑本脚本（已存在的仓库会自动沿用）。")
  }
  else { throw "建仓库失败（HTTP $($create.status)）：$($create.body)" }
} else {
  Write-Host "[publish] 已创建仓库：$($create.html_url)  （$(if ($Public) { '公开' } else { '私有' })）"
}

# ---------- 4) 逐个文件上传 ----------
$ok = 0; $fail = 0
foreach ($x in $list) {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($x.full))
  $existing = Api-Call GET "/repos/$Owner/$Repo/contents/$($x.rel)"
  $body = @{ message = "Add $($x.rel)"; content = $b64 }
  if (-not $existing.__error -and $existing.sha) { $body['sha'] = $existing.sha; $body['message'] = "Update $($x.rel)" }
  $res = Api-Call PUT "/repos/$Owner/$Repo/contents/$($x.rel)" ($body | ConvertTo-Json)
  if ($res.__error) {
    Write-Host ("           ✗ {0}  HTTP {1} {2}" -f $x.rel, $res.status, ($res.body -replace '\s+', ' ').Substring(0, [Math]::Min(160, $res.body.Length)))
    $fail++
  } else {
    Write-Host ("           ✓ {0}" -f $x.rel)
    $ok++
  }
}
Write-Host "[publish] 上传完成：成功 $ok 个，失败 $fail 个"
Write-Host "[publish] 仓库地址：https://github.com/$Owner/$Repo"

# ---------- 5) 可选：把便携包作为 Release 附件 ----------
if ($ReleaseZip -and (Test-Path $ReleaseZip)) {
  $tag = 'v' + (Get-Date -Format 'yyyy.MM.dd')
  $rel = Api-Call POST "/repos/$Owner/$Repo/releases" (@{ tag_name = $tag; name = "ds-voter-loop $tag"; body = '源码包见仓库；这里是含 Node 运行时的便携包（解压双击 start.cmd 即可）。'; draft = $false } | ConvertTo-Json)
  if ($rel.__error) { Write-Warning "建 Release 失败（HTTP $($rel.status)）：$($rel.body)" }
  else {
    $name = Split-Path $ReleaseZip -Leaf
    $uploadUrl = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($rel.id)/assets?name=$name"
    $headers = @{ 'User-Agent' = $Ua; 'Authorization' = "token $Token"; 'Content-Type' = 'application/zip' }
    try {
      Invoke-RestMethod -Method POST -Uri $uploadUrl -Headers $headers -InFile $ReleaseZip | Out-Null
      Write-Host "[publish] 便携包已作为 Release 附件上传：$tag"
    } catch { Write-Warning "上传附件失败：$($_.Exception.Message)" }
  }
}

Write-Host '[publish] 别忘了用完去 GitHub 撤销这个 token： https://github.com/settings/tokens'
