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
if not exist node_modules call npm install
echo Starting dev server ...  http://localhost:3000
start "" http://localhost:3000
call npm run dev
pause