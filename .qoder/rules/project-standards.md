# Стандарты проекта «ТендерФит AI»

- TypeScript strict mode, `noUncheckedIndexedAccess`. `any` запрещён (ESLint `no-explicit-any: error`); `unknown` + сужение типа.
- Все строки интерфейса — на русском. Даты дд.мм.гггг, время с пометкой МСК, суммы в ₽ (`src/utils/format.ts`).
- Бизнес-статусы — union string types, не enum (`src/domain/enums`).
- Именование: сущности — PascalCase, функции — camelCase, файлы модулей домена — camelCase, компоненты — PascalCase.
- Импорты только через алиас `@/*` → `./src/*`.
- Компоненты не импортируют mock-данные напрямую — только через services/repositories.
- Любые демо-данные помечаются как вымышленные; реальные персональные данные запрещены.
- Обязательный дисклеймер (`DISCLAIMER` из `src/lib/labels.ts`) на всех экранах с вердиктами/оценками.
- Форматирование — Prettier (`.prettierrc.json`); перед коммитом должны проходить `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- Не оставлять заглушки без явного обозначения: либо TODO с описанием, либо запись в `docs/ROADMAP.md` («Известные ограничения»).
