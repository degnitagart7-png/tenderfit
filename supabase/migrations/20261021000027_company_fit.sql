-- 20261021000027_company_fit.sql
-- «Соответствие вашей компании»: результат сверки требований закупки с фактами о компании пользователя
-- (POST /api/company/fit) и два новых вида работы в журнале расхода на модель.
--
-- Решение владельца 21.10.2026: пользователи загружают документы о своей компании (прайс, опыт, СРО, лицензии,
-- кадры, техника), из них извлекаются деловые факты (без ФИО, телефонов и прочих ПД — они скрываются до модели,
-- src/domain/companyFacts/scrubPii.ts), а глубокий анализ закупки учитывает компанию. Общий разбор закупки
-- (document_analyses) остаётся один на всех; сверка с компанией — отдельный шаг на человека и закупку.
--
-- `company_fit` — одна строка на (пользователь, закупка): последний результат.
--
--   user_id       — app_users.id; удаление аккаунта удаляет и результаты.
--   tender_id     — реестровый номер закупки, как в analysis_jobs.tender_id.
--   analysis_hash — отпечаток выводов анализа закупки (требования, цена, регион, закон): другой разбор — другая сверка.
--   facts_hash    — отпечаток данных компании (факты из документов + допуски, лицензии, опыт, кадры анкеты): правка
--                   анкеты или документов — другая сверка.
--   Совпали оба отпечатка и версия формата — сверка не пересчитывается и модель не вызывается (кэш на человека и закупку).
--   result        — CompanyFitResult как JSON (src/domain/companyFacts/fit.ts): вердикты по требованиям, контракты по теме,
--                   чего не хватает, риски. Персональных данных нет: факты проходят скруббер, а текст ответа модели ещё раз.
--   overall       — fit | partial | no_fit | unknown — для выборок без разбора JSON.
--   llm_used      — модельная сверка состоялась (по таким строкам считается суточный предел сверок на человека).
--
-- Почему отдельная таблица, а не user_data.app_state. Результаты — серверные и могут копиться по десяткам закупок, а
-- app_state устройство отправляет целиком («заменить»): он синхронизируется с браузером, ограничен размером тела
-- запроса, а запись «последний победил» затёрла бы результат, посчитанный сервером между двумя отправками. Здесь у
-- результата один владелец — сервер.
--
-- Расширяется проверка purpose в llm_usage_log: company_facts (извлечение фактов из документов компании,
-- POST /api/company/facts) и company_fit (сверка с закупкой). Без этого запись учёта по новым видам отвергается базой,
-- а учёт, по правилу проекта, не роняет работу — расход просто не попадал бы в отчёт.
--
-- Права и RLS — как у остальных служебных таблиц: читает и пишет только серверный код с ключом service role
-- (на Beget роль запросов — владелец базы, отдельные GRANT не нужны).
--
-- ПРИМЕНЯТЬ: /root/dbmove/pq.sh -f supabase/migrations/20261021000027_company_fit.sql
-- (после — перечитать схему PostgREST: systemctl kill -s SIGUSR1 tenderfit-postgrest; в конце файла для этого же
-- отправляется NOTIFY). Идемпотентна: повтор ничего не ломает.

create table if not exists public.company_fit (
  user_id uuid not null references public.app_users (id) on delete cascade,
  tender_id text not null,
  analysis_hash text not null,
  facts_hash text not null,
  result jsonb not null,
  overall text not null check (overall in ('fit', 'partial', 'no_fit', 'unknown')),
  llm_used boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, tender_id)
);

create index if not exists company_fit_user_updated_idx
  on public.company_fit (user_id, updated_at desc);

comment on table public.company_fit is
  'Результат сверки требований закупки с фактами о компании пользователя: последний на (пользователь, закупка). Читает и пишет только серверный код.';

alter table public.company_fit enable row level security;

alter table public.llm_usage_log
  drop constraint if exists llm_usage_log_purpose_check;

alter table public.llm_usage_log
  add constraint llm_usage_log_purpose_check
  check (purpose in (
    'deep_analysis', 'estimate_bill', 'estimate_norm_pick', 'estimate_implied',
    'search_assist', 'rerank', 'company_facts', 'company_fit', 'other'
  ));

-- PostgREST: подхватить новую таблицу без перезапуска.
notify pgrst, 'reload schema';
