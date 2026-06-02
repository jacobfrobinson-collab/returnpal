@echo off
cd /d "%~dp0"
echo Running from: %CD%
echo.
call npm run ebay:chrome
echo.
pause
