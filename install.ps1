# 把本仓库安装成一个 DSH Skill
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Copy     # 复制而不是联接
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome "D:\dsh\harness"
#
# 默认用目录联接（junction）：源文件仍在本仓库里，改完即生效，不用重装。

[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:APPDATA 'dsh-desktop\harness'),
  [switch]$Copy
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$skills = Join-Path $DshHome 'skills'
$target = Join-Path $skills 'site-watch'

Write-Host "[site-watch] DSH home : $DshHome"
Write-Host "[site-watch] 源目录    : $source"

if (-not (Test-Path $DshHome)) {
  throw "找不到 DSH home：$DshHome（用 -DshHome 指定，例如 -DshHome `"$HOME\.dsh`"）"
}
if (-not (Test-Path (Join-Path $source 'site-watch.mjs'))) {
  throw "本目录里没有 site-watch.mjs，请在仓库根目录运行本脚本。"
}

New-Item -ItemType Directory -Force -Path $skills | Out-Null

if (Test-Path $target) {
  $item = Get-Item $target -Force
  Write-Host "[site-watch] 目标已存在（$($item.LinkType)）：$target"
  Write-Host "[site-watch] 先跑 uninstall.ps1 再来；如果它已经指向本仓库，那就不用装了。"
  exit 0
}

if ($Copy) {
  Copy-Item -Recurse -Force -Path $source -Destination $target
  Write-Host "[site-watch] 已复制到 $target"
} else {
  cmd /c mklink /J "$target" "$source" | Out-Null
  Write-Host "[site-watch] 已建立目录联接：$target -> $source"
}

# 首次安装顺手生成 secrets.env（不含任何真值）
$secrets = Join-Path $source 'secrets.env'
if (-not (Test-Path $secrets)) {
  Copy-Item (Join-Path $source 'secrets.env.example') $secrets
  Write-Host "[site-watch] 已生成 secrets.env（填了真值也**不会**被 git 跟踪）"
}

Write-Host ""
Write-Host "下一步："
Write-Host "  1) 编辑 $(Join-Path $source 'config.json')，把 sources[].url 换成你的站点"
Write-Host "  2) 需要推送时，在 config.json 里把某个渠道的 enabled 改成 true 并填好参数"
Write-Host "  3) 自测：node `"$(Join-Path $source 'site-watch.mjs')`" --plain"
