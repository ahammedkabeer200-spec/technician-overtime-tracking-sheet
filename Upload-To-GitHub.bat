@echo off
title Upload Overtime Project to GitHub
cd /d "%~dp0"

echo ========================================================
echo   STEP 1: Create an empty repository on GitHub
echo   Go to: https://github.com/new
echo   Name it: technician-overtime-portal
echo   Click "Create repository" (Leave README unchecked)
echo ========================================================
echo.
set /p REPO_URL="Paste your GitHub Repository URL (e.g. https://github.com/username/technician-overtime-portal.git): "

if "%REPO_URL%"=="" (
    echo Error: No URL entered.
    pause
    exit /b
)

git remote remove origin >nul 2>nul
git remote add origin "%REPO_URL%"
git add .
git -c user.name="Overtime Admin" -c user.email="admin@overtime.local" commit -m "Update project files" >nul 2>nul
echo.
echo Uploading to GitHub (A browser login window may pop up if it is your first time)...
git push -u origin main

echo.
echo ========================================================
echo   DONE! Now go to https://render.com to deploy it!
echo ========================================================
pause
