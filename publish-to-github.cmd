@echo off
setlocal
cd /d "%~dp0"
echo.
echo   这个脚本会把本项目发布到 GitHub（走 API，不需要装 git）
echo   · 建/复用一个公开仓库： ds-voter-loop
echo   · 上传 30 个源码文件
echo   · 把便携包作为 Release 附件挂上去
echo.
echo   接下来会要你粘贴 GitHub Personal Access Token（输入时不显示，用完请去撤销）
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\publish-github.ps1" -Public %*
echo.
pause
