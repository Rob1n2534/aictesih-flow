@echo off
cd /d "%~dp0"
echo Starting AICTE FLOW SIH 2026 prototype...
docker compose up --build
pause
