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

rem ---------- 检查 Node 版本：需要 22.13 或更高 ----------
set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2 delims=v." %%a in ('node -v 2^>nul') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if not defined NODE_MAJOR (
  echo.
  echo   [错误] 没有找到 Node.js，或者 Node.js 没装好。
  echo   请打开 https://nodejs.org/ 下载安装 Node.js 22.13 或更高版本（推荐 24 LTS），
  echo   一路点“下一步”装好后，重新双击本文件即可。
  echo.
  pause
  exit /b 1
)
set "NODE_TOO_OLD="
if %NODE_MAJOR% LSS 22 set "NODE_TOO_OLD=1"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 13 set "NODE_TOO_OLD=1"
if defined NODE_TOO_OLD (
  echo.
  echo   [错误] Node.js 版本太低：当前是 v%NODE_MAJOR%.%NODE_MINOR%，需要 22.13 或更高。
  echo   请打开 https://nodejs.org/ 下载安装新的 LTS 版本（推荐 24），
  echo   一路点“下一步”装好后，重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

rem ---------- 访问口令（手机访问用；只存在 data\access-pin.txt，不会被同步/上传）----------
if not exist "data" mkdir data
set "PINFILE=data\access-pin.txt"
set "PIN="
if exist "%PINFILE%" set /p PIN=<"%PINFILE%"
if defined PIN goto :pin_ok
for /f %%i in ('powershell -NoProfile -Command "Get-Random -Minimum 100000 -Maximum 999999"') do set "PIN=%%i"
>"%PINFILE%" echo %PIN%
:pin_ok

rem ---------- 已经在运行：直接显示地址，不再重复启动 ----------
netstat -ano | findstr "LISTENING" | findstr ":3000 " >nul 2>nul
if not errorlevel 1 goto :already_running

if not exist node_modules (
  echo [1/3] 正在安装依赖……第一次运行才会做，需要几分钟
  call npm install
  if errorlevel 1 goto fail
)
if not exist ".next\BUILD_ID" (
  echo [2/3] 正在打包……第一次运行才会做，需要几分钟
  call npm run build
  if errorlevel 1 goto fail
)
echo [3/3] 正在启动服务 ……  http://localhost:3000
call :showurl
echo   本窗口可以最小化，但请不要关闭（关掉窗口 = 服务停止）。
echo   稍等几秒，服务就绪后会自动帮你打开浏览器。
set NEXT_TELEMETRY_DISABLED=1
set ACCESS_PIN=%PIN%
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ try{ (New-Object Net.Sockets.TcpClient('127.0.0.1',3000)).Close(); Start-Process 'http://localhost:3000/?pin=%PIN%'; break }catch{ Start-Sleep -Milliseconds 500 } }"
call npm run start:lan
echo.
echo 服务已停止。关闭窗口即可，也可以按任意键退出。
pause
exit /b 0

:already_running
echo.
echo   服务已经在运行中（不用再启动一次）。手机访问地址：
call :showurl
echo   提示：想重启服务，请先关掉那个正在运行的窗口，再双击本文件。
echo.
pause
exit /b 0

:showurl
powershell -NoProfile -Command "$ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|172\.|198\.18\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|VPN|aTrust|Loopback|Meta' }); if ($ips.Count -eq 0) { $ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|172\.|198\.18\.)' }) }; Write-Host ''; Write-Host '  ── 手机访问（手机和电脑连同一个 Wi-Fi/WLAN 时打开）──' -ForegroundColor Cyan; foreach ($ip in $ips) { Write-Host ('    http://' + $ip.IPAddress + ':3000/?pin=%PIN%') -ForegroundColor Yellow }; Write-Host '  （第一次带 ?pin=... 打开；之后手机直接访问 http://<上面的IP>:3000 即可）' -ForegroundColor DarkGray"
exit /b 0

:fail
echo.
echo   [错误] 启动失败，请检查网络和 Node.js 版本（需要 22.13 或更高）。
echo   可以关掉本窗口，改用「重新构建.cmd」重新打包后再双击本文件；
echo   若仍失败，请到 https://nodejs.org/ 安装最新 LTS 版本。
echo.
pause
exit /b 1
