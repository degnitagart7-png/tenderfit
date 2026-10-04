# ТендерФит AI — MVP

Демонстрационный веб-сервис поиска и объяснимого первичного анализа закупок по 44-ФЗ и 223-ФЗ. Сервис носит информационно-аналитический характер и не гарантирует допуск к закупке или победу.

> Все данные в приложении вымышленные и помечены как демонстрационные. Реального подключения к ЕИС в UI нет; работающий скрейпер ЕИС лежит отдельно в `scripts/scrape-eis.ts` (см. `docs/ACCESS_EIS.md`).

## Быстрый старт

```bash
npm install
npm run dev        # http://localhost:3000
```

Вход: кнопка «Демонстрационный доступ» на `/login` (или любые email/пароль от 6 символов). Далее — онбординг (предзаполнен демо-профилем ИП «ТехноПоставка») и дашборд.

## Команды

| Команда | Назначение |
| --- | --- |
| `npm run dev` | Дев-сервер |
| `npm run lint` | ESLint |
| `npm run typecheck` | tsc --noEmit (strict) |
| `npm test` | Vitest (однократно) |
| `npm run test:watch` | Vitest в режиме watch |
| `npm run build` | Прод-сборка Next.js |
| `npm run format` / `format:check` | Prettier |
| `npm run scrape:eis -- "запрос" N` | Реальный сбор N закупок с zakupki.gov.ru в `eis-sample.json` |
| `npx tsx scripts/check-distribution.ts` | Гейт распределения вердиктов по демо-базе: ≥5 в каждом вердикте, ≥8 по каждому закону, правила `deriveVerdict` не нарушены; при невыполнении — ненулевой код выхода |

## Переменные окружения

См. `.env.example`. Для MVP достаточно `NEXT_PUBLIC_DATA_SOURCE=mock`; переменные ЕИС нужны только для `scrape:eis`, Supabase/LLM-переменные — заглушки под будущие интеграции.

## Что реализовано (MVP)

- Авторизация-имитация, онбординг из 9 шагов с Zod-валидацией (ИНН по контрольным числам), черновик в localStorage.
- Профиль компании: возможности, hard-ограничения, лицензии, СРО, опыт, белые/чёрные списки заказчиков.
- 35 демо-закупок, покрывающих все 20 сценариев ТЗ; распределение вердиктов: 10 RECOMMENDED / 6 MANUAL_REVIEW / 19 NOT_RECOMMENDED (проверяется инвариантом, а не фиксированными числами — см. команду ниже).
- Детерминированный скоринг из 5 показателей (Subject Fit 50%, Legal Eligibility 20%, Financial Fit 15%, Operational Fit 10%, Contract Risk 5% инвертирован) и правила вердикта (`src/domain/scoring/`).
- Карточка закупки: вердикт, Fit Score, 7 вкладок, hard blockers, неопределённости, риски договора, доказательства (Evidence), следующие действия, дисклеймер, обратная связь.
- Таблица закупок: фильтры (поиск, закон, регион, цена, вердикт, срок < 24 ч, блокеры, аванс, обеспечение, профиль поиска, воронка), сортировка, пагинация, сохранённый фильтр.
- Канбан-воронка с drag-and-drop (localStorage).
- Ежедневный отчёт из 4 разделов + preview email-версии.
- Журнал фоновых заданий с имитацией конвейера «импорт → документы → текст → AI-анализ → отчёт».
- Интерфейсы будущих интеграций (TenderSourceAdapter, DocumentExtractor, TenderAnalysisProvider, NotificationProvider, CompanyDataProvider) с mock-реализациями + рабочий адаптер ЕИС (серверный).

## Что НЕ реализовано (границы MVP)

Реальное подключение к ЕИС в UI, LLM-анализ, email/Telegram-отправка, биллинг, подача заявок, ЭЦП, роли кроме OWNER, PostgreSQL/Supabase. Заглушки обозначены в `docs/ROADMAP.md`.

## Структура

```
src/
  domain/        # сущности, enum-типы, Zod-схемы, скоринг, фильтрация (чистые функции)
  adapters/      # интерфейсы интеграций + mock-реализации + реальный адаптер ЕИС
  repositories/  # доступ к данным (localStorage)
  services/      # композиция адаптеров и репозиториев
  components/    # UI: primitives, analysis, tenders, onboarding, settings, layout
  app/           # маршруты Next.js (App Router)
  mocks/         # демо-данные
scripts/         # scrape-eis.ts (реальный сбор ЕИС), check-distribution.ts
docs/            # SPEC, ARCHITECTURE, DATA_MODEL, AI_ANALYSIS_SCHEMA, ROADMAP, ACCESS_EIS
```

Документация: `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/AI_ANALYSIS_SCHEMA.md`, `docs/ROADMAP.md`, `docs/ACCESS_EIS.md`.
