# База в России: Beget Cloud PostgreSQL + PostgREST на VPS

С 2026-10 данные переезжают из Supabase (Франкфурт) в облачную PostgreSQL Beget (152-ФЗ, ч. 5 ст. 18).
Приложение пользуется Supabase только как API таблиц (PostgREST, `@supabase/supabase-js` с сервера),
поэтому на VPS ставится свой PostgREST той же ветки (12.2), а код не меняется: меняются
`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` в `/etc/tenderfit/app.env` и `worker.env`.

Схема:

    приложение / воркер ──► http://127.0.0.1:8088/rest/v1/  (nginx, только localhost)
                               └──► 127.0.0.1:3010  PostgREST (tenderfit-postgrest.service)
                                        └──► Beget Cloud PostgreSQL 16 (sslmode=require)

Файлы:
- `postgrest.env.example` — переменные PostgREST; рабочий файл `/etc/tenderfit/postgrest.env` (секреты, chmod 600).
- `tenderfit-postgrest.service` — systemd-юнит PostgREST.
- `nginx-local-api.conf` — внутренний адрес `/rest/v1/` для supabase-js (порт 8088 на 127.0.0.1).
- `db-migrate.sh` — применить `supabase/migrations` по порядку к новой базе.

Перенос данных — `scripts/restore-db.ts --apply` из ночной копии `scripts/backup-db.ts`
(пароль к базе Supabase не нужен). Порядок переключения — в плане переезда.
