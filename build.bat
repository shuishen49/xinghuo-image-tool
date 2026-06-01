@echo off
setlocal

pushd "%~dp0"

if exist "%USERPROFILE%\.cargo\bin" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

if not exist "node_modules" (
  call npm.cmd install
  if errorlevel 1 goto :error
)

call npx.cmd tauri build
if errorlevel 1 goto :error

popd
echo Build finished successfully.
exit /b 0

:error
popd
echo Build failed.
exit /b 1
