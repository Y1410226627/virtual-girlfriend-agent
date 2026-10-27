@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
set "MODEL=qwen3-embedding:0.6b"
echo ============================================
echo   本地向量服务（Ollama + %MODEL%）
echo   免费、不限量、数据不出本机
echo ============================================
if not exist "%OLLAMA%" (
  echo.
  echo [!] 还没安装 Ollama。请先安装：https://ollama.com/download
  echo     安装后重新双击本文件即可。
  pause
  exit /b 1
)

rem 服务没在跑 → 拉起托盘程序（已在运行则跳过）
powershell -NoProfile -Command "try{ (Invoke-WebRequest 'http://127.0.0.1:11434/api/version' -UseBasicParsing -TimeoutSec 2).StatusCode ^| Out-Null; exit 0 }catch{ exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo 正在启动 Ollama……
  start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
  timeout /t 5 >nul
)

rem 模型不在 → 首次下载（约 640MB）
"%OLLAMA%" show %MODEL% >nul 2>nul
if errorlevel 1 (
  echo 首次使用需要下载模型（约 640MB），请稍等……
  "%OLLAMA%" pull %MODEL%
)

echo.
echo 服务已就绪。把下面两项填到应用的「设置 → 模型与接口」：
echo   向量接口地址：http://127.0.0.1:11434/v1
echo   向量模型：    %MODEL%
echo   填完点一次「重算全部记忆向量」即可生效。
echo.
"%OLLAMA%" list
echo.
echo 提示：本窗口可以关闭；Ollama 会在后台常驻并在开机时自启。
pause
