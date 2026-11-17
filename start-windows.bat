@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Get the LTS version from https://nodejs.org, install it, then double-click this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing (1-2 minutes)...
  call npm install --no-audit --no-fund
)
call npm start
