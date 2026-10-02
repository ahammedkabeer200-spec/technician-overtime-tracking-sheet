@echo off
title Push Updates to GitHub & Render
cd /d "%~dp0"

echo Saving and uploading latest changes to GitHub (ahammedkabeer200-spec/technician-overtime-tracking-sheet)...
git add .
git -c user.name="ahammedkabeer" -c user.email="ahammedkabeer200@gmail.com" commit -m "Update overtime web application"
git push origin main

echo.
echo ====================================================================
echo   SUCCESS! Your changes are uploaded to GitHub and Render will
echo   automatically update your live web application!
echo ====================================================================
pause
