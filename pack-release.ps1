# ============================================================
#  一键打包给朋友：生成 release\desk-pet 文件夹 + release\desk-pet.zip
#  由 打包给别人.bat 调用；对方解压后双击 启动桌宠.bat 即可用，不需要 Python
#  用 PowerShell 写（而不是纯 bat）：中文文件名/输出不受控制台代码页影响
#
#  同步策略：根目录 + backend/ + assets/ 一律"黑名单"式复制——除 $skipName/
#  $skipPattern 明确排除的以外（.env、日志、中间产物…），这些目录里的文件全部
#  进包；子目录只同步 backend/ 和 assets/，node_modules 由第 4 步单独复制。
#  以前是写死的白名单，源码里新增 build-backend.bat、新回归测试就会漏
#  （release 里没有、README 里却写着），现在新加的文件自动跟着进包，不用再改脚本。
# ============================================================
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
Set-Location -LiteralPath $PSScriptRoot

$ReleaseDir = 'release\desk-pet'
$ZipPath = 'release\desk-pet.zip'

# 不进包的文件：本机配置、VCS 文件、npm 锁文件（node_modules 是整包带的，用不上它）
$skipName = @('.gitignore', '.gitattributes', 'package-lock.json', 'desktop.ini', 'Thumbs.db', '.DS_Store')
# 不进包的文件名规则：密钥、日志、压缩包、PyInstaller 中间产物、备份
$skipPattern = '^(\.env.*|.*\.log|.*\.zip|.*\.spec|.*\.pyc|.*\.bak|.*\.tmp)$'

function Step($n, $msg) { Write-Host "[$n/5] $msg" }
function Fail($msg) { Write-Host "[失败] $msg" -ForegroundColor Red; exit 1 }

Write-Host '=================================================='
Write-Host ' 一键打包给朋友：生成 release\desk-pet 文件夹 + zip'
Write-Host ' 打包后对方双击 启动桌宠.bat 就能用，不需要装 Python'
Write-Host '=================================================='

# ---------- 1. 后端 exe ----------
$backendExe = 'backend\deskpet-backend.exe'
if (-not (Test-Path -LiteralPath $backendExe)) {
    Step 1 '还没编译后端 exe，先自动编译（约 1-2 分钟）...'
    & cmd /c 'build-backend.bat quiet'
}
if (-not (Test-Path -LiteralPath $backendExe)) { Fail '后端 exe 没编译成功，先单独双击 build-backend.bat 看报错' }
Step 1 '后端 exe 就绪'

# ---------- 2. 准备目录（顺便判断能不能复用上次的 Electron 运行时） ----------
# package.json 没动过 = node_modules 还是同一套，就不用再复制 250MB（省几分钟）
$reuseModules = $false
if ((Test-Path -LiteralPath "$ReleaseDir\node_modules\electron\dist\electron.exe") -and
    (Test-Path -LiteralPath "$ReleaseDir\package.json") -and
    ((Get-FileHash -LiteralPath 'package.json').Hash -eq (Get-FileHash -LiteralPath "$ReleaseDir\package.json").Hash)) {
    $reuseModules = $true
}
Step 2 "准备 $ReleaseDir ..."
if (Test-Path -LiteralPath $ReleaseDir) {
    if ($reuseModules) {
        # 复用运行时：只清掉上次打包的其它文件，node_modules 留着
        Get-ChildItem -LiteralPath $ReleaseDir -Force | Where-Object { $_.Name -ne 'node_modules' } |
            Remove-Item -Recurse -Force
    } else {
        Remove-Item -LiteralPath $ReleaseDir -Recurse -Force
    }
}
New-Item -ItemType Directory -Path "$ReleaseDir\backend" -Force | Out-Null
New-Item -ItemType Directory -Path "$ReleaseDir\assets" -Force | Out-Null

