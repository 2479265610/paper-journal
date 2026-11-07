@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 纸间 · Paper Journal

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js。
  echo   请先安装 Node 18 或更高版本： https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动纸间...
node server.mjs --open

echo.
echo   服务已停止。
pause
