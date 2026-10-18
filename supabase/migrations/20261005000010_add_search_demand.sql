-- 20261005000010_add_search_demand.sql
-- Спрос посетителей на темы закупок: по нему сервер решает, что собирать.
--
-- Зачем: сборщик знал три зашитых темы, а профили владельца годятся для одного
-- человека. Для сервиса с многими клиентами сбор идёт по объединению тем всех
-- активных посетителей: сто человек с запросом «юрист» дают один запрос к
-- площадкам, а тема, которую две недели никто не открывал, перестаёт
-- собираться (срок задаётся в коде, DEMAND_TTL_DAYS, строки старше чистит
-- сборщик).
--
-- Посетитель анонимен: visitor_id — случайный идентификатор из его браузера.
-- Таблица доступна только серверу (ключ service role), политик для anon нет.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.

create table if not exists public.search_demand (
  visitor_id text not null check (visitor_id ~ '^[A-Za-z0-9-]{16,64}$'),
  keyword text not null check (char_length(keyword) between 2 and 60),
  laws text[] not null check (cardinality(laws) > 0),
  last_seen_at timestamptz not null default now(),
  primary key (visitor_id, keyword)
);

create index if not exists idx_search_demand_last_seen on public.search_demand (last_seen_at);

alter table public.search_demand enable row level security;
