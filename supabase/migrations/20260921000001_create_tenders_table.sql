-- Migration: Tenders Table for EIS Integration
-- Description: Creates table for storing procurement data from ЕИС (zakupki.gov.ru)
-- Date: 2026-09-21

-- Table: tenders
-- Stores procurement data from ЕИС, CSV imports, and manual entry
CREATE TABLE tenders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Core identification
  reg_number TEXT NOT NULL UNIQUE,            -- Реестровый номер закупки (уникальный)
  external_id TEXT,                           -- Внешний ID из ЕИС (если есть)
  law TEXT NOT NULL CHECK (law IN ('FZ_44', 'FZ_223', 'PP_RF_615')),
  placing_way TEXT NOT NULL CHECK (placing_way IN (
    'ELECTRONIC_AUCTION', 'OPEN_CONTEST',
    'REQUEST_FOR_QUOTATION', 'REQUEST_FOR_PROPOSALS',
    'SOLE_SUPPLIER', 'OTHER'
  )),
  
  -- Subject and customer
  subject TEXT NOT NULL,                      -- Предмет закупки
  customer_name TEXT NOT NULL,                -- Название заказчика
  customer_inn TEXT,                          -- ИНН заказчика
  region TEXT NOT NULL,                       -- Регион поставки
  delivery_address TEXT,                      -- Адрес поставки
  
  -- Financial terms
  price NUMERIC(15,2) CHECK (price >= 0),     -- НМЦК
  currency TEXT DEFAULT 'RUB',                -- Валюта
  advance_payment NUMERIC(5,2) CHECK (advance_payment >= 0 AND advance_payment <= 100), -- Аванс %
  security_bid NUMERIC(15,2) CHECK (security_bid >= 0), -- Обеспечение заявки
  security_contract NUMERIC(15,2) CHECK (security_contract >= 0), -- Обеспечение контракта
  
  -- Deadlines
  submission_end TIMESTAMPTZ NOT NULL,        -- Окончание подачи заявок
  publication_date TIMESTAMPTZ,               -- Дата публикации
  last_update_date TIMESTAMPTZ,               -- Последнее обновление
  delivery_term_days INTEGER CHECK (delivery_term_days >= 0), -- Срок поставки (дни)
  delivery_date_end DATE,                     -- Дата окончания поставки
  
  -- Classification
  okpd2_codes TEXT[],                         -- Коды ОКПД2 (массив)
  
  -- Complex structures as JSONB
  lots JSONB DEFAULT '[]'::jsonb,             -- Лоты: [{number, subject, price, ...}]
  requirements JSONB DEFAULT '[]'::jsonb,     -- Требования: [{type, description, ...}]
  
  -- Flags
  national_regime BOOLEAN DEFAULT FALSE,      -- Нацрежим
  only_for_smp BOOLEAN DEFAULT FALSE,         -- Только для СМП
  
  -- Links and metadata
  eis_url TEXT,                               -- Ссылка на карточку в ЕИС
  data_source TEXT NOT NULL DEFAULT 'EIS' CHECK (data_source IN ('MOCK', 'EIS', 'IMPORT')),
  change_log JSONB DEFAULT '[]'::jsonb,       -- История изменений: [{date, changes}]
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE UNIQUE INDEX idx_tenders_reg_number ON tenders(reg_number);
CREATE INDEX idx_tenders_law ON tenders(law);
CREATE INDEX idx_tenders_region ON tenders(region);
CREATE INDEX idx_tenders_submission_end ON tenders(submission_end DESC);
CREATE INDEX idx_tenders_data_source ON tenders(data_source);
CREATE INDEX idx_tenders_customer_inn ON tenders(customer_inn);
CREATE INDEX idx_tenders_okpd2_codes ON tenders USING GIN(okpd2_codes);

-- Trigger for updated_at
CREATE TRIGGER trigger_tenders_updated_at
  BEFORE UPDATE ON tenders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE tenders IS 'Закупки из ЕИС, CSV-импорта и ручного ввода';
COMMENT ON COLUMN tenders.reg_number IS 'Реестровый номер закупки (уникальный идентификатор)';
COMMENT ON COLUMN tenders.law IS 'Закон: FZ_44 (44-ФЗ), FZ_223 (223-ФЗ), PP_RF_615 (ПП РФ 615)';
COMMENT ON COLUMN tenders.placing_way IS 'Способ определения поставщика';
COMMENT ON COLUMN tenders.subject IS 'Предмет закупки (наименование)';
COMMENT ON COLUMN tenders.price IS 'НМЦК (начальная максимальная цена контракта)';
COMMENT ON COLUMN tenders.submission_end IS 'Дата и время окончания подачи заявок';
COMMENT ON COLUMN tenders.okpd2_codes IS 'Коды ОКПД2 (массив строк)';
COMMENT ON COLUMN tenders.lots IS 'Лоты закупки (JSONB массив)';
COMMENT ON COLUMN tenders.requirements IS 'Требования к участникам (JSONB массив)';
COMMENT ON COLUMN tenders.data_source IS 'Источник данных: MOCK (демо), EIS (ЕИС), IMPORT (импорт)';
