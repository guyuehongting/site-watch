# 卸载 DSH Skill 安装（只动 skills 目录里的那一份，绝不碰本仓库）
#
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DshHome "D:\dsh\harness"
#
# 安全设计：如果目标是目录联接且**不是**指向本仓库，脚本会拒绝删除。

[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:APPDATA 'dsh-desktop\harness')
)

$ErrorActionPreference = 'Stop'
$target = Join-Path (Join-Path $DshHome 'skills') 'site-watch'

if (-not (Test-Path $target)) {
  Write-Host "[site-watch] 没找到安装：$target（无需卸载）"
  exit 0
}

$item = Get-Item $target -Force

if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
  $dest = @($item.Target)[0]
  if ($dest -and $dest.TrimEnd('\') -ne $PSScriptRoot.TrimEnd('\')) {
    throw "拒绝删除：$target 指向 `"$dest`"，不是本仓库（$PSScriptRoot）。请自行确认后手动处理。"
  }
  # 用 rmdir 只摘掉联接本身；PowerShell 的 Remove-Item -Recurse 会穿透联接删源文件
  cmd /c rmdir "$target"
  Write-Host "[site-watch] 已移除联接：$target"
  Write-Host "[site-watch] 源文件仍在 $PSScriptRoot（state/ out/ secrets.env 都保留了）"
  exit 0
}

Write-Host "[site-watch] 这是复制安装，将删除副本：$target"
Write-Host "[site-watch] 注意：其中的 state/ out/ 会一起删除；需要留档请先拷出来。"
Remove-Item -Recurse -Force -LiteralPath $target
Write-Host "[site-watch] 已删除。"
