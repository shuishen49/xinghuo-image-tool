@echo off
setlocal enabledelayedexpansion
pushd "%~dp0"

if exist "%USERPROFILE%\.cargo\bin" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

if not exist "node_modules" (
  echo [1/3] npm install...
  call npm.cmd install || goto :error
)

echo [2/3] tauri build ^(frontend + Rust release + installer^)...
call npx.cmd tauri build || goto :error

echo [3/3] Packing portable ^(green^) zip...
set "REL=src-tauri\target\release"
rem The Cargo crate is named "app", so the release binary is app.exe.
set "EXE=%REL%\app.exe"
if not exist "%EXE%" ( echo Missing "%EXE%". & goto :error )

set "OUT=dist-portable"
if not exist "%OUT%" mkdir "%OUT%"

set "VER=0.1.0"
for /f "tokens=2 delims=:, " %%v in ('findstr /c:"\"version\"" "src-tauri\tauri.conf.json"') do set "VER=%%~v"

set "ZIP=%OUT%\XinghuoImageTool-!VER!-portable-x64.zip"
if exist "!ZIP!" del /q "!ZIP!"

set "STAGE=%OUT%\_stage"
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
copy /y "%EXE%" "%STAGE%\XinghuoImageTool.exe" >nul
> "%STAGE%\readme.txt" echo Double-click XinghuoImageTool.exe to run. No install needed. WebView2 is required (built into Windows 10/11).

powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '!ZIP!' -Force" || goto :error
rmdir /s /q "%STAGE%"

echo.
echo ============================================================
echo Done.
echo   Installer : %REL%\bundle\nsis\
echo   Portable  : !ZIP!
echo ============================================================
popd
exit /b 0

:error
popd
echo Build failed.
exit /b 1
