-- 20261008000016_add_llm_usage_log.sql
-- Журнал расхода на языковую модель: одна строка на один вызов шлюза.
--
-- Зачем: владелец хочет через месяц увидеть средний расход в рублях на один
-- глубокий анализ. Без журнала токены лежат только в document_analyses
-- (tokens_used) и без цены, а вызовы сметы и помощника поиска не пишутся вовсе.
-- Здесь стоимость пишется в рублях по каждому вызову, с привязкой к закупке
-- (tender_id — реестровый номер, как в tender_documents) и заданию (job_id —
-- analysis_jobs.id или sync_jobs.id: у них разные таблицы, поэтому без внешнего
-- ключа). Отчёт: npx tsx scripts/llm-cost-report.ts.
--
-- Откуда стоимость (cost_source):
--   'provider'    — шлюз сам назвал стоимость в usage.cost (routerai.ru — в рублях);
--   'price_table' — токены × цены LLM_PRICE_IN_RUB_PER_M / LLM_PRICE_OUT_RUB_PER_M.
-- Если шлюз назвал стоимость в долларах, provider_cost и provider_currency хранят
-- её как есть, а usd_rub — курс ЦБ, по которому она пересчитана в cost_rub.
--
-- Неудачные вызовы тоже пишутся (ok = false): токены по ним могли быть списаны.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Пока миграция не применена, запись учёта молча пропускается (в консоль
-- уходит предупреждение), разбор документов и смета работают как раньше.

create table if not exists public.llm_usage_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Вид работы. deep_analysis — разбор фрагмента документа; estimate_bill —
  -- извлечение ведомости для сметы; search_assist — варианты формулировки
  -- запроса; rerank — оценка найденных закупок по смыслу; other — диагностика.
  purpose text not null
    check (purpose in ('deep_analysis', 'estimate_bill', 'search_assist', 'rerank', 'other')),

  -- Реестровый номер закупки; null у вызовов без закупки (помощник поиска).
  tender_id text,
  -- analysis_jobs.id (deep_analysis) или sync_jobs.id (estimate_bill).
  job_id text,
  -- Кто вызвал, если вызов от вошедшего пользователя.
  user_id text,

  model text not null,
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),

  cost_rub numeric(12, 4) not null default 0 check (cost_rub >= 0),
  cost_source text not null check (cost_source in ('provider', 'price_table')),
  provider_cost numeric(14, 6),
  provider_currency text,
  usd_rub numeric(10, 4),

  -- Размер запроса (знаков промпта): по нему видно, сколько текста ушло в модель.
  input_chars integer not null default 0 check (input_chars >= 0),

  ok boolean not null default true,
  error text
);

create index if not exists llm_usage_log_created_at_idx
  on public.llm_usage_log (created_at);
create index if not exists llm_usage_log_purpose_created_at_idx
  on public.llm_usage_log (purpose, created_at);
create index if not exists llm_usage_log_tender_id_idx
  on public.llm_usage_log (tender_id);

comment on table public.llm_usage_log is
  'Журнал расхода на языковую модель: вызов шлюза, токены и стоимость в рублях. Источник отчёта «средний расход на глубокий анализ».';

-- Права и RLS: как у остальных служебных таблиц проекта (sync_profiles,
-- search_demand, api_usage_log) — читает и пишет только серверный код с ключом
-- SUPABASE_SERVICE_ROLE_KEY. Политик для anon и authenticated нет, поэтому
-- через публичный ключ таблица недоступна. Клиенту цифры отдаёт API-роут,
-- закрытый ADMIN_TOKEN.
alter table public.llm_usage_log enable row level security;
