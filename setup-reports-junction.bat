@echo off
setlocal EnableExtensions

set "REPO_DIR=%~dp0"
if "%REPO_DIR:~-1%"=="\" set "REPO_DIR=%REPO_DIR:~0,-1%"
set "REPORTS_DIR=%REPO_DIR%\Reports"

if not exist "%REPORTS_DIR%" (
    mkdir "%REPORTS_DIR%"
)

for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path" 2^>nul`) do (
    set "DOWNLOADS_DIR=%%D"
)

if not defined DOWNLOADS_DIR (
    set "DOWNLOADS_DIR=%USERPROFILE%\Downloads"
)

if not exist "%DOWNLOADS_DIR%" (
    echo [ERROR] Downloads directory not found: "%DOWNLOADS_DIR%"
    exit /b 1
)

set "JUNCTION_PATH=%DOWNLOADS_DIR%\CE-Reports"

if exist "%JUNCTION_PATH%" (
    rem Check if existing path is a reparse point (junction/symlink) or real directory
    powershell -NoProfile -Command "$item = Get-Item -LiteralPath '%JUNCTION_PATH%' -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($item.FullName); exit 0 } else { Write-Error 'Existing path is not a junction'; exit 2 }"
    if errorlevel 1 (
        echo [ERROR] "%JUNCTION_PATH%" already exists and is not a junction. Please move or remove it manually.
        exit /b 1
    )
)

mklink /J "%JUNCTION_PATH%" "%REPORTS_DIR%"
if errorlevel 1 (
    echo [ERROR] Failed to create directory junction.
    exit /b 1
)

echo [OK] Junction created: "%JUNCTION_PATH%" -^> "%REPORTS_DIR%"
endlocal
