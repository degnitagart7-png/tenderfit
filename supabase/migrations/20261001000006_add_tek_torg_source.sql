-- 20261001000006_add_tek_torg_source.sql
-- Источник «ТЭК-Торг» (api.tektorg.ru):
--   1. значение TEK_TORG в tenders.data_source;
--   2. значение tektorg_api в tender_documents.source_type.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Проект zeypawygxijctavhasyn (Stockholm).
-- Зависит от 20260921000003_add_kontur_source.sql — применяйте по порядку.
--
-- Новых колонок и таблиц не нужно: raw_data и synced_at добавлены миграцией
-- Контур.Закупок и пригодятся любому источнику, а кэш сырых ответов ТЭК-Торгу
-- не нужен — экспорт бесплатный, повторный запрос ничего не стоит и не расходует
-- чужой тариф (в отличие от Контур.Закупок, где кэш бережёт 30 запросов в сутки).
--
-- Оба ограничения расширяются одним файлом намеренно: закупка и её документы
-- приходят из одного источника, и применение только первой половины означало бы,
-- что строки в tenders появляются, а документы к ним не сохраняются.
--
-- Порядок применения важен в обе стороны. Если применить миграцию раньше кода —
-- не случится ничего: значения TEK_TORG в базе просто не появятся. Если
-- запустить прогон с подключённым источником раньше миграции — upsert упадёт на
-- CHECK-ограничении. Поэтому сначала эта миграция, потом деплой воркера.

-- ============================ 1. tenders.data_source ============================

-- Имя CHECK-ограничения генерируется автоматически, поэтому ищем его через
-- pg_constraint: migration 000001 создала ограничение inline, 000002 и 000003
-- пересоздавали его под именем tenders_data_source_check, а полагаться на имя
-- значит ломать применение на базе, где оно другое.
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
  check (data_source in ('MOCK', 'EIS', 'IMPORT', 'SBER_AST', 'KONTUR', 'TEK_TORG'));

comment on column public.tenders.data_source is
  'Источник данных: MOCK (демо), EIS (ЕИС), IMPORT (импорт), SBER_AST (Сбербанк-АСТ), KONTUR (Контур.Закупки), TEK_TORG (ТЭК-Торг)';

comment on constraint tenders_data_source_check on public.tenders is
  'Источник строки. TEK_TORG добавлен 01.10.2026: бесплатный SOAP-экспорт процедур, документация отдаётся байтами без ключа.';

-- ============================ 2. tender_documents.source_type ============================

-- Документы ТЭК-Торга скачиваются с площадки, а не из реестра, поэтому писать их
-- как eis_api значило бы врать о происхождении текста: карточка показывает
-- источник документа, и по нему владелец понимает, где проверять оригинал.
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
      and rel.relname = 'tender_documents'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%source_type%'
  loop
    execute format('alter table public.tender_documents drop constraint %I', cons.conname);
  end loop;
end $$;

alter table public.tender_documents
  add constraint tender_documents_source_type_check
  check (source_type in
    ('torgi_open_data', 'eis_api', 'manual_upload', 'kontur_api', 'tektorg_api'));

comment on constraint tender_documents_source_type_check on public.tender_documents is
  'Откуда пришёл файл. tektorg_api добавлен 01.10.2026: SOAP-экспорт ТЭК-Торга отдаёт адреса байтов вместе со списком процедур.';

-- ============================ 3. Доступ ============================

-- Права и RLS не настраиваем: колонка уже существует, а читают и пишут её только
-- серверный код через SUPABASE_SERVICE_ROLE_KEY (src/lib/supabase.ts) и скрипт
-- синхронизации на российском сервере.
