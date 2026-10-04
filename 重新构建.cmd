@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在重新打包（改动过代码后请运行这个）……
rmdir /s /q .next 2>nul
call npm run build
if errorlevel 1 (
  echo.
  echo   [错误] 打包失败，请检查网络 / Node 版本（需要 22.13 或更高）。
  echo   可以先关掉本窗口，改用「启动.cmd」再试一次；若仍失败，
  echo   请到 https://nodejs.org/ 安装最新 LTS 版本后重试。
  echo.
  pause
  exit /b 1
)
echo.
echo 打包完成。现在双击「启动.cmd」就能正常使用了。
pause