# ---------- 3. 复制运行需要的文件（根目录 + backend/ + assets/ 全同步，只排除 .env 之类的本机文件） ----------
# 同一个黑名单规则套在所有要同步的目录上：新加的文件自动进包，只有密钥/日志/中间产物不带
function Sync-Files($srcDir, $dstDir) {
    $n = 0
    foreach ($item in Get-ChildItem -LiteralPath $srcDir -Force) {
        if ($item.PSIsContainer) { continue }     # 子目录（build/__pycache__ 等）一律不进包
        if ($skipName -contains $item.Name) { continue }
        if ($item.Name -match $skipPattern) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $dstDir -Force
        $n++
    }
    return $n
}

Step 3 '复制程序文件（根目录/backend/assets 同步，不含 .env）...'
$copiedRoot = Sync-Files '.' $ReleaseDir
$copiedBackend = Sync-Files 'backend' "$ReleaseDir\backend"
$copiedAssets = Sync-Files 'assets' "$ReleaseDir\assets"
Write-Host "  （根目录 $copiedRoot 个 + backend $copiedBackend 个 + assets $copiedAssets 个）"

# 关键文件自检：宁可报错也不要产出"看起来成功其实是空包"
# （这里的清单 = 对方一定要有的东西 + README 目录结构里写着的脚本，源码里少一个就直接报错）
$must = @('main.js', 'preload.js', 'bubble.html', 'pet.html', 'pet.js',
          'overlay.html', 'overlay.js', 'chat.html', 'chat.js',
          'settings.html', 'settings.js', 'voice-utils.js', 'package.json',
          '启动桌宠.bat', 'build-backend.bat', '打包给别人.bat', 'pack-release.ps1',
          'README.md', 'requirements.txt',
          'assets\pet.png', 'backend\deskpet-backend.exe', 'backend\main.py')
foreach ($m in $must) {
    if (-not (Test-Path -LiteralPath "$ReleaseDir\$m")) { Fail "打包不完整，缺少：$m" }
}
# 密钥红线：包里任何位置都不许出现 .env，否则等于把你的 API Key 一起送出去
$leak = @(Get-ChildItem -LiteralPath $ReleaseDir -Recurse -Force -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -like '*.env' })
if ($leak.Count -gt 0) { Fail "打包里出现了 $($leak[0].Name)（会泄露你的 API Key），已中止" }

# ---------- 4. Electron 运行时 ----------
if ($reuseModules) {
    Step 4 '复用上次复制好的 Electron 运行时（package.json 没变，跳过 250MB 复制）'
} else {
    Step 4 '复制 Electron 运行时 node_modules（约 250MB，需要几分钟）...'
    $rc = Start-Process robocopy -ArgumentList @('node_modules', "$ReleaseDir\node_modules", '/e', '/nfl', '/ndl', '/njh', '/njs', '/np') -Wait -PassThru -NoNewWindow
    if ($rc.ExitCode -ge 8) { Fail "复制 node_modules 失败（robocopy 代码 $($rc.ExitCode)）" }
}
if (-not (Test-Path -LiteralPath "$ReleaseDir\node_modules\electron\dist\electron.exe")) {
    Fail 'node_modules 不完整（缺少 electron.exe）'
}

# ---------- 给对方的使用说明 ----------
$readme = @'
双击 启动桌宠.bat 即可运行，不需要安装 Python / Node.js。

1) 双击 启动桌宠.bat（桌宠会出现在桌面上，可以拖到任意位置）
2) 右键桌宠 - API 设置，填入你自己的 API Key（不填也能跑，是演示模式）
3) 建议：视觉选 智谱 glm-4v-flash（免费）；语音识别选 硅基流动 SenseVoiceSmall（免费）
4) 用法：点一下噜噜 = 截屏圈题；说「噜噜，这个题怎么做」= 自动框选并把问题填进补充描述
5) 想聊天：右键桌宠 -「和噜噜聊天…」，可以聊心情、天气（在 API 设置里填一下城市就能查实时天气）
6) 想折腾源码：改过 backend\main.py 后双击 build-backend.bat 重新编译 exe，
   想重新打一份整包就双击 打包给别人.bat（这两步要装 Python，只想用的话不用管）
