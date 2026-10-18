-- 20261011000019_add_access_trial.sql
-- Доступ к приложению: бесплатный период на 3 дня и оплаченный срок.
--
-- Оплата идёт по счёту, поэтому срок оплаты владелец продлевает вручную
-- (scripts/grant-access.ts): `paid_until` — до какого момента оплачено, `plan` —
-- какой пакет («start», «calc», «premium»). Правила (администратор > оплачено >
-- пробный период > истёк) живут в коде, src/domain/access.ts, и проверяются
-- тестами; база хранит только даты.
--
-- Существующие пользователи получают пробный период от момента применения
-- миграции: так никого не выкидывает из приложения в первую же минуту, а у
-- каждого есть три дня, чтобы выбрать тариф.
--
-- Колонки `trial_notice_sent_at` и `trial_end_notice_sent_at` — когда воркер
-- отправил письма «пробный период закончится завтра» и «пробный период
-- закончился». Отметка нужна, чтобы каждое письмо ушло один раз.
--
-- Миграция идемпотентна: повторный запуск ничего не ломает.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR ДО ВЫКЛАДКИ КОДА: Supabase CLI в этом проекте не
-- работает, а код читает эти колонки при каждой проверке сессии.

alter table public.app_users
  add column if not exists trial_ends_at timestamptz,
  add column if not exists paid_until timestamptz,
  add column if not exists plan text,
  add column if not exists trial_notice_sent_at timestamptz,
  add column if not exists trial_end_notice_sent_at timestamptz;

-- Пакет — один из трёх (см. src/domain/plans.ts); null — оплат не было.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_users_plan_check'
  ) then
    alter table public.app_users
      add constraint app_users_plan_check
      check (plan is null or plan in ('start', 'calc', 'premium'));
  end if;
end
$$;

-- Те, у кого срока нет (заведены до этой миграции): три дня от запуска.
update public.app_users
set trial_ends_at = now() + interval '3 days'
where trial_ends_at is null;

-- Запасное значение для новых строк: приложение задаёт срок само (TRIAL_DAYS),
-- а это страхует от строки, созданной в обход него.
alter table public.app_users
  alter column trial_ends_at set default (now() + interval '3 days');

-- Выборка воркера для писем: у кого срок пробного периода близко или вышел.
create index if not exists idx_app_users_trial_ends on public.app_users (trial_ends_at);
