-- 20261019000025_add_etpgpb_source.sql
-- Источник «ЭТП ГПБ» (etpgpb.ru, площадка Газпромбанка): значение ETP_GPB в tenders.data_source.
--
-- ПРИМЕНЯЕТСЯ НА БОЕВОЙ БАЗЕ ЧЕРЕЗ `/root/dbmove/pq.sh -f 20261019000025_add_etpgpb_source.sql`
-- на VPS. Боевая база с 18.10.2026 — Beget Cloud PostgreSQL 16 (обычный
-- Postgres, без ролей Supabase), поэтому файл написан простым SQL: ролей `anon` и
-- `authenticated` и политик RLS здесь нет. Supabase SQL editor и Supabase CLI для этого
-- файла не нужны.
-- Зависит от 20261002000008_add_fabrikant_source.sql и, через него, от всей цепочки
-- миграций источников (SBER_AST, KONTUR, TEK_TORG, ROSELTORG, FABRIKANT) — применяйте по
-- порядку: ограничение пересоздаётся целиком, и список значений ниже включает все
-- прежние. Применение этого файла раньше предыдущих означало бы, что следующий из них
-- запишет список уже без ETP_GPB.
--
-- Новых колонок и таблиц не нужно: адаптер ничего не пишет в raw_data (сырая карточка
-- содержит ФИО, телефоны и почту сотрудников, и хранить её нельзя), а карты сайта и
-- карточки лежат в файловом кэше воркера (data/etpgpb-*.json), а не в базе.
--
-- ВАЖНО: значение etpgpb_api в tender_documents.source_type НЕ добавляется, и это не
-- забывчивость. Ссылки на файлы процедур ведут на etp.gpb.ru/file/get/…, а robots.txt
-- хостов etp.gpb.ru и com.etpgpb.ru — `Disallow: /` (проверено 19.10.2026). Письменное
-- согласие площадки превращает источник в документированный — тогда нужны и это
-- значение, и `documents: "bytes"` в каталоге. Причина записана в src/domain/sources.ts
-- (поле documentsReason) и печатается загрузчиком документации.
--
-- Порядок применения важен в обе стороны. Если применить миграцию раньше кода — не
-- случится ничего: значения ETP_GPB в базе просто не появятся. Если запустить прогон с
-- подключённым источником раньше миграции — CHECK-ограничение отклонит каждую строку
-- источника: scripts/sync-eis.ts ловит ошибку записи построчно, печатает «✗ <номер>: …»,
-- считает её в итоговое «N ошибок» и продолжает, поэтому остальные площадки сохранятся, а
-- ЭТП ГПБ не принесёт ни строки. Целиком прогон не падает, но источник перечислен во
-- всех трёх профилях scripts/sync-profiles.json и входит в набор по умолчанию, поэтому
-- журнал заполнится ошибками записи. Сначала эта миграция, потом деплой воркера. Если
-- миграцию применить нельзя, источник выключается переменной SYNC_ETPGPB_DISABLED=1.

-- ============================ tenders.data_source ============================

-- Имя CHECK-ограничения генерируется автоматически, поэтому ищем его через
-- pg_constraint: миграция 000001 создала ограничение inline, последующие пересоздавали
-- его под именем tenders_data_source_check, а полагаться на имя значит ломать применение
-- на базе, где оно другое.
do $$
declare
  cons record;
begin
  for cons in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'tenders'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%data_source%'
  loop
    execute format('alter table public.tenders drop constraint %I', cons.conname);
  end loop;
end $$;

alter table public.tenders
  add constraint tenders_data_source_check
  check (data_source in
    ('MOCK', 'EIS', 'IMPORT', 'SBER_AST', 'KONTUR', 'TEK_TORG', 'ROSELTORG', 'FABRIKANT', 'ETP_GPB'));

comment on column public.tenders.data_source is
  'Источник данных: MOCK (демо), EIS (ЕИС), IMPORT (импорт), SBER_AST (Сбербанк-АСТ), KONTUR (Контур.Закупки), TEK_TORG (ТЭК-Торг), ROSELTORG (Росэлторг), FABRIKANT (Фабрикант), ETP_GPB (ЭТП ГПБ)';

comment on constraint tenders_data_source_check on public.tenders is
  'Источник строки. ETP_GPB добавлен 19.10.2026: карта сайта и карточки etpgpb.ru без ключа и без query-строк (robots.txt), корпоративные и коммерческие закупки, документация недоступна. Список значений обязан совпадать с TenderDataSource (src/types/database.ts) и каталогом SOURCES (src/domain/sources.ts).';

-- ============================ Доступ ============================

-- Права и RLS не настраиваем: колонка уже существует, а читает и пишет её серверный код
-- и скрипт синхронизации на российском сервере.
