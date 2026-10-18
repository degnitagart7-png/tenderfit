# Архитектурные правила

Слои (зависимости только сверху вниз):

```
app/ (страницы-обёртки, metadata)
components/ (UI, "use client")
hooks/ → services/ → adapters/ + repositories/ → mocks/ + lib/storage
domain/ (чистые типы и функции — без React, localStorage, сети)
```

- `domain/` не импортирует ничего из вышележащих слоёв. Скоринг и фильтрация — чистые функции: одинаковый вход → одинаковый выход, без Date.now() внутри (время передаётся параметром).
- Внешние интеграции — только через интерфейсы `src/adapters/types.ts` (TenderSourceAdapter, DocumentExtractor, TenderAnalysisProvider, NotificationProvider, CompanyDataProvider). Новая интеграция = новая реализация интерфейса, UI не меняется.
- Реальный адаптер ЕИС (fetch/cheerio) — только серверный код (scripts/API-routes), никогда не в клиентских компонентах.
- Репозитории инкапсулируют хранилище: сейчас localStorage (`src/lib/storage.ts`, SSR-safe), позже Supabase/PostgreSQL — сигнатуры методов сохраняются.
- Страница = тонкая обёртка + view-компонент; не создавать компоненты страниц-гигантов: разделять UI / бизнес-логику / доступ к данным / расчёт оценки.
- Результат анализа всегда валидируется `tenderAnalysisSchema.parse()` до передачи в UI.
- Секретные ключи в клиентском коде запрещены; `NODE_TLS_REJECT_UNAUTHORIZED=0` — только разовые локальные команды, никогда в коде.
