<#
  dsh-qq-kit 一键安装脚本（Windows / PowerShell 5.1+）
  用法：
    powershell -ExecutionPolicy Bypass -File .\install.ps1
  可选参数：
    -Profile desktop        要装进的 DSH profile（默认 desktop）
    -AdminQQ 123456         你的主号 QQ（拥有执行审批权、主动消息接收人）
    -BotQQ 10001            机器人小号 QQ
    -NapCatToken xxx        NapCat HTTP 服务端 token（与 NapCat 配置里一致）
    -DshData D:\DSH-Data    数据根目录（人设、表情、语音模型、日志都放这）
    -NapCatDir D:\NapCat    NapCat 安装目录（用于提示，不写入插件）
    -PushToken xxx          QQ 审批回复的通道 token（随便一串随机字符即可）
    -SkipAdd                只改配置、不执行 dsh plugin add
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$AdminQQ,
  [string]$BotQQ,
  [string]$NapCatToken,
  [string]$DshData,
  [string]$NapCatDir,
  [string]$PushToken,
  [switch]$SkipAdd
)

$ErrorActionPreference = 'Stop'
$kitRoot  = $PSScriptRoot
$pluginsRoot = Join-Path $kitRoot 'plugins'
$dshCmd = 'D:\tools\DeepSeekharness\resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path $dshCmd)) {
  $found = Get-Command dsh -ErrorAction SilentlyContinue
  if ($found) { $dshCmd = $found.Source } else {
    throw "找不到 dsh 命令。请把 DSH 桌面端装在默认位置，或把 dsh 加入 PATH 后重试。"
  }
}

function Ask([string]$label, [string]$default, [string]$current) {
  if ($current) { return $current }
  $hint = if ($default) { "$label [$default]" } else { $label }
  $v = Read-Host $hint
  if ([string]::IsNullOrWhiteSpace($v)) { $v = $default }
  return $v
}

$AdminQQ    = Ask '你的主号 QQ'            '' $AdminQQ
$BotQQ      = Ask '机器人小号 QQ'          '' $BotQQ
$NapCatToken= Ask 'NapCat HTTP token'      '' $NapCatToken
$DshData    = Ask '数据目录'               'D:\DSH-Data' $DshData
$NapCatDir  = Ask 'NapCat 目录（仅提示用）' 'D:\NapCat'   $NapCatDir
if (-not $PushToken) {
  $PushToken = -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
}

if ($AdminQQ -notmatch '^\d{5,12}$') { throw "主号 QQ 格式不对：$AdminQQ" }
if ($BotQQ   -notmatch '^\d{5,12}$') { throw "小号 QQ 格式不对：$BotQQ" }
if ([string]::IsNullOrWhiteSpace($NapCatToken)) {
  Write-Warning '没有填 NapCat token：表情/资料/主动消息会发不出去，之后可在各插件的 cordis.patch.yml 里补。'
}

New-Item -ItemType Directory -Force -Path $DshData | Out-Null
foreach ($sub in @('persona','qq\memes','qq\media','speech\doubao','memory')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DshData $sub) | Out-Null
}

$map = [ordered]@{
  '@ADMIN_QQ@'      = $AdminQQ
  '@BOT_QQ@'        = $BotQQ
  '@NAPCAT_TOKEN@'  = $NapCatToken
  '@PUSH_TOKEN@'    = $PushToken
  '@DSH_DATA@'      = $DshData
  '@NAPCAT_DIR@'    = $NapCatDir
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$touched = 0
Get-ChildItem $pluginsRoot -Recurse -File -Include *.js,*.yml,*.json,*.md | ForEach-Object {
  $text = [IO.File]::ReadAllText($_.FullName)
  $before = $text
  foreach ($k in $map.Keys) { $text = $text.Replace($k, $map[$k]) }
  if ($text -ne $before) {
    [IO.File]::WriteAllText($_.FullName, $text, $utf8)
    $touched++
  }
}
Write-Host "已写入配置占位符：$touched 个文件"

if (-not $SkipAdd) {
  $names = @('dsh-doubao-tts','dsh-qq-meme','dsh-qq-profile','dsh-qq-qzone','dsh-qq-proactive','dsh-qq-exec')
  foreach ($n in $names) {
    $p = Join-Path $pluginsRoot $n
    if (-not (Test-Path $p)) { Write-Warning "跳过不存在的插件目录：$n"; continue }
    Write-Host "安装 $n ..."
    & $dshCmd plugin --profile $Profile add $p
  }
}

Write-Host ''
Write-Host '安装完成。还需要手动做两件事：' -ForegroundColor Green
Write-Host "  1) 人设：把 examples/persona.example.md 复制到 $DshData\persona\，改成你要的样子；"
Write-Host "  2) 豆包语音：把 examples/doubao-settings.example.json 复制到 $DshData\speech\doubao\settings.json，填 appId/accessToken（或 apiKey）。"
Write-Host "然后重启 DSH 桌面端，在 QQ 里给小号发消息即可。" -ForegroundColor Green
