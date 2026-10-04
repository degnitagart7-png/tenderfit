-- 20260925000004_add_sync_jobs.sql
-- Очередь заданий для воркера с российским IP и его пульс.
--
-- Зачем: прод на Vercel стоит за рубежом, а ЕИС и её filestore зарубежные
-- адреса не пускают (проверено 24.09.2026 в обе стороны: утром выход из
-- Амстердама — HTTP 000, вечером из Одинцова — 7 файлов скачано). Поэтому
-- документацию и глубокий разбор выполняет машина в российском сегменте.
-- Кнопка «Найти новые закупки» на проде мгновенно делает платный поиск
-- Контур.Закупок (API источника с Vercel доступен), а тяжёлую часть —
-- скачивание файлов — ставит сюда, и воркер забирает задание в течение минуты.
--
-- Та же машина забирает и плановый прогон раз в два часа: задача Windows
-- «TenderFit EIS Sync» выключается после первого успешного прогона с сервера,
-- иначе закупки пропадали бы всякий раз, когда домашний ПК выключен или
-- выходит в сеть через VPN.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Проект zeypawygxijctavhasyn (Stockholm).
-- Зависит от 20260921000003_add_kontur_source.sql — применяйте по порядку.

-- ============================ 1. Очередь заданий ============================

create table if not exists public.sync_jobs (
  id uuid primary key default gen_random_uuid(),

  -- 'documents' — догрузить документацию по номерам из payload.regNumbers и
  --   разобрать очередь analysis_jobs тем же прогоном. Бесплатно: файлы отдаёт
  --   filestore ЕИС, платный запрос к Контур.Закупкам не выполняется.
  -- 'full_sync' — полный прогон (ЕИС + Сбербанк-АСТ + Контур) вне расписания.
  --   Платные поиски Контур.Закупок при этом ограничены суточным бюджетом и
  --   интервалом KONTUR_MIN_INTERVAL_HOURS, как в плановом задании.
  kind text not null check (kind in ('documents', 'full_sync')),

  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),

  -- Параметры задания. Для 'documents': {"regNumbers": ["32616407955", ...],
  -- "reason": "press"}. Пустой объект допустим: full_sync параметров не требует.
  payload jsonb not null default '{}'::jsonb,

  -- Кто поставил задание. Ролей в приложении нет, поэтому поле служит журналом,
  -- а не ограничением доступа: по нему видно, чьё нажатие потратило ресурсы.
  requested_by text,

  -- Сколько раз задание пытались выполнить. Сбой сети ЕИС не должен ронять
  -- задание навсегда: после ошибки оно возвращается в pending, а после
  -- MAX_ATTEMPTS (см. scripts/worker.ts) остаётся failed с текстом причины.
  attempts integer not null default 0 check (attempts >= 0),

  worker_id text,
  claimed_at timestamptz,
  finished_at timestamptz,

  -- Итог выполнения: {"tenders": 3, "documents": 7, "characters": 526822,
  -- "analysisJobs": 1}. Пишется целиком, а не инкрементом — так же, как
  -- documents_processed в analysis_jobs: счётчик, растущий на каждом проходе,
  -- после повторных попыток показывал бы больше, чем реально сделано.
  report jsonb,

  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Частичный индекс: воркер ищет только pending, а таблица растёт навсегда.
create index if not exists sync_jobs_pending_idx
  on public.sync_jobs (created_at)
  where status = 'pending';
create index if not exists sync_jobs_created_at_idx
  on public.sync_jobs (created_at desc);

comment on table public.sync_jobs is
  'Очередь заданий для воркера с российским IP: документация закупок и внеплановые прогоны. Ставится продом на Vercel, выполняется scripts/worker.ts.';

-- updated_at: функция уже создана в 20260921000000_create_document_analysis_pipeline.sql.
drop trigger if exists trigger_sync_jobs_updated_at on public.sync_jobs;
create trigger trigger_sync_jobs_updated_at
  before update on public.sync_jobs
  for each row execute function update_updated_at_column();

-- ============================ 2. Пульс воркера ============================

create table if not exists public.worker_heartbeat (
  -- Имя воркера: одна строка на машину. Сейчас воркер один ('ru-vps'), но ключ
  -- не единственный намеренно — второй воркер не должен ломать панель.
  worker_id text primary key,

  last_seen_at timestamptz not null default now(),

  -- Когда воркер в последний раз выполнял плановый полный прогон. Отсчёт
  -- расписания ведётся отсюда, а не от времени суток: задание может стоять на
  -- нечётных часах, и привязка к «hour % 2» сработала бы не каждый раз. Тот же
  -- принцип, что у konturLastPaidSearchAt для интервала Контур.Закупок.
  last_full_sync_at timestamptz,

  -- Адрес выхода в сеть и его страна. Единственный способ честно показать
  -- партнёру, что документация действительно качается из России: если адрес
  -- станет зарубежным, ЕИС перестанет отвечать, и это будет видно до того,
  -- как задания начнут падать.
  exit_ip text,
  exit_country text,

  host text,
  -- Версия кода воркера: после деплоя видно, подхватил ли сервер новую сборку.
  version text,

  last_job_id uuid references public.sync_jobs(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now()
);

comment on table public.worker_heartbeat is
  'Пульс воркера с российским IP. Панель показывает «на связи N мин назад» и адрес выхода; молчание дольше порога означает, что документация задерживается.';

-- ============================ 3. Доступ ============================

-- Права и RLS не настраиваем: как и остальные таблицы проекта, эти читаются и
-- пишутся только серверным кодом через SUPABASE_SERVICE_ROLE_KEY
-- (src/lib/supabase.ts) — продом на Vercel и воркером на VPS. Клиенту очередь
-- отдаётся через API-роуты, а не напрямую.
