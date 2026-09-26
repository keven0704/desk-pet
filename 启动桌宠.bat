@echo off
cd /d "%~dp0"

rem 优先用项目自带的 Electron（不需要装 Node.js）
if exist "node_modules\electron\dist\electron.exe" goto run_bundled

rem 没带 Electron：需要 Node.js + npm install
where node >nul 2>nul
if errorlevel 1 goto no_node

echo 首次运行：正在安装依赖（会下载 Electron，约 1-2 分钟）...
call npm install
if errorlevel 1 goto npm_fail
goto run_bundled

:run_bundled
echo 正在启动噜噜桌宠...
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:no_node
echo [缺少依赖] 没找到 node_modules\electron，也没装 Node.js。
echo 请任选其一：
echo   1) 安装 Node.js（https://nodejs.org）后在本目录执行： npm install
echo   2) 换用包含 node_modules 的完整文件夹再运行
pause
exit /b 1

:npm_fail
echo npm install 失败，请检查网络后重试。
pause
exit /b 1