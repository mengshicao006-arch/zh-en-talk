@echo off
cd /d D:\zh-en-talk
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\bin;%PATH%"
title zh-en-talk
echo Starting zh-en-talk...
echo Do not close this window.
echo.
call "C:\Program Files\nodejs\npm.cmd" run dev
echo.
echo App closed.
pause
