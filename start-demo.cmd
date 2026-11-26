@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==============================================================
echo  Foundry Form Copilot デモ環境を起動します
echo  - Webアプリ ランチャー : http://localhost:3000
echo  - A社 Sakura Expense   : http://localhost:3001
echo  - B社 J-Keihi 基幹画面 : http://localhost:3002
echo  - Foundry ローカル中継 : http://127.0.0.1:8765
echo ==============================================================

start "Mock Expense Web Apps (3000/3001/3002)" cmd /k "chcp 65001 >nul && node "%~dp0web-apps\server.mjs""
start "Foundry Agent Bridge (8765)" cmd /k "chcp 65001 >nul && "%~dp0agent-backend\.venv\Scripts\python.exe" "%~dp0agent-backend\bridge_server.py""

timeout /t 2 >nul
start "" "http://localhost:3000"
echo 起動しました。各ウィンドウを閉じると停止します。
