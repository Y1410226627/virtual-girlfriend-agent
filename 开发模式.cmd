@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [38;5;175m============================================[0m
echo [38;5;204m　　∧＿＿∧[0m
echo [38;5;204m　（　＾ω＾　）[0m
echo [38;5;204m　　＼＿＿／[0m
echo.
echo   [38;5;204m她 · 虚拟女友[0m    [38;5;245mVirtual Girlfriend Agent  (dev mode)[0m
echo   [38;5;245mUse this one if you changed the code.[0m
echo [38;5;175m============================================[0m
if not exist node_modules (
  echo [1/2] 正在安装依赖……第一次运行才会做，需要几分钟
  call npm install
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败，请检查网络 / Node 版本（需要 22.13 或更高）。
    echo   可以先关掉本窗口，改用「启动.cmd」再试一次；若仍失败，
    echo   请到 https://nodejs.org/ 安装最新 LTS 版本后重试。
    echo.
    pause
    exit /b 1
  )
)
echo 正在启动开发服务 ……  http://localhost:3000
start "" http://localhost:3000
call npm run dev
pause
