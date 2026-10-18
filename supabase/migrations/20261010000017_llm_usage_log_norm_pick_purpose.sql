-- 20261010000017_llm_usage_log_norm_pick_purpose.sql
-- Новый вид работы в журнале расхода на модель: estimate_norm_pick — подбор норм ГЭСН
-- «ИИ-сметчиком» для позиций ведомости без шифра (POST /api/estimate/norm-pick).
--
-- Что делает: расширяет проверку purpose. Пока миграция не применена, запись учёта для
-- нового вида работы отвергается базой, а учёт, по правилу проекта, не роняет работу:
-- в консоль уходит предупреждение, подбор норм и смета работают как раньше, но расход
-- на подбор в отчёт не попадает. Применять до выкладки кода.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.

alter table public.llm_usage_log
  drop constraint if exists llm_usage_log_purpose_check;

alter table public.llm_usage_log
  add constraint llm_usage_log_purpose_check
  check (purpose in ('deep_analysis', 'estimate_bill', 'estimate_norm_pick', 'search_assist', 'rerank', 'other'));
