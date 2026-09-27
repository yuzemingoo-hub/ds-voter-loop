@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\DSH\DeepSeek Harness\Open DeepSeek Harness Desktop\resources\runtime\win32-x64\node.exe" set "NODE_EXE=D:\DSH\DeepSeek Harness\Open DeepSeek Harness Desktop\resources\runtime\win32-x64\node.exe"
if not defined NODE_EXE goto nonode

echo.
echo   ds-voter-loop 正在启动……
echo   控制台会自动在浏览器里打开： http://127.0.0.1:8787/
echo   关掉这个黑窗口就等于关掉服务。
echo.
"%NODE_EXE%" server.mjs %*
if errorlevel 1 goto failed
goto end

:nonode
echo.
echo   [!] 没找到 Node.js 运行时。
echo       办法一：装一个 Node 18 或更高版本： https://nodejs.org/
echo       办法二：把 node.exe 放进本目录的 runtime 文件夹
echo.
pause
exit /b 1

:failed
echo.
echo   [!] 启动失败，错误信息见上面几行。
echo       如果提示端口被占用，说明已经开着一个了，直接打开 http://127.0.0.1:8787/
echo.
pause
exit /b 1

:end
endlocal
