@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Per l'invio email serve Node.js 22 o successivo. Consulta LEGGIMI-email.txt.
  pause
  exit /b 1
)
node email-service.cjs
pause
