@echo off
cd /d "%~dp0"

echo ============================================
echo  编译后端为独立 exe（别人机器上就不用装 Python）
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 goto no_python

python -c "import PyInstaller" >nul 2>nul
if not errorlevel 1 goto build

echo 首次打包：正在安装 PyInstaller（需要联网）...
python -m pip install pyinstaller
if errorlevel 1 goto pip_fail

:build
echo 正在编译，大约 1-2 分钟，请耐心等待...
cd backend
python -m PyInstaller --noconfirm --onefile --name deskpet-backend --distpath . --workpath build --specpath build --collect-all uvicorn --collect-all websockets --collect-all httpx --collect-all certifi --hidden-import uvicorn.protocols.websockets.websockets_impl main.py
if errorlevel 1 goto build_fail
cd ..

echo.
echo 打包完成： backend\deskpet-backend.exe
echo 之后双击 启动桌宠.bat 就会用这个 exe 启动后端，不再依赖 Python。
if "%~1"=="" pause
exit /b 0

:no_python
echo [失败] 没找到 Python。编译后端 exe 需要在“你的”电脑上装 Python 3.9+。
echo        别人的电脑不需要 Python——只要把编译好的 exe 一起打包过去即可。
if "%~1"=="" pause
exit /b 1

:pip_fail
echo [失败] PyInstaller 安装失败，请检查网络后重试。
if "%~1"=="" pause
exit /b 1

:build_fail
echo [失败] 编译出错，请看上面的错误信息。
if "%~1"=="" pause
exit /b 1
