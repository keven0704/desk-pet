@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "pack-release.ps1" %*
set RC=%errorlevel%
if not "%RC%"=="0" echo [FAILED] See messages above.
if "%~1"=="" pause
exit /b %RC%
