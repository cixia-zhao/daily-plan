@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Daily Plan - Local Server

set "APP_URL=http://127.0.0.1:8000"
where python >nul 2>&1
if errorlevel 1 goto no_python

echo ========================================
echo          DAILY PLAN LOCAL SERVER
echo ========================================
echo Project: %CD%
echo Python:
where python
echo.

python -c "import app.main, app.launcher, uvicorn" >nul 2>&1
if errorlevel 1 goto missing_dependencies

if /I "%~1"=="--check" goto check_only

python -c "from urllib.request import urlopen;urlopen('%APP_URL%',timeout=1)" >nul 2>&1
if not errorlevel 1 goto already_running

echo [START] Starting the backend. The browser will open when ready.
echo [URL]   %APP_URL%
echo [STOP]  Press Ctrl+C here, or close this window.
echo.

start "" /b python -m app.launcher "%APP_URL%"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

echo.
echo [STOPPED] The Daily Plan server has exited.
pause
exit /b 0

:check_only
echo [OK] Python, application modules, and Uvicorn are available.
python -c "import socket;s=socket.socket();code=s.connect_ex(('127.0.0.1',8000));s.close();print('[INFO] Port 8000: '+('in use' if code==0 else 'available'))"
exit /b 0

:already_running
echo [INFO] The Daily Plan server is already running. Opening browser.
start "" "%APP_URL%"
echo.
echo Closing this window will not stop the existing server.
pause
exit /b 0

:missing_dependencies
echo [ERROR] Application dependencies are not installed.
echo Run this in the project terminal: python -m pip install -e ".[dev]"
echo.
pause
exit /b 1

:no_python
echo [ERROR] Python was not found.
echo Install Python and make sure the python command works in a terminal.
pause
exit /b 1
