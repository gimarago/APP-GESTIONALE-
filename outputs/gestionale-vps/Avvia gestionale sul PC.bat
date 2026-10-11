@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Avvia-gestionale-PC.ps1"
if errorlevel 1 pause
