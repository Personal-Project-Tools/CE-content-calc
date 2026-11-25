@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..") do set "REPO_DIR=%%~fI"
if "%REPO_DIR:~-1%"=="\" set "REPO_DIR=%REPO_DIR:~0,-1%"
set "REPORTS_DIR=%REPO_DIR%\data\raw_file"

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
    rem Handle existing junction/reparse point or auto-created regular Downloads\CE-Reports directory
    powershell -NoProfile -Command "$src = $env:JUNCTION_PATH; $dst = $env:REPORTS_DIR; $item = Get-Item -LiteralPath $src -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($item.FullName); exit 0 }; if (-not $item.PSIsContainer) { Write-Error 'Existing path is a file, not a directory.'; exit 2 }; $children = Get-ChildItem -LiteralPath $src -Force; if ($children) { Write-Host ('[INFO] Migrating existing files from ' + $src + ' to ' + $dst + '...'); foreach ($c in $children) { Copy-Item -LiteralPath $c.FullName -Destination $dst -Recurse -Force } }; Remove-Item -LiteralPath $src -Recurse -Force; exit 0"
    if errorlevel 1 (
        echo [ERROR] Failed to prepare "%JUNCTION_PATH%" for junction creation.
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
