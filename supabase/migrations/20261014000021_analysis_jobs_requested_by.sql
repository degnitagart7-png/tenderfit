-- Кто поставил глубокий разбор: суточный лимит (20) считается на человека, а не на весь сервис.
-- Решение владельца 14.10.2026. Старые и служебные задачи остаются с NULL.
alter table public.analysis_jobs add column if not exists requested_by text;
create index if not exists analysis_jobs_requested_by_created_idx
  on public.analysis_jobs (requested_by, created_at);
