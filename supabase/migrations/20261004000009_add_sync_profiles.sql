-- 20261004000009_add_sync_profiles.sql
-- Профили поиска, по которым сервер собирает закупки.
--
-- Зачем: сборщик знал три зашитых профиля из scripts/sync-profiles.json
-- (автомобили, компьютеры, стройка), поэтому запрос «юридические услуги»
-- находил две закупки: юристов никто не собирал. Теперь владелец отправляет
-- свои профили из настроек, а сборщик читает их отсюда. Пока таблица пуста,
-- работает файл, так что миграция ничего не ломает.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Таблица доступна только серверу (ключ service role): политик для anon нет,
-- запись идёт через ручку /api/sync-profiles с ADMIN_TOKEN.

create table if not exists public.sync_profiles (
  -- Название профиля — ключ: повторная отправка заменяет профиль, а не плодит копии.
  name text primary key check (char_length(name) between 2 and 120),
  laws text[] not null check (cardinality(laws) > 0),
  keywords text[] not null check (cardinality(keywords) > 0),
  okpd2_codes text[] not null default '{}',
  min_price numeric check (min_price is null or min_price >= 0),
  max_price numeric check (max_price is null or max_price >= 0),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.sync_profiles enable row level security;
