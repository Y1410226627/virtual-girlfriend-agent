@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [38;5;175m============================================[0m
echo [38;5;204m　　∧＿＿∧[0m
echo [38;5;204m　（　＾ω＾　）[0m
echo [38;5;204m　　＼＿＿／[0m
echo.
echo   [38;5;204m她 · 虚拟女友[0m    [38;5;245mVirtual Girlfriend Agent  (fast mode)[0m
echo [38;5;175m============================================[0m
if not exist node_modules (
  echo [1/3] Installing dependencies ... first run only
  call npm install
  if errorlevel 1 goto fail
)
if not exist ".next\BUILD_ID" (
  echo [2/3] Building optimized bundle ... first run only, takes a while
  call npm run build
  if errorlevel 1 goto fail
)
echo [3/3] Starting server ...  http://localhost:3000
start "" http://localhost:3000
call npm start
pause
exit /b 0

:fail
echo.
echo Something failed. Please check Node.js / network, then retry.
pause
exit /b 1