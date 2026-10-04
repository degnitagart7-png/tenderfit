# Дизайн: Пайплайн анализа документации

**Дата:** 2026-09-21
**Статус:** черновик на согласовании

---

## 1. Цель и контекст

TenderFit AI сейчас анализирует закупки по метаданным (предмет, цена, сроки, требования). Документы (PDF, DOCX, XLSX) скачиваются, но их содержимое не анализируется — используется только `document.text` из mock-данных.

Этот пайплайн добавляет:
- Скачивание реальных документов из torgi.gov.ru (open data) и ЕИС API
- Парсинг содержимого (PDF → текст, DOCX → текст, XLSX → текст)
- AI-анализ каждого документа через OpenRouter (`google/gemini-2.5-flash`)
- Пересчёт вердикта на основе findings из документов
- Фоновую обработку через Vercel Cron + API routes
- Хранение в Supabase (Postgres + Storage)

---

## 2. Архитектура и источники данных

### Источники документов

**torgi.gov.ru Open Data API** — структурированные JSON-дампы:
- `notice` — извещения о закупках (метаданные, предметы, сроки)
- `protocol` — протоколы рассмотрения и подведения итогов
- `contract` — договоры и исполнения
- `organization` — данные заказчиков
- `masterData` — справочники (виды торгов, регионы, формы собственности)
- `privatizationPlans`, `estateLists`, `unscrupulousParticipants` — специализированные реестры

Все данные обновляются ежедневно через 2026-09-21. Формат: JSON-файлы с URL-ами на structure + data.

**ЕИС API (api.zakupki.gov.ru)** — для скачивания прикреплённых документов (PDF, DOCX, XLSX). Требует авторизации (см. `docs/ACCESS_EIS.md`). Rate limit: 3 req/sec, кэш 5 мин для feed, 24 часа для card.

### Поток данных

```
torgi.gov.ru → JSON → Supabase (raw_json) → парсинг → parsed_text
ЕИС API → файлы → Supabase Storage → парсинг → parsed_text
                                                         ↓
                                              OpenRouter (Gemini 2.5 Flash)
                                                         ↓
                                              document_analyses (findings)
                                                         ↓
                                              verdict_history (вердикт)
```

### Адаптеры (уже заложены в `src/adapters/types.ts`)

- `TenderSourceAdapter` — получение закупок и документов → реализуем `TorgiOpenDataAdapter` + `EisTenderSourceAdapter`
- `DocumentExtractor` — извлечение текста → реализуем `RealDocumentExtractor` (pdf-parse, mammoth, xlsx)
- `TenderAnalysisProvider` — анализ → реализуем `OpenRouterAnalysisProvider`

---

## 3. Модель данных (Supabase / PostgreSQL)

### Таблица: `tender_documents`

Хранилище всех документов, привязанных к закупкам. Единая таблица для структурированных данных (torgi.gov.ru JSON) и файлов (ЕИС API, ручная загрузка).

