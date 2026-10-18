-- 20260921000003_add_kontur_source.sql
-- Интеграция источника «Контур.Закупки» (zakupki.kontur.ru):
--   1. значение KONTUR в tenders.data_source;
--   2. колонки tenders.raw_data и tenders.synced_at;
--   3. кэш сырых ответов kontur_raw_responses (повторное использование без API);
--   4. журнал расхода api_usage_log (сколько trial-запросов потрачено);
--   5. значения kontur_api и tz для tender_documents.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Проект zeypawygxijctavhasyn (Stockholm).
-- Зависит от 20260921000002_add_sber_ast_source.sql — применяйте по порядку.
--
-- Почему нет колонок source и source_id из ТЗ: в таблице уже есть
-- data_source (источник) и external_id (внутренний ID закупки на источнике).
-- Дублировать их смысла нет, поэтому добавлены только недостающие raw_data
-- и synced_at.

-- ============================ 1. tenders.data_source ============================

-- Имя CHECK-ограничения генерируется автоматически, поэтому ищем его через pg_constraint.
do $$
declare
  cons record;
begin
  for cons in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'tenders'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%data_source%'
  loop
    execute format('alter table public.tenders drop constraint %I', cons.conname);
  end loop;
end $$;

alter table public.tenders
  add constraint tenders_data_source_check
  check (data_source in ('MOCK', 'EIS', 'IMPORT', 'SBER_AST', 'KONTUR'));

-- ============================ 2. tenders: сырой ответ и время синка ============================

alter table public.tenders
  add column if not exists raw_data jsonb,
  add column if not exists synced_at timestamptz;

comment on column public.tenders.raw_data is
  'Последний сырой ответ источника по этой закупке: позволяет пересобрать запись без нового запроса к платному API.';
comment on column public.tenders.synced_at is
  'Момент последнего получения записи из источника. В отличие от updated_at не меняется триггером при любом обновлении.';

create index if not exists tenders_synced_at_idx on public.tenders (synced_at desc);

-- ============================ 3. Кэш сырых ответов ============================

create table if not exists public.kontur_raw_responses (
  id uuid primary key default gen_random_uuid(),
  -- Ключ кэша: вид запроса + хэш его параметров (см. konturCacheKey).
  cache_key text not null unique,
  -- Вид запроса = эндпоинт Контур.Закупок: search и card платные,
  -- testcard (/testpurchases) и limits (/limitGroups) — бесплатные.
  -- Отдельных видов documents и changes нет: метода для документов у API нет
  -- (ссылки приходят полем Docs карточки), а проверка изменений читает ту же
  -- карточку, только с более коротким TTL.
  kind text not null check (kind in ('search', 'card', 'testcard', 'limits')),
  url text not null,
  method text not null check (method in ('GET', 'POST')),
  status integer not null,
  -- Тело POST-запроса: по нему понятно, какой именно поиск дал этот ответ.
  request_body jsonb,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists kontur_raw_responses_fetched_at_idx
  on public.kontur_raw_responses (fetched_at desc);
create index if not exists kontur_raw_responses_kind_idx
  on public.kontur_raw_responses (kind);

comment on table public.kontur_raw_responses is
  'Сырые ответы Контур.Закупок. Повторный одинаковый запрос берётся отсюда и не расходует платный лимит.';

-- ============================ 4. Журнал расхода API ============================

create table if not exists public.api_usage_log (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'kontur',
  kind text not null,
  url text not null,
  status integer,
  -- true: ответ взят из кэша, запрос к внешнему API не выполнялся.
  from_cache boolean not null default false,
  duration_ms integer not null default 0,
  error text,
  requested_at timestamptz not null default now()
);

create index if not exists api_usage_log_requested_at_idx
  on public.api_usage_log (requested_at desc);
create index if not exists api_usage_log_provider_idx
  on public.api_usage_log (provider, requested_at desc);

comment on table public.api_usage_log is
  'Журнал обращений к платным источникам. Считает реальные запросы (from_cache = false) и ошибки.';

-- ============================ 5. tender_documents ============================

do $$
declare
  cons record;
begin
  for cons in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'tender_documents'
      and con.contype = 'c'
      and (pg_get_constraintdef(con.oid) like '%source_type%'
           or pg_get_constraintdef(con.oid) like '%document_type%')
  loop
    execute format('alter table public.tender_documents drop constraint %I', cons.conname);
    if cons.def like '%source_type%' then
      alter table public.tender_documents
        add constraint tender_documents_source_type_check
        check (source_type in ('torgi_open_data', 'eis_api', 'manual_upload', 'kontur_api'));
    else
      -- 'tz' — техническое задание, 'requirements' — требования к участникам
      -- (значение зарезервировано: доменный тип документа появится вместе с
      -- разбором требований из карточки Контур.Закупок).
      alter table public.tender_documents
        add constraint tender_documents_document_type_check
        check (document_type in
          ('notice', 'protocol', 'contract', 'attachment', 'other', 'tz', 'requirements'));
    end if;
  end loop;
end $$;

-- ============================ 6. Доступ ============================

-- Права и RLS не настраиваем: как и остальные таблицы проекта, эти читаются и
-- пишутся только серверным кодом через SUPABASE_SERVICE_ROLE_KEY
-- (src/lib/supabase.ts). Клиентского доступа к сырым ответам и журналу расхода
-- нет — anon-ключ их не запрашивает.
