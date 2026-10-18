-- 20261002000007_add_roseltorg_source.sql
-- Источник «Росэлторг» (www.roseltorg.ru): значение ROSELTORG в tenders.data_source.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Проект zeypawygxijctavhasyn (Stockholm).
-- Зависит от 20261001000006_add_tek_torg_source.sql — применяйте по порядку:
-- ограничение пересоздаётся целиком, и применение этого файла раньше ТЭК-Торга
-- означало бы, что следующий файл запишет список уже без ROSELTORG.
--
-- Новых колонок и таблиц не нужно: raw_data и synced_at добавлены миграцией
-- Контур.Закупок и пригодятся любому источнику. Кэш сырых ответов не нужен —
-- поиск бесплатный и без ключа, повторный запрос не расходует чужой тариф.
--
-- ВАЖНО: значение roseltorg_api в tender_documents.source_type НЕ добавляется,
-- и это не забывчивость. Документацию Росэлторг не отдаёт: ссылки на файлы
-- ведут на отдельный хост com.roseltorg.ru, а его robots.txt запрещает доступ
-- роботам целиком (проверено 02.10.2026); тот же путь на www отвечает 404.
-- Значение, которое некому записать, — мёртвая строка в ограничении, а не запас
-- на будущее. Причина записана в каталоге источников (src/domain/sources.ts,
-- поле documentsReason) и печатается загрузчиком документации.
--
-- Порядок применения важен в обе стороны. Если применить миграцию раньше кода —
-- не случится ничего: значения ROSELTORG в базе просто не появятся. Если
-- запустить прогон с подключённым источником раньше миграции — CHECK-ограничение
-- отклонит каждую строку источника: scripts/sync-eis.ts ловит ошибку записи
-- построчно, печатает «✗ <номер>: …», считает её в итоговое «N ошибок» и
-- продолжает, поэтому ЕИС и Сбербанк-АСТ сохранятся, а Росэлторг не принесёт ни
-- строки. Целиком прогон не падает, но источник перечислен во всех трёх профилях
-- scripts/sync-profiles.json, поэтому журнал заполнится ошибками записи, а
-- коммерческих процедур площадка не принесёт. Сначала эта миграция, потом деплой
-- воркера.

-- ============================ tenders.data_source ============================

-- Имя CHECK-ограничения генерируется автоматически, поэтому ищем его через
-- pg_constraint: migration 000001 создала ограничение inline, последующие
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
  check (data_source in
    ('MOCK', 'EIS', 'IMPORT', 'SBER_AST', 'KONTUR', 'TEK_TORG', 'ROSELTORG'));

comment on column public.tenders.data_source is
  'Источник данных: MOCK (демо), EIS (ЕИС), IMPORT (импорт), SBER_AST (Сбербанк-АСТ), KONTUR (Контур.Закупки), TEK_TORG (ТЭК-Торг), ROSELTORG (Росэлторг)';

comment on constraint tenders_data_source_check on public.tenders is
  'Источник строки. ROSELTORG добавлен 02.10.2026: публичный серверный поиск площадки без ключа, корпоративные и коммерческие секции, документация недоступна. Список значений обязан совпадать с TenderDataSource (src/types/database.ts) и каталогом SOURCES (src/domain/sources.ts).';

-- ============================ Доступ ============================

-- Права и RLS не настраиваем: колонка уже существует, а читают и пишут её только
-- серверный код через SUPABASE_SERVICE_ROLE_KEY (src/lib/supabase.ts) и скрипт
-- синхронизации на российском сервере.
