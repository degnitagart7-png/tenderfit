-- Коммерческие торги Сбербанк-АСТ как новый источник закупок.
--
-- Закон COMMERCIAL — закупки коммерческих заказчиков (вне 44-ФЗ / 223-ФЗ / ПП РФ 615).
-- Источник SBER_AST — данные, полученные с площадки Сбербанк-АСТ
-- (секция «Торги коммерческих заказчиков»).
--
-- Применить через SQL Editor в Supabase (CLI в этом проекте не работает):
-- проект zeypawygxijctavhasyn.
--
-- Ограничения law и data_source созданы как inline CHECK в миграции
-- 20260921000001, поэтому их имена назначены базой автоматически.
-- Чтобы не угадывать имя, ищем его в pg_constraint и удаляем найденное.

-- 1) Расширяем список допустимых законов.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'public.tenders'::regclass
      AND con.contype = 'c'
      AND att.attname = 'law'
  LOOP
    EXECUTE format('ALTER TABLE public.tenders DROP CONSTRAINT %I', rec.conname);
    RAISE NOTICE 'Удалено ограничение: %', rec.conname;
  END LOOP;
END $$;

ALTER TABLE public.tenders
  ADD CONSTRAINT tenders_law_check
  CHECK (law IN ('FZ_44', 'FZ_223', 'PP_RF_615', 'COMMERCIAL'));

-- 2) Расширяем список допустимых источников данных.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'public.tenders'::regclass
      AND con.contype = 'c'
      AND att.attname = 'data_source'
  LOOP
    EXECUTE format('ALTER TABLE public.tenders DROP CONSTRAINT %I', rec.conname);
    RAISE NOTICE 'Удалено ограничение: %', rec.conname;
  END LOOP;
END $$;

ALTER TABLE public.tenders
  ADD CONSTRAINT tenders_data_source_check
  CHECK (data_source IN ('MOCK', 'EIS', 'IMPORT', 'SBER_AST'));

-- 3) Обновляем описания колонок.
COMMENT ON COLUMN public.tenders.law IS
  'Закон: FZ_44 (44-ФЗ), FZ_223 (223-ФЗ), PP_RF_615 (ПП РФ 615), COMMERCIAL (коммерческие торги)';
COMMENT ON COLUMN public.tenders.data_source IS
  'Источник данных: MOCK (демо), EIS (ЕИС), IMPORT (импорт), SBER_AST (Сбербанк-АСТ)';
COMMENT ON COLUMN public.tenders.eis_url IS
  'Ссылка на карточку закупки на площадке-источнике (ЕИС или Сбербанк-АСТ)';
COMMENT ON TABLE public.tenders IS
  'Закупки из ЕИС, Сбербанк-АСТ, CSV-импорта и ручного ввода';

-- 4) Проверка: какие ограничения действуют теперь.
SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
WHERE con.conrelid = 'public.tenders'::regclass
  AND con.contype = 'c'
  AND con.conname IN ('tenders_law_check', 'tenders_data_source_check')
ORDER BY con.conname;
