-- 20261012000020_llm_response_cache.sql
-- Кэш ответов языковой модели для сметы: один и тот же запрос не оплачивается дважды.
--
-- Зачем: смета читает документацию моделью (извлечение ведомости, подбор норм и материалов,
-- работы по технологии), и каждый круг бенчмарка, каждый пересчёт той же закупки и каждый
-- повтор упавшего задания отправляют в шлюз ТЕ ЖЕ запросы (температура 0, промпт — неизменный
-- шаблон + те же данные). Ответ на такой запрос повторяется, платить за него второй раз незачем.
--
-- Ключ: sha256 от (идентификатор модели + вид работы + полный JSON сообщений + версия кэша).
-- Версия кэша — константа в коде (src/services/llmResponseCache.ts, LLM_CACHE_VERSION): правка
-- промпта и так меняет ключ, а версией сбрасывается кэш, когда поменялся разбор ответа.
--
-- Что хранится: только полный и разобранный ответ (finish_reason не «length», JSON читается).
-- Оборванный ответ не кэшируется — повтор запроса должен дать полный. Срок жизни — 60 дней
-- (строки старше игнорируются при чтении; удалять их можно в любой момент:
--   delete from public.llm_response_cache where created_at < now() - interval '60 days';).
--
-- Кэш — оптимизация, а не источник истины: если таблицы нет или база недоступна, смета
-- считается как раньше, вызывая модель (в консоль уходит предупреждение).
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.

create table if not exists public.llm_response_cache (
  key text primary key,
  -- Вид работы (estimate_bill, estimate_norm_pick, estimate_implied): по нему видно, что чаще попадает в кэш.
  purpose text not null,
  model text not null,
  response text not null,
  tokens_in integer,
  tokens_out integer,
  created_at timestamptz not null default now(),
  -- Сколько раз ответ отдан из кэша вместо платного вызова; last_hit_at — когда в последний раз.
  hits integer not null default 0,
  last_hit_at timestamptz
);

create index if not exists llm_response_cache_created_at_idx
  on public.llm_response_cache (created_at);

comment on table public.llm_response_cache is
  'Кэш ответов языковой модели для сметы: ключ — sha256(модель, вид работы, сообщения, версия). Читает и пишет только серверный код.';

-- Права и RLS: как у остальных служебных таблиц (llm_usage_log, sync_profiles, api_usage_log) —
-- только серверный код с ключом SUPABASE_SERVICE_ROLE_KEY. Политик для anon и authenticated нет,
-- поэтому через публичный ключ таблица недоступна.
alter table public.llm_response_cache enable row level security;
