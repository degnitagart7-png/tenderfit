-- 20261010000018_llm_usage_log_implied_purpose.sql
-- Новый вид работы в журнале расхода на модель: estimate_implied — предложение работ, которых нет
-- в ведомости, но которые обязана технология (леса, защитные сетки, ограждения), для сметы
-- (POST /api/estimate/implied-works).
--
-- Что делает: расширяет проверку purpose. Пока миграция не применена, запись учёта для
-- нового вида работы отвергается базой, а учёт, по правилу проекта, не роняет работу:
-- в консоль уходит предупреждение, смета считается как обычно, но расход на этот вызов
-- в отчёт не попадает. Применять до выкладки кода.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.

alter table public.llm_usage_log
  drop constraint if exists llm_usage_log_purpose_check;

alter table public.llm_usage_log
  add constraint llm_usage_log_purpose_check
  check (purpose in ('deep_analysis', 'estimate_bill', 'estimate_norm_pick', 'estimate_implied', 'search_assist', 'rerank', 'other'));
