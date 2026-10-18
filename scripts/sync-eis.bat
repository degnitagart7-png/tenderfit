@echo off
REM Автосинхронизация закупок -> Supabase по профилям поиска. Площадки задаёт
REM каталог src\domain\sources.ts, а не этот файл.
REM Расписание с 25.09.2026 живёт на сервере в России (scripts\worker.ts,
REM docs\REFERENCE_RU_WORKER.md); эта обёртка оставлена для ручного запуска.
cd /d C:\Users\1\Downloads\tenderfit-ai
if not exist logs mkdir logs
echo ===== %date% %time% ===== >> logs\sync-eis.log
call npx tsx scripts\sync-eis.ts >> logs\sync-eis.log 2>&1
