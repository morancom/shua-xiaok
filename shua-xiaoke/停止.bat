@echo off
chcp 936 >nul
title 刷小课 - 停止
color 0B
setlocal enabledelayedexpansion
echo.
echo   [*] 停止本地后端 ...
set "N=0"
for /f "delims=" %%p in ('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" ^| Where-Object { $_.CommandLine -like '*server.js*' } ^| ForEach-Object { $_.ProcessId }"') do (
  taskkill /pid %%p /f >nul 2>nul
  set /a N+=1
)
if "!N!"=="0" (
  echo   [OK] 没有正在运行的后端
) else (
  echo   [OK] 已停止 !N! 个后端进程
)
echo.
echo   如需彻底移除扩展:打开 edge://extensions 点「移除」。
echo.
echo   按任意键关闭此窗口 ...
pause >nul
exit /b 0
