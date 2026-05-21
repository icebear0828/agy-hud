@echo off
setlocal
node "%~dp0agy-hud.js" %* 2>nul
if %ERRORLEVEL%==0 exit /b 0
if exist "%ProgramFiles%\nodejs\node.exe" "%ProgramFiles%\nodejs\node.exe" "%~dp0agy-hud.js" %*
