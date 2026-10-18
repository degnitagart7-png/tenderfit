-- 20261014000022_user_events.sql
-- Журнал действий пользователей для админ-панели «Пользователи» (/admin/users).
--
-- Зачем: владельцу нужно видеть по почте, кто заходит, как часто пользуется и где
-- у него ломается сервис. Раньше этого не было нигде: auth_sessions хранит только
-- входы, а ошибки пользователя оставались в логе сервера без почты.
--
-- Одна строка — одно действие. Пишет серверный код (src/services/userEventLog.ts),
-- не дожидаясь записи: журнал не вправе замедлить или уронить ручку, ради которой
-- ведётся. Шумные виды (открытие ленты, открытие карточки) сервер пишет не чаще
-- раза в 10 минут / в час на человека — таблица не должна расти от каждого клика.
--
-- kind — вид действия:
--   login          — вход, регистрация, вход по коду, восстановление пароля;
--   feed_open      — открыл ленту закупок;
--   tender_open    — открыл карточку закупки (tender_id);
--   deep_analysis  — нажал «Глубокий анализ» (ok = false — отказ: лимит, доступ);
--   estimate       — поставил расчёт или проверку сметы;
--   live_search    — запустил живой поиск по площадкам;
--   link_import    — добавил закупку по ссылке;
--   find_new       — нажал «Найти новые закупки»;
--   error          — ручка ответила ошибкой сервера (ok = false, detail — где и что).
-- Вид не ограничен check-ограничением: новый вид добавляется кодом, без миграции.
--
-- email — почта в нижнем регистре, как в app_users.email. Внешнего ключа нет
-- намеренно: запись о действии должна пережить удаление аккаунта.
--
-- Колонка sync_jobs.requested_by уже есть (создана вместе с очередью, 20260925000004):
-- раньше в ней стояла метка источника («ui», «live-search»), теперь для заданий,
-- поставленных вошедшим человеком, — его почта. По ней админ-панель относит расход
-- на ИИ (llm_usage_log.job_id = sync_jobs.id) и сбои заданий к пользователю.
-- Оператор `if not exists` ниже ничего не меняет, если колонка есть; индекс нужен
-- для выборок по человеку.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Пока миграция не применена, запись событий молча пропускается (в консоль
-- уходит одно предупреждение), а страница /admin/users показывает расход и сбои
-- заданий без журнала действий.
--
-- Миграция идемпотентна: повторный запуск ничего не ломает.

create table if not exists public.user_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),

  email text not null,
  kind text not null,
  ok boolean not null default true,

  -- Реестровый номер закупки, если действие к ней относится.
  tender_id text,
  -- Подробность: текст отказа или ошибки, не длиннее 300 знаков (режет код).
  detail text
);

create index if not exists user_events_email_created_idx
  on public.user_events (email, created_at desc);
create index if not exists user_events_created_idx
  on public.user_events (created_at desc);

comment on table public.user_events is
  'Журнал действий пользователей: вход, открытие ленты и карточки, запуск анализа, сметы, поиска, ошибки. Источник страницы /admin/users.';

-- Права и RLS: как у остальных служебных таблиц (llm_usage_log, sync_profiles) —
-- читает и пишет только серверный код с ключом SUPABASE_SERVICE_ROLE_KEY.
-- Политик для anon и authenticated нет, поэтому через публичный ключ таблица
-- недоступна. Клиенту цифры отдаёт API-роут /api/admin/users, закрытый сессией
-- администратора (ADMIN_EMAILS).
alter table public.user_events enable row level security;

-- Задания очереди: кто поставил (почта) — для расхода на ИИ и сбоев по человеку.
alter table public.sync_jobs add column if not exists requested_by text;
create index if not exists sync_jobs_requested_by_created_idx
  on public.sync_jobs (requested_by, created_at);
