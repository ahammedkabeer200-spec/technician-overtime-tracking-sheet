@echo off
title Overtime Report Manager - Server & Desktop App
cd /d "%~dp0"

echo Starting Overtime Report Server...
start "Overtime Server" /min cmd /c "node server.js"

timeout /t 2 /nobreak >nul

echo Launching Desktop Application Window...
where msedge >nul 2>nul
if %errorlevel%==0 (
    start "" msedge --app=http://localhost:3000
    exit /b
)

where chrome >nul 2>nul
if %errorlevel%==0 (
    start "" chrome --app=http://localhost:3000
    exit /b
)

start "" http://localhost:3000
