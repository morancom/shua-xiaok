@echo off
chcp 936 >nul
title 刷小课 - 一键启动(自动加载扩展)
color 0B
setlocal enabledelayedexpansion
echo.
echo   ==========================================
echo     刷小课  -  自动加载扩展并启动
echo   ==========================================
echo.
echo   本方式会先关闭 Edge,再带着扩展重新启动。
echo   若只想打开浏览器后再点扩展图标,请用「启动.bat」。
echo.
rem ---------- 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] 没有找到 Node.js
  echo       请先安装 LTS 版本: https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo   [OK] Node.js %%v
rem ---------- 定位项目目录 ----------
set "ROOT=%~dp0"
if not exist "%ROOT%extension\manifest.json" (
  echo   [X] 没有找到 extension\manifest.json,请确认解压完整。
  pause
  exit /b 1
)
if not exist "%ROOT%server\server.js" (
  echo   [X] 没有找到 server\server.js,请确认解压完整。
  pause
  exit /b 1
)
rem ---------- 启动本地后端 ----------
set "PORT=3001"
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   [OK] 后端已在运行  ^(端口 %PORT%^)
  goto :backend_ready
)
echo   [*] 启动本地后端 ...
start "刷小课后端" /min cmd /c node "%ROOT%server\server.js"

rem 等后端真正可用(最多 12 秒),不要盲等 3 秒就宣布成功
set "WAITN=0"
:wait_backend
timeout /t 1 /nobreak >nul
set /a WAITN+=1
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%PORT%/api/health).StatusCode|Out-Null;exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto :backend_ok
if %WAITN% lss 12 goto :wait_backend

rem 12 秒还没起来 —— 把 server.log 的最后几行打出来,方便定位
echo.
echo   [X] 后端没有启动成功
if exist "%ROOT%server\server.log" (
  echo   ---------- server\server.log ^(最近 8 行^) ----------
  powershell -NoProfile -Command "Get-Content -Tail 8 -Path '%ROOT%server\server.log'" 2>nul
  echo   ----------------------------------------------------
)
echo   常见原因:端口 %PORT% 被别的程序占用,或 Node.js 版本过低。
echo.
pause
exit /b 1

:backend_ok
echo   [OK] 后端已启动  ^(http://127.0.0.1:%PORT%^)
:backend_ready

rem ---------- 重启 Edge 并加载扩展 ----------
echo.
echo   [*] 先正常关闭 Edge(会保留标签页,下次自动恢复)...
taskkill /im msedge.exe >nul 2>nul
timeout /t 3 /nobreak >nul
tasklist /fi "imagename eq msedge.exe" 2>nul | find /i "msedge.exe" >nul
if not errorlevel 1 (
  echo   [*] 仍在运行,强制关闭 ...
  taskkill /im msedge.exe /f >nul 2>nul
  timeout /t 2 /nobreak >nul
)
echo   [*] 带扩展启动 Edge(自动恢复上次标签页)...
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=msedge.exe"
start "" "%EDGE%" --no-first-run --restore-last-session --load-extension="%ROOT%extension" "http://127.0.0.1:3001/ui"
echo.
echo   [OK] 已就绪
echo        侧边栏  Ctrl+Shift+S  (打开目标网站会自动弹出)
echo        控制台  http://127.0.0.1:3001/ui
echo.
echo   窗口不会自动关闭,方便你确认没有报错。
echo   按任意键关闭此窗口 ...
pause >nul
exit /b 0
