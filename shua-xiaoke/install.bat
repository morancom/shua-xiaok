@echo off
chcp 936 >nul
title 刷小课 - 一键安装
color 0B
setlocal enabledelayedexpansion
echo.
echo   ==========================================
echo     刷小课  -  本地刷课做题助手   一键安装
echo   ==========================================
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

rem ---------- 打开扩展管理页,引导一次性加载 ----------
echo.
echo   [*] 打开 Edge 扩展管理页 ...
start "" "msedge.exe" "edge://extensions/"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:3001/ui"

echo.
echo   ==========================================
echo    最后一步:在打开的扩展页里加载本扩展
echo   ==========================================
echo.
echo    1. 打开右下角(或左上角)的「开发人员模式」开关
echo    2. 点「加载解压缩的扩展」
echo    3. 选择下面这个文件夹:
echo       %ROOT%extension
echo.
echo    加载成功后,扩展会一直留在 Edge 里,
echo    关掉浏览器再打开也不用重新加载。
echo.
echo   ------------------------------------------
echo    用起来:
echo      侧边栏快捷键   Ctrl+Shift+S
echo      后端控制台     http://127.0.0.1:3001/ui
echo      打开控制台     点扩展图标
echo    超星 / 学习通 / 智慧树 / U校园 会自动弹出侧边栏
echo   ------------------------------------------
echo.
echo  接真实模型:控制台 -^> 真实模型,填接口地址与 API Key。
echo  不填也能跑,用内置演示答案。
echo.
echo  接下来会自动打开扩展页,请按上面 3 步操作。
echo.
pause
exit /b 0
