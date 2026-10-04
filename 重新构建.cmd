@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Rebuilding after code changes ...
rmdir /s /q .next 2>nul
call npm run build
echo.
echo Done. Now use 启动.cmd as usual.
pause