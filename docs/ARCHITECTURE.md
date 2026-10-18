# Архитектура

## Слои

```
UI (app/, components/)
  → hooks (useTenderData)
    → services (tenderService)
      → adapters (интерфейсы + mock-реализации)
        → repositories (localStorage) → mocks (демо-данные)
domain/ — чистые функции и типы, не зависят от React и хранилищ
```

Ключевое правило: компоненты не импортируют mock-данные напрямую — только через services/repositories. Замена mock на реальный источник (PostgreSQL/Supabase/ЕИС API) не должна затрагивать UI.

## Интерфейсы будущих интеграций (`src/adapters/types.ts`)

| Интерфейс | Назначение | Mock | Реальная реализация |
| --- | --- | --- | --- |
| `TenderSourceAdapter` | получение закупок, документов, изменений | `mockTenderSourceAdapter` | `EisTenderSourceAdapter` (рабочий, серверный, см. ACCESS_EIS.md) |
| `DocumentExtractor` | извлечение текста/таблиц, тип документа, страницы | `mockDocumentExtractor` | будущий (pdf-parse / OCR) |
| `TenderAnalysisProvider` | анализ закупки vs профиль | `mockTenderAnalysisProvider` (детерминированный) | будущий LLM-провайдер |
| `NotificationProvider` | отчёт, срочные, изменения, дедлайны | `mockNotificationProvider` | будущий email/Telegram |
| `CompanyDataProvider` | профиль, лицензии, СРО, каталог, опыт | `mockCompanyDataProvider` | будущий (ЕИС/внешние) |

## Скоринг

`src/domain/scoring/` — чистые функции без React: матчинг capabilities (`matching.ts`), пять показателей, hard blockers, uncertainties, contract risks, `deriveVerdict`. Детали весов и правил — в SPEC.md. Все решения воспроизводимы: одинаковый вход → одинаковый вердикт.

## Данные и состояние

- Демо-закупки: `src/mocks/tenders.ts` (27 шт., даты относительны к `Date.now()`).
- Пользовательские данные (профиль, воронка, настройки, обратная связь, профили поиска, задания, auth, черновик онбординга): localStorage через `src/lib/storage.ts` (SSR-safe).
- Репозитории отдают демо-значение по умолчанию при пустом хранилище.

## Рендеринг

Next.js 14 App Router. Страницы-обёртки серверные (metadata), содержимое — клиентские компоненты (`"use client"`), т.к. данные читаются из localStorage. Роут-группа `(app)` задаёт общий shell с сайдбаром.

## Спорные решения и их разрешение

1. **Источник данных**: для MVP — mock; реальный доступ к ЕИС доказан отдельным скриптом/адаптером (парсинг HTML, ~3 req/s, retry на пустых ответах Varnish). SOAP API ЕИС требует ЭЦП — отложен до подтверждения бизнес-модели.
2. **AI-анализ**: детерминированные правила вместо LLM — воспроизводимость, нулевая стоимость, тестируемость. LLM подключается позже за `TenderAnalysisProvider` без изменения UI.
3. **Хранилище**: localStorage вместо БД — быстрая демонстрация; миграция на Supabase/PostgreSQL заложена слоем репозиториев.
4. **Регион в реальном фиде ЕИС** отсутствует в карточке выдачи — адаптер помечает «Не указан»; полное решение — дозагрузка страницы закупки.
