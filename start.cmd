@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE="
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
    echo.
    echo Node.js was not found.
    echo Install Node.js 18+ or put node.exe in the node\ folder.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\ws" (
    echo Installing dependencies for the first run...
    call npm install --omit=dev --no-audit --no-fund
    if errorlevel 1 (
        echo Dependency install failed. Check your network or re-extract the release folder.
        pause
        exit /b 1
    )
)

echo.
echo Starting LAN Audio...
echo Browser will open: http://localhost:8080/
echo If Windows Firewall asks, allow Private networks.
echo Close this window to stop the service.
echo.

"%NODE_EXE%" server\index.js --open
pause
