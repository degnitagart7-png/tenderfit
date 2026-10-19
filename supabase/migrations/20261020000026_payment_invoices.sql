-- 20261020000026_payment_invoices.sql
-- Оплата подписки: счета через Точку и заявки «я оплатил по QR (СБП)».
--
-- Решение владельца 20.10.2026: подписку оплачивают компании по счёту с расчётного
-- счёта, физлица и ИП — по статическому СБП-QR владельца; кто заплатил, определяется
-- автоматически, подписка включается сама (src/services/payments/*).
--
-- `payment_invoices` — одна строка на счёт (method = 'invoice', выставлен в Точке через
-- API) или на заявку об оплате по QR (method = 'sbp_claim': человек нажал «Я оплатил»,
-- деньги ещё не подтверждены банком или владельцем).
--
--   status        issued    — ждём оплату;
--                 paid      — оплата подтверждена, подписка продлена (activated_until);
--                 cancelled — счёт не удалось выставить или отозван;
--                 expired   — оплаты не было 45 дней (заявки по QR — 14).
--   invoice_number — наш сквозной номер «ТФ-0001» (payment_next_invoice_number()); он же
--                 уходит в Точку как номер счёта и попадает в назначение платежа клиента.
--   tochka_document_id — documentId счёта в Точке; по нему читается статус и PDF.
--   tochka_payment_ref — чем подтверждена оплата: paymentId входящего платежа, operationId
--                 СБП, «status:<documentId>» (опрос Точки) или «manual:<id заявки>» (ссылка
--                 владельца). Уникален: один платёж не включает два счёта.
--   activated_until — до какого числа продлена подписка этим счётом; NOT NULL = подписка
--                 уже включена. Это и есть отметка идемпотентности (см. функцию ниже).
--
-- `payment_events` — журнал входящих событий банка (вебхуки incomingPayment,
-- incomingSbpPayment, incomingSbpB2BPayment). ref уникален: повторная доставка того же
-- платежа не обрабатывается дважды. Платёж по QR, пришедший раньше нажатия «Я оплатил»,
-- лежит здесь без пары (outcome = 'unmatched') и подхватывается, когда заявка появится.
--
-- Функция `payment_apply_activation` — единственное место, где оплаченный счёт включает
-- подписку: в одной транзакции блокирует счёт и пользователя, сверяет, что paid_until
-- пользователя не менялся с момента расчёта (p_expected_prev), записывает новый срок и
-- закрывает счёт. Повторный вызов по тому же счёту ничего не меняет ('already').
--
-- Права и RLS — как у остальных служебных таблиц: читает и пишет только серверный код
-- с ключом service role (на Beget роль запросов — владелец базы, отдельные GRANT не нужны).
--
-- ПРИМЕНЯТЬ: /root/dbmove/pq.sh -f supabase/migrations/20261020000026_payment_invoices.sql
-- (после — перечитать схему PostgREST: systemctl kill -s SIGUSR1 tenderfit-postgrest;
-- в конце файла для этого же отправляется NOTIFY). Идемпотентна: повтор ничего не ломает.

create sequence if not exists public.payment_invoice_number_seq;

create or replace function public.payment_next_invoice_number()
returns text
language sql
as $$
  select 'ТФ-' || lpad(nextval('public.payment_invoice_number_seq')::text, 4, '0');
$$;

create table if not exists public.payment_invoices (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  plan text not null,
  amount_rub numeric(12, 2) not null check (amount_rub > 0),
  months integer not null default 1 check (months between 1 and 36),
  status text not null default 'issued'
    check (status in ('issued', 'paid', 'cancelled', 'expired')),
  method text not null check (method in ('invoice', 'sbp_claim')),

  buyer_inn text,
  buyer_kpp text,
  buyer_name text,
  -- Куда Точка отправила счёт.
  buyer_email text,

  invoice_number text,
  tochka_document_id text,
  tochka_payment_ref text,

  paid_at timestamptz,
  activated_until timestamptz,

  -- Закрывающий документ (акт): создан и отправлен после оплаты.
  closing_document_id text,
  closing_sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Последний ответ Точки о статусе (малый JSON: статус и когда спросили).
  raw_last_status jsonb
);

create unique index if not exists payment_invoices_number_uidx
  on public.payment_invoices (invoice_number) where invoice_number is not null;
create unique index if not exists payment_invoices_document_uidx
  on public.payment_invoices (tochka_document_id) where tochka_document_id is not null;
create unique index if not exists payment_invoices_payment_ref_uidx
  on public.payment_invoices (tochka_payment_ref) where tochka_payment_ref is not null;
create index if not exists payment_invoices_user_created_idx
  on public.payment_invoices (user_email, created_at desc);
create index if not exists payment_invoices_status_created_idx
  on public.payment_invoices (status, created_at);

comment on table public.payment_invoices is
  'Счета на оплату подписки (через Точку) и заявки об оплате по СБП-QR. Читает и пишет только серверный код.';

alter table public.payment_invoices enable row level security;

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  -- Уникальный ключ события: paymentId / operationId банка либо «b2b:<sha256 токена>».
  ref text not null unique,
  -- payment — по реквизитам; sbp — по QR; sbp_b2b — по B2B QR.
  kind text not null check (kind in ('payment', 'sbp', 'sbp_b2b')),
  amount_rub numeric(14, 2) not null,
  purpose text,
  payer_inn text,
  payer_name text,
  received_at timestamptz not null default now(),
  -- Событие разобрано (сопоставлено, проигнорировано или отправлено владельцу).
  processed_at timestamptz,
  -- activated | already_paid | unmatched | ambiguous | amount_mismatch | ignored | error
  outcome text,
  matched_invoice_id uuid references public.payment_invoices (id),
  -- Тело вебхука без секретов (подпись не хранится).
  raw jsonb
);

create index if not exists payment_events_pending_idx
  on public.payment_events (received_at) where processed_at is null;
create index if not exists payment_events_unmatched_sbp_idx
  on public.payment_events (received_at) where outcome = 'unmatched' and kind in ('sbp', 'sbp_b2b');

comment on table public.payment_events is
  'Журнал входящих событий банка (вебхуки Точки): идемпотентность и поздняя пара для платежей по QR.';

alter table public.payment_events enable row level security;

create or replace function public.payment_apply_activation(
  p_invoice_id uuid,
  p_ref text,
  p_new_until timestamptz,
  p_expected_prev timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
as $$
declare
  inv public.payment_invoices;
  usr public.app_users;
begin
  select * into inv from public.payment_invoices where id = p_invoice_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if inv.activated_until is not null then
    return jsonb_build_object('result', 'already', 'activated_until', inv.activated_until);
  end if;
  -- Позднюю оплату просроченного счёта принимаем: деньги настоящие.
  if inv.status not in ('issued', 'expired') then
    return jsonb_build_object('result', 'not_payable', 'status', inv.status);
  end if;

  select * into usr from public.app_users where lower(email) = lower(inv.user_email) for update;
  if not found then
    return jsonb_build_object('result', 'no_user');
  end if;

  -- Срок пользователя изменился после расчёта (другой счёт, grant-access): пусть вызывающий пересчитает.
  if not (
    (usr.paid_until is null and p_expected_prev is null)
    or (
      usr.paid_until is not null and p_expected_prev is not null
      and abs(extract(epoch from (usr.paid_until - p_expected_prev))) < 0.01
    )
  ) then
    return jsonb_build_object('result', 'conflict', 'paid_until', usr.paid_until);
  end if;

  update public.app_users set paid_until = p_new_until, plan = inv.plan where id = usr.id;
  update public.payment_invoices
     set status = 'paid',
         paid_at = p_now,
         tochka_payment_ref = p_ref,
         activated_until = p_new_until,
         updated_at = p_now
   where id = inv.id;
  return jsonb_build_object('result', 'applied', 'activated_until', p_new_until);
end;
$$;

-- PostgREST: подхватить новые таблицы и функции без перезапуска.
notify pgrst, 'reload schema';