```sql
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

-- Тригер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_tender_documents_updated_at
  BEFORE UPDATE ON tender_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**Ключевые решения:**
- `raw_json` — для torgi.gov.ru: храним оригинальный JSON, парсинг не нужен (уже структурировано).
- `parsed_text` — для файлов: результат работы pdf-parse / mammoth / xlsx.
- `content_hash` — если документ с таким хешем уже распарсен, берём результат из кэша, не парсим повторно.
- `parsed_sections` — опциональная разбивка по заголовкам (если удалось определить структуру документа).

### Таблица: `document_analyses`

Каждый AI-анализ документа. Одна запись = один вызов OpenRouter.

```sql
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
```

**Структура `analysis` (JSONB):**

```json
{
  "findings": [
    {
      "category": "blocker" | "risk" | "requirement" | "neutral",
      "title": "Краткое описание",
      "detail": "Подробности",
      "evidence_quote": "Цитата из документа",
      "evidence_section": "Раздел документа",
      "severity": "high" | "medium" | "low"
    }
  ],
  "summary": "Общее резюме по документу"
}
```

### Таблица: `analysis_jobs`

Очередь фоновых задач. Cron кладёт задачу, воркер забирает.

```sql
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
```

**Механизм блокировки задач (предотвращение race condition):**

Воркер забирает задачу атомарно:

```sql
UPDATE analysis_jobs
SET status = 'processing', started_at = now(), updated_at = now()
WHERE id = (
  SELECT id FROM analysis_jobs
  WHERE status = 'pending'
  ORDER BY priority DESC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` блокирует выбранную строку и пропускает уже заблокированные другими воркерами. Это предотвращает двойную обработку одной задачи.

### Таблица: `verdict_history`

Лог изменений вердиктов. Показываем пользователю: «было RECOMMENDED → стало MANUAL_REVIEW после анализа документа X».

```sql
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
```

### Связи между таблицами

```
tender_documents (1) ──< (N) document_analyses
                                       │
                                       └──< verdict_history (N)
                                                │
analysis_jobs ──────────────────────────────────┘
                    (tender_id, не FK)
```

- `tender_documents` → `document_analyses`: один документ может анализироваться несколько раз (при reanalyze).
- `document_analyses` → `verdict_history`: каждый анализ может изменить вердикт.
- `analysis_jobs` связан по `tender_id` (не FK, чтобы не усложнять), отслеживает прогресс обработки закупки.

---

## 4. Парсинг документов

Конвейер извлечения текста после скачивания файла:

| Тип файла | Библиотека | Результат |
|-----------|-----------|-----------|
| PDF | `pdf-parse` (обёртка над pdfjs-dist) | Текст постранично. Если нет текстового слоя → `parsed_status = 'needs_ocr'` |
| DOCX | `mammoth` | HTML → cheerio вычищает разметку → текст |
| XLSX | `xlsx` (SheetJS) | Каждая таблица → «строка: значение1 \| значение2 \| ...» |
| ZIP | Рекурсивная распаковка | Каждый файл внутри прогоняется через конвейер по расширению |

**Кэширование:** после извлечения текста считаем SHA-256 → `content_hash`. Если в `tender_documents` уже есть запись с таким хешем и `parsed_status = 'parsed'` — берём `parsed_text` оттуда, не парсим повторно.

**Лимиты:** если документ > 100K символов — разбиваем на чанки по `parsed_sections` (если есть) или по размеру. Каждый чанк анализируется отдельно, findings агрегируются.

---

## 5. AI-анализ через OpenRouter

**Модель:** `google/gemini-2.5-flash` (выбрана пользователем: свежая, дешёвая).

**Промпт:** на вход даём:
- Текст документа (или чанка)
- Контекст закупки: номер, предмет, заказчик, цена, сроки
- Профиль компании (capabilities, restrictions, licenses)

**Ожидаемый ответ (структурированный JSON):**

```json
{
  "findings": [
    {
      "category": "blocker",
      "title": "Требуется лицензия ФСБ",
      "detail": "В документации указано требование наличия лицензии ФСБ на работу с шифровальными средствами",
      "evidence_quote": "Участник должен иметь лицензию ФСБ №...",
      "evidence_section": "Раздел 3. Требования к участникам",
      "severity": "high"
    }
  ],
  "summary": "Документация содержит требование лицензии ФСБ, что может быть блокирующим фактором"
}
```

**Обработка ответа:**
1. Валидация через Zod-схему (совместима с существующей `tenderAnalysisSchema` из `src/domain/schemas/index.ts`).
2. Каждый finding конвертируется в `Evidence` + соответствующую сущность (`HardBlocker`, `ContractRisk`, `TenderRequirement`).
3. `evidence_quote` → `evidence.quote`, `evidence_section` → `evidence.section`.

**Лимиты и стоимость:**
- Максимум ~100K символов на запрос (с запасом для промпта + ответа).
- Токены и стоимость логируем в `document_analyses.tokens_used` и `processing_time_ms`.
- При ошибке API — retry 2 раза с exponential backoff, затем `status = 'failed'`.

---

## 6. Вердикт-движок

Пересчёт вердикта после анализа всех документов закупки:

1. Берём существующий вердикт из метаданных (то, что считает `mockTenderAnalysisProvider`).
2. Агрегируем findings из всех `document_analyses` по этой закупке.
3. Правила:
   - Есть `category: "blocker"` + `severity: "high"` → `NOT_RECOMMENDED` (независимо от предыдущего).
   - Есть `category: "risk"` + `severity: "high"` или несколько `medium` → `MANUAL_REVIEW`.
   - Нет blockers/risks → вердикт не ухудшается.
   - **AI-анализ может только ухудшить вердикт, не улучшить** (мета-анализ остаётся базой).
4. Все изменения → `verdict_history` с `reason` и `triggered_by = 'document_analysis'`.

---

## 7. UI-триггеры и фоновая обработка

### Триггеры запуска анализа

**Автоматический:** когда закупка переходит в стадию «Интересные» (`PipelineStatus.INTERESTING`) в пайплайне → API-роут `POST /api/analysis/trigger` ставит задачу в `analysis_jobs` со `status = 'pending'`.

**Ручной:** кнопка «Анализировать документы» на странице закупки → тот же API-роут, но с `priority = 10` (выше приоритет).

### Фоновая обработка

**Vercel Cron** каждые 5 минут → `GET /api/analysis/worker`:
1. Атомарно забирает одну задачу из `analysis_jobs` со `status = 'pending'` через `SELECT ... FOR UPDATE SKIP LOCKED` (см. секцию 3), сортировка по `priority DESC, created_at ASC`.
2. Обновляет `status = 'processing'`, `started_at = now()`.
3. Для каждого документа закупки:
   - Если `parsed_status = 'pending'` → парсит, обновляет `parsed_text`, `content_hash`.
   - Если `content_hash` уже есть в кэше → берёт из кэша.
   - Вызывает OpenRouter, сохраняет результат в `document_analyses`.
   - Обновляет `documents_processed++`.
4. После всех документов → пересчитывает вердикт, пишет в `verdict_history`.
5. Обновляет `status = 'completed'`, `finished_at = now()`.

**Лимиты Vercel:** один вызов = одна закупка, таймаут 60 секунд (serverless). Если не успевает — задача остаётся `processing`, cron подхватит и продолжит (проверит `documents_processed < documents_total`).

**Восстановление зависших задач:** если задача в статусе `processing` более 10 минут без обновления `updated_at` — cron сбрасывает её обратно в `pending` (обновляет `status = 'pending'`, `updated_at = now()`), чтобы воркер мог её перезабрать.

### Статус в UI

На карточке закупки показываем:
- Иконка прогресса: «Документы: 3/5 проанализировано».
- Вердикт с индикатором изменения: «RECOMMENDED → MANUAL_REVIEW (после анализа)».
- Клик → модалка со списком findings из документов (с цитатами и ссылками на разделы).

---

## 8. Зависимости и конфигурация

### Новые npm-пакеты

```json
{
  "@supabase/supabase-js": "^2.45.0",
  "pdf-parse": "^1.1.1",
  "mammoth": "^1.8.0",
  "xlsx": "^0.18.5",
  "jszip": "^3.10.1"
}
```

### Переменные окружения (уже есть в `.env.local`)

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.5-flash
EIS_BASE_URL=https://zakupki.gov.ru
EIS_RATE_LIMIT_PER_SEC=3
```

### Supabase Storage

Bucket `tender-documents` для скачанных файлов (PDF, DOCX, XLSX). Политика: приватный доступ, чтение только через service_role_key.

---

## 9. Ограничения и будущие улучшения

**Не делаем в этой итерации:**
- OCR для скан-образов PDF (помечаем `needs_ocr`, но не обрабатываем).
- Анализ таблиц в PDF (только текстовые слои).
- Прямой SOAP API ЕИС (требует ЭЦП, используем open data + REST).
- Улучшение вердикта на основе AI (только ухудшение).

**Будущие улучшения:**
- OCR через Tesseract.js или внешний сервис для скан-образов.
- Агрегация findings по нескольким закупкам (паттерны заказчиков).
- A/B тестирование промптов (разные версии промпта → сравнение качества findings).
- Экспорт отчёта по анализу в PDF для пользователя.

---

## 10. Критерии приёмки

1. Закупка переходит в «Интересные» → в течение 10 минут документы скачаны, распарсены, проанализированы.
2. Вердикт обновляется, если AI нашёл blocker или risk.
3. В UI виден прогресс анализа и findings с цитатами.
4. Повторный анализ той же закупки не вызывает повторного парсинга (кэш по `content_hash`).
5. Токены и стоимость логируются, не превышают бюджет (настраивается через env).
6. Все существующие mock-данные и UI продолжают работать (обратная совместимость).
