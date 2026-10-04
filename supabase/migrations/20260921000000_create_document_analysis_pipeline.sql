-- Migration: Document Analysis Pipeline Schema
-- Description: Creates tables for document storage, AI analysis, job queue, and verdict history
-- Date: 2026-09-21

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Table: tender_documents
-- Stores all documents associated with tenders (torgi.gov.ru JSON, ЕИС API files, manual uploads)
CREATE TABLE tender_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id TEXT NOT NULL,                    -- regNumber закупки
  source_type TEXT NOT NULL CHECK (source_type IN ('torgi_open_data', 'eis_api', 'manual_upload')),
  filename TEXT NOT NULL,                     -- исходное имя файла
  document_type TEXT NOT NULL CHECK (document_type IN ('notice', 'protocol', 'contract', 'attachment', 'other')),
  file_url TEXT,                              -- URL для скачивания (ЕИС) или путь в Storage
  raw_json JSONB,                             -- структурированные данные torgi.gov.ru
  file_size INTEGER CHECK (file_size >= 0),   -- размер файла в байтах
  mime_type TEXT,                             -- 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', etc.
  download_status TEXT DEFAULT 'pending' CHECK (download_status IN ('pending', 'downloading', 'downloaded', 'failed')),
  parsed_status TEXT DEFAULT 'pending' CHECK (parsed_status IN ('pending', 'parsing', 'parsed', 'needs_ocr', 'failed')),
  parsed_text TEXT,                           -- извлечённый текст
  parsed_sections JSONB,                      -- разбивка по разделам: [{title, level, text, tables}]
  content_hash TEXT,                          -- SHA-256 от parsed_text для кэша парсинга
  error_message TEXT,                         -- текст ошибки, если status = 'failed'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tender_documents_tender_id ON tender_documents(tender_id);
CREATE INDEX idx_tender_documents_content_hash ON tender_documents(content_hash);
CREATE INDEX idx_tender_documents_parsed_status ON tender_documents(parsed_status);

CREATE TRIGGER trigger_tender_documents_updated_at
  BEFORE UPDATE ON tender_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Table: document_analyses
-- Stores each AI analysis result (one row = one OpenRouter API call)
CREATE TABLE document_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id TEXT NOT NULL,
  document_id UUID REFERENCES tender_documents(id) ON DELETE CASCADE,
  model_used TEXT NOT NULL,                   -- 'google/gemini-2.5-flash'
  analysis JSONB NOT NULL,                    -- результат AI: {findings: [...], summary: "..."}
  verdict_before TEXT,                        -- вердикт закупки ДО этого анализа
  verdict_after TEXT,                         -- вердикт закупки ПОСЛЕ этого анализа
  old_score INTEGER,                          -- fitScore до
  new_score INTEGER,                          -- fitScore после
  confidence_score NUMERIC(3,2) CHECK (confidence_score >= 0.00 AND confidence_score <= 1.00),
  tokens_used INTEGER CHECK (tokens_used >= 0),
  processing_time_ms INTEGER CHECK (processing_time_ms >= 0),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_document_analyses_tender_id ON document_analyses(tender_id);
CREATE INDEX idx_document_analyses_document_id ON document_analyses(document_id);
CREATE INDEX idx_document_analyses_created_at ON document_analyses(created_at);

-- Table: analysis_jobs
-- Background job queue for document processing
CREATE TABLE analysis_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('full_analysis', 'reanalyze', 'parse_only')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  priority INTEGER DEFAULT 0 CHECK (priority >= 0),  -- выше = раньше обрабатывается
  documents_total INTEGER DEFAULT 0 CHECK (documents_total >= 0),
  documents_processed INTEGER DEFAULT 0 CHECK (documents_processed >= 0),
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_analysis_jobs_status ON analysis_jobs(status);
CREATE INDEX idx_analysis_jobs_priority ON analysis_jobs(priority DESC, created_at ASC);

CREATE TRIGGER trigger_analysis_jobs_updated_at
  BEFORE UPDATE ON analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Table: verdict_history
-- Log of all verdict changes with reasons and evidence
CREATE TABLE verdict_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id TEXT NOT NULL,
  old_verdict TEXT CHECK (old_verdict IS NULL OR old_verdict IN ('RECOMMENDED', 'MANUAL_REVIEW', 'NOT_RECOMMENDED')),
  new_verdict TEXT NOT NULL CHECK (new_verdict IN ('RECOMMENDED', 'MANUAL_REVIEW', 'NOT_RECOMMENDED')),
  old_score INTEGER,
  new_score INTEGER,
  reason TEXT NOT NULL,                       -- человеческое объяснение: "Обнаружен блокирующий фактор в документе..."
  triggered_by TEXT CHECK (triggered_by IN ('document_analysis', 'metadata_analysis', 'manual_override')),
  analysis_id UUID REFERENCES document_analyses(id) ON DELETE SET NULL,  -- если анализ удалён, ссылка обнуляется (лог сохраняется)
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_verdict_history_tender_id ON verdict_history(tender_id);
CREATE INDEX idx_verdict_history_created_at ON verdict_history(created_at DESC);

-- Example query for worker to atomically claim a job (prevents race conditions)
-- UPDATE analysis_jobs
-- SET status = 'processing', started_at = now(), updated_at = now()
-- WHERE id = (
--   SELECT id FROM analysis_jobs
--   WHERE status = 'pending'
--   ORDER BY priority DESC, created_at ASC
--   FOR UPDATE SKIP LOCKED
--   LIMIT 1
-- )
-- RETURNING *;
