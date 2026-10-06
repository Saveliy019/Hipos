@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and try again.
  pause
  exit /b 1
)
start "Hipos server - close this window to stop" cmd /k node server.js
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:3000/"