7) 更多说明见 README.md
'@
Set-Content -LiteralPath "$ReleaseDir\第一次使用请看这里.txt" -Value $readme -Encoding UTF8

# ---------- 5. 压缩 ----------
Step 5 '压缩成 release\desk-pet.zip（150-200MB，需要几分钟）...'
if (Test-Path -LiteralPath $ZipPath) {
    try {
        Remove-Item -LiteralPath $ZipPath -Force -ErrorAction Stop
    } catch {
        # 资源管理器里预览着、或杀软正在扫描，都会锁住文件
        Fail "$ZipPath 被其它程序占用（资源管理器预览 / 杀软扫描中）：关掉后重试。文件夹已经生成好了：$ReleaseDir"
    }
}
$zipped = $false
# 优先用 Python 的 shutil.make_archive：生成标准 zip（条目用正斜杠），
# 各种解压工具（资源管理器/7-Zip/macOS）都能正确识别中文名与目录结构。
# 注：PowerShell 5.1 的 Compress-Archive/CreateFromDirectory 会用反斜杠当条目名，
# 在非 Windows 的解压工具里会解出一堆怪名，所以只当兜底。
if (Get-Command python -ErrorAction SilentlyContinue) {
    & python -c "import shutil;shutil.make_archive('release/desk-pet','zip',root_dir='release',base_dir='desk-pet')"
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $ZipPath)) { $zipped = $true }
}
if (-not $zipped) {
    Write-Host '  （没找到 Python，改用 PowerShell 压缩，功能一样只是条目名用反斜杠）'
    $ProgressPreference = 'SilentlyContinue'
    [IO.Compression.ZipFile]::CreateFromDirectory(
        (Resolve-Path -LiteralPath $ReleaseDir).Path,
        (Join-Path (Resolve-Path -LiteralPath 'release').Path 'desk-pet.zip'),
        [IO.Compression.CompressionLevel]::Optimal, $true)
}
if (-not (Test-Path -LiteralPath $ZipPath)) { Fail '压缩失败' }

# 校验压缩包真的能用：条目数、关键文件、不含 .env（条目名可能用 / 或 \，两种都认）
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ZipPath).Path)
$names = @($zip.Entries | ForEach-Object { $_.FullName })
$zip.Dispose()
$entryCount = $names.Count
if ($entryCount -lt 50) { Fail "压缩包内容异常（只有 $entryCount 个条目）" }
if ($names | Where-Object { $_ -match '\.env$' }) { Fail '压缩包里含 .env，已中止（会泄露 API Key）' }
foreach ($need in @('backend[\\/]deskpet-backend\.exe$', '启动桌宠\.bat$', 'build-backend\.bat$',
                    'node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$', 'main\.js$', 'README\.md$')) {
    if (-not ($names | Where-Object { $_ -match $need })) { Fail "压缩包里缺少关键文件（匹配规则：$need）" }
}
$sepStyle = if ($names | Where-Object { $_ -like '*/*' }) { '正斜杠（标准）' } else { '反斜杠' }

$zipMB = [math]::Round((Get-Item -LiteralPath $ZipPath).Length / 1MB)
$dirFiles = @(Get-ChildItem -LiteralPath $ReleaseDir -Recurse -File)
$dirMB = [math]::Round(($dirFiles | Measure-Object Length -Sum).Sum / 1MB)
Write-Host ''
Write-Host '=================================================='
Write-Host ' 打包完成！'
Write-Host "   文件夹： $ReleaseDir （$dirMB MB，$($dirFiles.Count) 个文件，已与源码同步：根目录 + backend + assets）"
Write-Host "   压缩包： $ZipPath （$zipMB MB，$entryCount 个条目，条目名用$sepStyle）"
Write-Host '   把这个 zip 发给朋友即可'
Write-Host ' 朋友拿到后：解压 - 双击 启动桌宠.bat - 在 API 设置里填自己的 Key'
Write-Host '=================================================='
exit 0
