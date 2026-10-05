-- 20261005000011_add_email_auth.sql
-- Вход по коду из письма: пользователи, коды, сессии и их данные.
--
-- Своя схема, а не Supabase Auth: правила входа (закрыта почта Google, лимиты
-- писем, срок кода) живут в нашем коде и проверяются тестами, а данные
-- пользователей остаются переносимыми — их можно вынести в базу в России
-- (152-ФЗ) без переписывания входа.
--
-- Все таблицы доступны только серверу (ключ service role): RLS включён,
-- политик для anon нет. В базе лежат хэши кодов и токенов, а не они сами.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  -- Запасной замок: почта Google закрыта и в коде, но база не должна принять её
  -- ни при какой ошибке сервера. Домен сравнивается по границе точки.
  constraint app_users_not_google
    check (email !~ '@([a-z0-9-]+\.)*(gmail\.com|googlemail\.com|google\.com)\.?$')
);

create table if not exists public.auth_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_auth_codes_email_created on public.auth_codes (email, created_at desc);

create table if not exists public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_auth_sessions_user on public.auth_sessions (user_id);

-- Данные пользователя, которые должны следовать за ним на другое устройство.
create table if not exists public.user_data (
  user_id uuid primary key references public.app_users (id) on delete cascade,
  search_profiles jsonb not null default '[]'::jsonb,
  company_profile jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_users enable row level security;
alter table public.auth_codes enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.user_data enable row level security;

-- Счётчик попыток увеличивается в базе одним оператором: чтение с последующей
-- записью дало бы подбирающему больше попыток, чем пять, если слать запросы
-- параллельно.
create or replace function public.bump_auth_attempts(code_id uuid)
returns void
language sql
as $$
  update public.auth_codes set attempts = attempts + 1 where id = code_id;
$$;

revoke all on function public.bump_auth_attempts(uuid) from public, anon, authenticated;
