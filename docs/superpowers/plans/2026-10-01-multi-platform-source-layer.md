# Слой источников: каталог площадок и ТЭК-Торг — план реализации

> **Для исполнителя:** ОБЯЗАТЕЛЬНАЯ ПОД-НАВЫК: superpowers:subagent-driven-development
> (рекомендуется) или superpowers:executing-plans — выполнять план задача за задачей.
> Шаги помечены чекбоксами (`- [ ]`).

**Цель:** превратить «один источник, размазанный по десяти местам» в каталог, куда новая
площадка добавляется одной записью, и подключить ТЭК-Торг — бесплатный источник с
байтами документов, замену Контур.Закупкам.

**Архитектура:** факты об источнике (платный/бесплатный, отдаёт ли байты документов,
приоритет записи, входит ли в прогон по умолчанию, почему документов нет) собираются в
одну таблицу `src/domain/sources.ts`. Конструкторы адаптеров и проверки доступности — в
`src/adapters/tender-source/registry.ts`. Обе таблицы связаны одним тестом покрытия.
ТЭК-Торг добавляется тремя файлами: SOAP-конверт и разбор ответа, маппер процедуры в
`Tender`, адаптер порта `TenderSourceAdapter`. Плановый прогон идёт циклом по списку
источников профиля вместо трёх отдельных булевых флагов.

**Стек:** Next.js 14.2.15, TypeScript strict + `noUncheckedIndexedAccess`, Vitest,
`@supabase/supabase-js`, `src/lib/fsnb/xmlTokenizer.ts` (свой XML-токенайзер, новой
зависимости не добавляем).

**Спека:** `docs/superpowers/specs/2026-10-01-multi-platform-source-layer-design.md`.
Факты о живом API ТЭК-Торга и ловушки разбора: `docs/REFERENCE_TEK_TORG_API.md`.
Правила маппера в этом плане пересказаны сокращённо — при расхождении верен текст спеки,
а не плана.

---

## Важно про коммиты

**Проект не является git-репозиторием** (`git status` → `fatal: not a git repository`),
дерево одновременно правят несколько сессий. Поэтому вместо шага «commit» в каждой задаче
стоит шаг «прогнать гейт»: `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build` и `npx tsx scripts/check-distribution.ts`. Гейт прогоняется по всему
дереву, а не только по своим файлам: чужая правка, приехавшая в дерево между задачами,
должна быть замечена до деплоя, а не во время него.

Красный гейт в файле, которого задача не трогала, — не повод продолжать. Останавливаемся
и сообщаем владельцу.

---

## Структура файлов

```
Новые файлы:
  src/domain/sources.ts                              — каталог фактов об источниках
  src/domain/sources.test.ts                         — инварианты каталога
  src/services/tenderSourceRegistry.ts               — привязки: probe() и create()
  src/services/tenderSourceRegistry.test.ts          — покрытие двух таблиц
  src/adapters/tender-source/tektorgSoap.ts          — SOAP-конверт и разбор ответа
  src/adapters/tender-source/tektorgSoap.test.ts     — тесты на фикстуре живого ответа
  src/adapters/tender-source/tektorgFixtures.ts      — обрезанный живой ответ (фикстура)
  src/adapters/tender-source/tektorgMapper.ts        — процедура площадки → Tender
  src/adapters/tender-source/tektorgMapper.test.ts   — правила маппера, каждое отдельно
  src/adapters/tender-source/tektorgTenderSourceAdapter.ts  — реализация порта
  src/adapters/tender-source/tektorgTenderSourceAdapter.test.ts
  supabase/migrations/20261001000006_add_tek_torg_source.sql

Изменяемые файлы:
  src/types/database.ts:200          — union TenderDataSource += "TEK_TORG"
  src/repositories/tenderRepository.ts:89   — TENDER_SOURCE_PRIORITY ← вывод из SOURCES
  src/domain/deepAnalysis.ts:183,188 — DOCUMENTATION_SOURCES и SOURCE_REASONS ← вывод
  src/services/tenderDocumentsFetcher.ts:182 — documentationUnavailableReason ← каталог
  scripts/sync-eis.ts:101,146,234,504-532 — SYNC_SOURCES, SOURCE_PROBES, profileSources,
                                            создание адаптеров, perSource
```

Ответственность по файлам: `sources.ts` — только данные, домен не импортирует ничего
сверху; `tenderSourceRegistry.ts` — только конструкторы и проверки, домен не знает про
адаптеры; `tektorgSoap.ts` — только транспорт и XML; `tektorgMapper.ts` — только правила
переноса полей, без сети; адаптер — только склейка первых двух в порт.

Реестр лежит в `services/`, а не в `adapters/tender-source/`, как планировалось. Причина
в правилах слоёв (`.qoder/rules/architecture.md`): привязка Контур.Закупок создаёт адаптер
через `createKonturAdapter` из `@/services/konturSyncService`, а `adapters/` стоит ниже
`services/` и импортировать его не может. Реестр поставлен на тот слой, которому разрешены
оба импорта. Проверено: ни один файл в `src/adapters/` не импортирует `@/services/` и
`@/repositories/`.

---

## Задача 1: Каталог источников

**Файлы:**
- Создать: `src/domain/sources.ts`
- Создать: `src/domain/sources.test.ts`
- Изменить: `src/types/database.ts:200-205`
- Изменить: `src/repositories/tenderRepository.ts:89-95`
- Изменить: `src/domain/deepAnalysis.ts:183-197`
- Изменить: `src/services/tenderDocumentsFetcher.ts:181-198`
- Изменить: `src/domain/enums/index.ts:217-227` — вторая копия union и `TENDER_DATA_SOURCES`
- Изменить: `src/lib/labels.ts:67-83` — подпись источника в бейдже и в кнопке карточки

- [x] **Шаг 1: добавить TEK_TORG в union типа источника**

`src/types/database.ts`, строки 200-205 — добавить значение в конец union:

```ts
export type TenderDataSource =
  | "MOCK"
  | "EIS"
  | "IMPORT"
  | "SBER_AST"
  | "KONTUR"
  | "TEK_TORG";
```

Записей с таким значением в базе не появится до задачи 6 (миграция), поэтому порядок
безопасный: код впереди, данные после. `TENDER_SOURCE_PRIORITY` — `Record<TenderDataSource,
number>`, поэтому typecheck сразу покажет все места, которым нужно новое значение. Это и
есть цель шага: получить список мест от компилятора, а не поиском по строкам.

Компилятор при выполнении задачи 01.10.2026 назвал одно место, которого в плане не было,
и оно оказалось важнее остальных: `src/domain/enums/index.ts:218` держал **вторую копию**
того же union. Два типа с одним именем компилятор считает разными, поэтому значение из
типов базы не доезжало до подписей интерфейса, а `src/lib/labels.ts` (обе карты
`Record<TenderDataSource, string>` — бейдж и кнопка карточки) ключевался по копии и молча
напечатал бы `undefined` в бейдже закупки ТЭК-Торга. Правка:

```ts
// src/domain/enums/index.ts — вместо собственного объявления union
import type { TenderDataSource } from "@/types/database";
import { SOURCES } from "@/domain/sources";

export type { TenderDataSource };

/** Все площадки-источники — белый список параметра `src` в адресе ленты. */
export const TENDER_DATA_SOURCES: readonly TenderDataSource[] = SOURCES.map(
  (s) => s.source,
);
```

`TENDER_DATA_SOURCES` используется только в `src/domain/filterUrl.ts:138` — проверяет
параметр `src` в адресе ленты, — поэтому вывод из каталога не меняет интерфейс: список
площадок в фильтре строится из выдачи, а не из этого перечня. В `src/lib/labels.ts`
добавлены две подписи: `TEK_TORG: "ТЭК-Торг"` и `TEK_TORG: "Открыть в ТЭК-Торге"`.

Union `TenderLaw` в том же файле по-прежнему продублирован (`src/domain/enums/index.ts:13`
и `src/types/database.ts:192`); в этой задаче он не трогается — новых законов ТЭК-Торг не
приносит, а объединение двух перечислений разом смешало бы два разных рефакторинга.

- [x] **Шаг 2: написать падающие тесты каталога**

`src/domain/sources.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SOURCES, documentationSources, sourceFacts } from "./sources";
import type { TenderDataSource } from "@/types/database";

describe("каталог источников", () => {
  it("описывает каждое значение TenderDataSource ровно один раз", () => {
    const all: TenderDataSource[] = [
      "MOCK",
      "EIS",
      "IMPORT",
      "SBER_AST",
      "KONTUR",
      "TEK_TORG",
    ];
    const listed = SOURCES.map((s) => s.source);
    expect([...listed].sort()).toEqual([...all].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("приоритеты не повторяются: две площадки с равным весом молча перезаписали бы друг друга", () => {
    const priorities = SOURCES.map((s) => s.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it("ЕИС выше любой площадки: реестр остаётся авторитетом при совпадении номера", () => {
    const eis = sourceFacts("EIS").priority;
    for (const s of SOURCES) {
      if (s.source !== "EIS") expect(s.priority).toBeLessThan(eis);
    }
  });

  it("у источника без документов есть причина, у источника с документами её нет", () => {
    for (const s of SOURCES) {
      if (s.documents === "none") {
        expect(s.documentsReason, s.source).toBeTruthy();
      } else {
        expect(s.documentsReason, s.source).toBeNull();
      }
    }
  });

  it("платный источник не входит в прогон по умолчанию", () => {
    for (const s of SOURCES) {
      if (s.cost === "paid") expect(s.byDefault, s.source).toBe(false);
    }
  });

  it("ТЭК-Торг подключается явно, пока не применена миграция", () => {
    expect(sourceFacts("TEK_TORG").byDefault).toBe(false);
  });

  it("документацию отдают только ЕИС и Контур.Закупки", () => {
    expect(documentationSources()).toEqual(["EIS", "KONTUR"]);
  });

  it("причина отказа Сбербанк-АСТ называет площадку и КЭП", () => {
    const reason = sourceFacts("SBER_AST").documentsReason ?? "";
    expect(reason).toMatch(/Сбербанк-АСТ/);
    expect(reason).toMatch(/КЭП/);
  });

  it("причина отказа ручного импорта говорит «вручную»", () => {
    expect(sourceFacts("IMPORT").documentsReason ?? "").toMatch(/вручную/);
  });
});
```

- [x] **Шаг 3: убедиться, что тесты падают**

Выполнить: `npx vitest run src/domain/sources.test.ts`
Ожидание: ошибка «Cannot find module './sources'» или «sourceFacts is not a function».
Все девять тестов красные — модуля ещё нет.

- [x] **Шаг 4: написать каталог**

`src/domain/sources.ts`:

```ts
import type { TenderDataSource } from "@/types/database";

/** Платный источник опрашивается по своему правилу, бесплатный — каждый прогон. */
export type SourceCost = "free" | "paid";

/**
 * Отдаёт ли источник байты документов.
 *
 * `bytes` не обязательно значит «байты даёт сама площадка»: у Контур.Закупок их
 * читает ЕИС по тому же номеру извещения, бесплатно и без ключа. Важно другое —
 * документация в принципе читаема, значит глубокий разбор возможен.
 */
export type SourceDocuments = "bytes" | "none";

/** Факты об источнике, которые нужны домену и репозиторию. */
export interface SourceFacts {
  readonly source: TenderDataSource;
  /** Как источник назван в интерфейсе. */
  readonly title: string;
  readonly cost: SourceCost;
  readonly documents: SourceDocuments;
  /** Чья запись останется в upsertByRegNumber, если закупку принесли двое. */
  readonly priority: number;
  /** Входит ли в прогон, когда профиль не перечислил sources явно. */
  readonly byDefault: boolean;
  /** Почему документов нет; null, когда они есть. */
  readonly documentsReason: string | null;
}

/**
 * Единственное место, где записаны свойства источников.
 *
 * До правки 01.10.2026 факт «отдаёт ли источник документацию» лежал в трёх
 * копиях: список DOCUMENTATION_SOURCES и тексты SOURCE_REASONS в домене и
 * switch в tenderDocumentsFetcher. Компилятор не знал, что они обязаны
 * совпадать, поэтому новый источник молча получал чужой текст отказа —
 * ветка `default` в сервисе отдавала сообщение про ручную загрузку.
 */
export const SOURCES: readonly SourceFacts[] = [
  {
    source: "EIS",
    title: "ЕИС",
    cost: "free",
    documents: "bytes",
    priority: 50,
    byDefault: true,
    documentsReason: null,
  },
  {
    // Площадка-первоисточник, которая к тому же отдаёт байты документов, —
    // выше Сбербанк-АСТ, но ниже ЕИС: при совпадении номера извещения
    // авторитетнее реестр, а не площадка.
    source: "TEK_TORG",
    title: "ТЭК-Торг",
    cost: "free",
    // До задачи 7 байты не скачиваются: источник только подключается.
    documents: "none",
    priority: 45,
    byDefault: false,
    documentsReason:
      "ТЭК-Торг: источник подключается, документация ещё не загружается.",
  },
  {
    source: "SBER_AST",
    title: "Сбербанк-АСТ",
    cost: "free",
    documents: "none",
    priority: 40,
    byDefault: true,
    documentsReason:
      "Сбербанк-АСТ не отдаёт документацию: файлы лежат в карточке закупки за входом по КЭП — анализировать нечего.",
  },
  {
    source: "IMPORT",
    title: "Добавлено вручную",
    cost: "free",
    documents: "none",
    priority: 30,
    byDefault: false,
    documentsReason:
      "Закупка добавлена вручную: документация приходит вместе с файлом, который вы загрузили, в публичных источниках её нет.",
  },
  {
    source: "KONTUR",
    title: "Контур.Закупки",
    cost: "paid",
    // Агрегатор: NotificationNumber — тот же номер извещения ЕИС, ссылки Docs[]
    // ведут на filestore zakupki.gov.ru. Печатную форму и вкладку документов
    // читает ЕИС, платная карточка для этого не нужна (проверено 23.09.2026).
    documents: "bytes",
    priority: 20,
    byDefault: false,
    documentsReason: null,
  },
  {
    source: "MOCK",
    title: "Демонстрационные данные",
    cost: "free",
    documents: "none",
    priority: 10,
    byDefault: false,
    documentsReason: "Демонстрационная закупка: документы не загружаются.",
  },
];

/** Факты об источнике. Бросает ошибку, если значения нет в каталоге. */
export function sourceFacts(source: TenderDataSource): SourceFacts {
  const found = SOURCES.find((s) => s.source === source);
  if (!found) {
    // Не «вернём заглушку»: источник без фактов — это дыра в каталоге, и она
    // должна падать здесь, а не показывать пользователю пустую причину.
    throw new Error(`Источник ${source} не описан в каталоге SOURCES.`);
  }
  return found;
}

/** Источники, документация которых читаема: по ним возможен глубокий разбор. */
export function documentationSources(): TenderDataSource[] {
  return SOURCES.filter((s) => s.documents === "bytes").map((s) => s.source);
}

/** Приоритет записи по источникам — для upsertByRegNumber. */
export function sourcePriorities(): Record<TenderDataSource, number> {
  return Object.fromEntries(SOURCES.map((s) => [s.source, s.priority])) as Record<
    TenderDataSource,
    number
  >;
}

/** Что опрашивается, когда профиль не перечислил sources явно. */
export function defaultSources(): TenderDataSource[] {
  return SOURCES.filter((s) => s.byDefault).map((s) => s.source);
}

/** Источники, которые плановый прогон умеет собирать (все, кроме демо-данных). */
export function syncableSources(): TenderDataSource[] {
  return SOURCES.filter((s) => s.source !== "MOCK" && s.source !== "IMPORT").map(
    (s) => s.source,
  );
}
```

Все тексты в проекте — на русском; перед сдачей задачи файл проверяется на посторонние
письменности (шаг 8).

- [x] **Шаг 5: убедиться, что тесты каталога проходят**

Выполнить: `npx vitest run src/domain/sources.test.ts`
Ожидание: 9 passed.

- [x] **Шаг 6: перевести три копии факта на каталог**

`src/repositories/tenderRepository.ts` — заменить тело объявления (строки 89-95), оставив
док-комментарий выше него и дополнив его ссылкой на каталог:

```ts
export const TENDER_SOURCE_PRIORITY: Record<TenderDataSource, number> =
  sourcePriorities();
```

Добавить в начало файла импорт: `import { sourcePriorities } from "@/domain/sources";`.

`src/domain/deepAnalysis.ts` — заменить объявление `DOCUMENTATION_SOURCES` (строки 183-186)
и `SOURCE_REASONS` (строки 188-196):

```ts
export const DOCUMENTATION_SOURCES: readonly TenderDataSource[] =
  documentationSources();
```

`SOURCE_REASONS` удалить целиком, а `deepAnalysisBlocker` переписать так:

```ts
export function deepAnalysisBlocker(
  dataSource: TenderDataSource,
): string | null {
  const facts = sourceFacts(dataSource);
  if (facts.documents === "bytes") return null;
  return facts.documentsReason ?? `Источник ${dataSource} не поддерживается.`;
}
```

Добавить импорт: `import { documentationSources, sourceFacts } from "@/domain/sources";`.
Док-комментарий над `DOCUMENTATION_SOURCES` (про Контур как агрегатор и про общую природу
списка с загрузчиком) сохранить — он объясняет причину, которой в каталоге нет.

`src/services/tenderDocumentsFetcher.ts` — переписать `documentationUnavailableReason`
(строки 181-198):

```ts
/** Почему документацию не получить — текст показывается пользователю и пишется в журнал. */
export function documentationUnavailableReason(target: TenderDocumentTarget): string {
  const facts = sourceFacts(target.dataSource);
  // Источник вообще не отдаёт байты: причина одна и та же в карточке и в журнале,
  // иначе два слоя рассказывали бы про одно и то же разными словами.
  if (facts.documents === "none") {
    return facts.documentsReason ?? `Источник ${target.dataSource} не отдаёт документацию.`;
  }
  // Источник документацию отдаёт, но эта попытка не удалась — объясняем попытку,
  // а не источник. Ветка `default` с чужим текстом про ручную загрузку исчезла:
  // новый источник больше не может молча получить чужую причину.
  if (target.dataSource === "KONTUR") {
    return (
      `ЕИС не отдала документацию по номеру ${target.regNumber} — вероятно, закупка размещена ` +
      "только на электронной площадке, а не в ЕИС. Файлы перечисляет карточка Контур.Закупок: " +
      "её загружает отдельный платный прогон с российского адреса, плановая синхронизация " +
      "такой запрос не делает."
    );
  }
  return `ЕИС не публикует печатную форму для закона ${target.law}.`;
}
```

Добавить импорт: `import { sourceFacts } from "@/domain/sources";`.

- [x] **Шаг 7: убедиться, что существующие ожидания не изменились**

Выполнить: `npx vitest run src/domain/deepAnalysis.test.ts src/services/tenderDocumentsFetcher.test.ts`
Ожидание: все тесты зелёные без правок в них.

Это и есть доказательство, что задача — рефакторинг, а не изменение поведения:
`deepAnalysis.test.ts:200` ждёт `/Сбербанк-АСТ/`, `:215` — `/КЭП/`, `:204` — `/вручную/`,
`tenderDocumentsFetcher.test.ts:116` — `/Сбербанк-АСТ/`. Новый объединённый текст
Сбербанк-АСТ содержит и площадку, и КЭП; текст ручного импорта содержит «вручную».

Если какой-то из этих тестов покраснел, значит текст каталога разошёлся с ожиданием —
правим текст в `sources.ts`, а не тест.

- [x] **Шаг 8: проверить файл на посторонние письменности и прогнать гейт**

Выполнить:

```bash
grep -lP '[\x{4e00}-\x{9fff}\x{3040}-\x{30ff}\x{ac00}-\x{d7af}]' \
  src/domain/sources.ts src/domain/sources.test.ts src/domain/deepAnalysis.ts \
  src/repositories/tenderRepository.ts src/services/tenderDocumentsFetcher.ts \
  || echo "посторонних письменностей нет"
```

Ожидание: «посторонних письменностей нет».

Затем полный гейт:

```bash
npm run lint && npm run typecheck && npm test && npm run build && npx tsx scripts/check-distribution.ts
```

Ожидание: lint без предупреждений, typecheck без вывода, `Test Files 111 passed (111)`,
`Tests 2296 passed` (2287 было до задачи, плюс 9 новых), сборка `Compiled successfully`
и `Generating static pages (30/30)`, распределение `EXIT=0`.

Число тестов сверяем не строго: дерево правят несколько сессий, и к моменту выполнения
задачи их может быть больше. Строго обязательно — ноль падений.

---

## Задача 2: Реестр привязок и прогон циклом по источникам

**Файлы:**
- Создать: `src/services/tenderSourceRegistry.ts`
- Создать: `src/services/tenderSourceRegistry.test.ts`
- Изменить: `scripts/sync-eis.ts:101-108` (SYNC_SOURCES, DEFAULT_SOURCES),
  `:146-155` (SOURCE_PROBES), `:234-252` (profileSources), `:504-532` (создание
  адаптеров и `perSource`)

- [x] **Шаг 1: написать падающий тест покрытия двух таблиц**

`src/services/tenderSourceRegistry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SOURCE_BINDINGS, sourceBinding } from "./tenderSourceRegistry";
import { SOURCES } from "@/domain/sources";
import type { TenderDataSource } from "@/types/database";

describe("реестр привязок источника", () => {
  it("покрывает ровно те источники, которые плановый прогон умеет собирать", () => {
    const syncable = SOURCES.filter(
      (s) => s.source !== "MOCK" && s.source !== "IMPORT",
    ).map((s) => s.source);
    const bound = SOURCE_BINDINGS.map((b) => b.source);
    expect([...bound].sort()).toEqual([...syncable].sort());
  });

  it("у каждой привязки источник описан в каталоге", () => {
    const listed: TenderDataSource[] = SOURCES.map((s) => s.source);
    for (const b of SOURCE_BINDINGS) {
      expect(listed, b.source).toContain(b.source);
    }
  });

  it("интервал платного источника задан, бесплатного — нет", () => {
    for (const b of SOURCE_BINDINGS) {
      const facts = SOURCES.find((s) => s.source === b.source);
      if (facts?.cost === "paid") {
        expect(b.cadenceHours, b.source).toBeTypeOf("number");
      } else {
        expect(b.cadenceHours, b.source).toBeNull();
      }
    }
  });

  it("точка проверки связи есть у каждой привязки и не расходует платный запрос", () => {
    for (const b of SOURCE_BINDINGS) {
      expect(b.probeUrl, b.source).toMatch(/^https:\/\//);
    }
    // Публичные страницы, а не API: проверка связи не должна тратить тариф.
    expect(sourceBinding("KONTUR")?.probeUrl).toBe("https://zakupki.kontur.ru/");
  });

  it("привязку несуществующего источника не выдумываем", () => {
    expect(sourceBinding("MOCK")).toBeNull();
  });
});
```

- [x] **Шаг 2: убедиться, что тест падает**

Выполнить: `npx vitest run src/services/tenderSourceRegistry.test.ts`
Ожидание: «Cannot find module './registry'».

- [x] **Шаг 3: написать реестр**

`src/services/tenderSourceRegistry.ts`:

```ts
import type { TenderDataSource } from "@/types/database";
import type { TenderSourceAdapter } from "@/adapters/types";
import { EisTenderSourceAdapter } from "@/adapters/tender-source/eisTenderSourceAdapter";
import { SberAstTenderSourceAdapter } from "@/adapters/tender-source/sberAstTenderSourceAdapter";
import { createKonturAdapter } from "@/services/konturSyncService";

/**
 * Привязка источника к его реализации.
 *
 * Каталог `src/domain/sources.ts` знает про источник только факты и не импортирует
 * ничего сверху, поэтому конструкторы живут здесь: домен остаётся чистым, а
 * скрипт синхронизации перестаёт перечислять адаптеры вручную.
 */
export interface SourceBinding {
  readonly source: TenderDataSource;
  /** Как источник назван в логе проверки связи. */
  readonly label: string;
  /**
   * Точка проверки доступности. Публичная страница, а не API: прогон не должен
   * тратить платный запрос на то, чтобы узнать, жив ли хост.
   */
  readonly probeUrl: string;
  /**
   * Создать адаптер. null — источник не настроен (нет ключа) или отключён;
   * прогон продолжает работать остальными.
   */
  create(): Promise<TenderSourceAdapter | null>;
  /**
   * Как часто опрашивать: null — каждый прогон. У платного источника интервал
   * читается из env, поэтому здесь число, а не константа.
   */
  readonly cadenceHours: number | null;
}

const RATE_LIMIT_PER_SEC = 2;
const MAX_RETRIES = 3;

export const SOURCE_BINDINGS: readonly SourceBinding[] = [
  {
    source: "EIS",
    label: "ЕИС",
    probeUrl: "https://zakupki.gov.ru/",
    cadenceHours: null,
    async create() {
      return new EisTenderSourceAdapter({
        rateLimitPerSec: RATE_LIMIT_PER_SEC,
        maxRetries: MAX_RETRIES,
      });
    },
  },
  {
    source: "TEK_TORG",
    label: "ТЭК-Торг",
    // Публичная страница площадки: сам экспорт SOAP платным не является, но
    // тратить запрос на проверку связи незачем.
    probeUrl: "https://www.tektorg.ru/",
    cadenceHours: null,
    async create() {
      // Задача 5 подключает сюда настоящий адаптер.
      return null;
    },
  },
  {
    source: "SBER_AST",
    label: "Сбербанк-АСТ",
    probeUrl: "https://www.sberbank-ast.ru/",
    cadenceHours: null,
    async create() {
      return new SberAstTenderSourceAdapter({
        rateLimitPerSec: RATE_LIMIT_PER_SEC,
        maxRetries: MAX_RETRIES,
      });
    },
  },
  {
    source: "KONTUR",
    label: "Контур.Закупки",
    probeUrl: "https://zakupki.kontur.ru/",
    // Интервал читает env внутри createKonturAdapter; число здесь — нижняя
    // граница по умолчанию, чтобы тест мог требовать «у платного задано».
    cadenceHours: 6,
    async create() {
      return createKonturAdapter();
    },
  },
];

/** Привязка источника; null, если плановый прогон его не собирает. */
export function sourceBinding(source: TenderDataSource): SourceBinding | null {
  return SOURCE_BINDINGS.find((b) => b.source === source) ?? null;
}
```

- [x] **Шаг 4: убедиться, что тесты реестра проходят**

Выполнить: `npx vitest run src/services/tenderSourceRegistry.test.ts`
Ожидание: 5 passed.

- [x] **Шаг 5: перевести скрипт синхронизации на каталог и реестр**

`scripts/sync-eis.ts`:

Удалить объявления `SYNC_SOURCES` (строки 101) и `DEFAULT_SOURCES` (строки 104-108) и
заменить их чтением из каталога:

```ts
/** Источники, из которых скрипт умеет собирать закупки. */
const SYNC_SOURCES: TenderDataSource[] = syncableSources();

/**
 * Что опрашивается, если профиль не указал sources. Платных источников здесь
 * нет намеренно: включать их нужно осознанно, профиль за профилем.
 */
const DEFAULT_SOURCES: TenderDataSource[] = defaultSources();
```

Импорт в начале файла:

```ts
import { defaultSources, syncableSources } from "../src/domain/sources";
import { SOURCE_BINDINGS } from "../src/services/tenderSourceRegistry";
```

`sourceBinding` скрипту не нужен — он обходит `SOURCE_BINDINGS` целиком.

Удалить `SOURCE_PROBES` (строки 145-155) и переписать начало `probeSources` (строка 178)
на чтение из реестра:

```ts
async function probeSources(wanted: Set<TenderDataSource>): Promise<TenderDataSource[]> {
  const probes = SOURCE_BINDINGS.filter((b) => wanted.has(b.source)).map((b) => ({
    source: b.source,
    label: b.label,
    url: b.probeUrl,
  }));
  if (probes.length === 0) return [];
  // ...тело функции без изменений...
```

Дальше тело `probeSources` не меняется: оно работает со списком
`{ source, label, url }`, который теперь собирается из реестра.

`profileSources` (строки 234-252) — вернуть список источников вместо трёх булевых:

```ts
/**
 * Какие источники опрашивать для профиля.
 *
 * Платные источники не входят в набор по умолчанию: профиль должен перечислить
 * их в sources явно. `only` сужает набор до источников из флага --sources, так
 * платный прогон можно выполнить отдельно, не опрашивая бесплатные.
 */
function profileSources(
  profile: SyncProfile,
  only?: TenderDataSource[] | null,
): { eisLaws: TenderLaw[]; sources: TenderDataSource[] } {
  const requested = (profile.sources ?? DEFAULT_SOURCES).filter((s) =>
    SYNC_SOURCES.includes(s),
  );
  const sources = only ? requested.filter((s) => only.includes(s)) : requested;
  const eisLaws = profile.laws.filter((l) => l !== "COMMERCIAL");
  return { eisLaws, sources };
}
```

Все вызовы `profileSources` в теле прогона перевести с `wantEis` / `wantSber` /
`wantKontur` на `sources.includes("EIS")` и т. д. Условие ЕИС сохраняет вторую половину
прежнего правила — источник опрашивается, только если у профиля есть законы кроме
`COMMERCIAL` либо законы не заданы вовсе:

```ts
const wantEis = sources.includes("EIS") && (eisLaws.length > 0 || profile.laws.length === 0);
const wantSber = sources.includes("SBER_AST");
const wantKontur = sources.includes("KONTUR");
const wantTekTorg = sources.includes("TEK_TORG");
```

Эти четыре строки живут в теле цикла по профилям, где раньше лежали три буля из
`profileSources`. Смысл шага — не убрать их, а сделать так, чтобы они выводились из
одного списка, а не из трёх полей возвращаемого объекта.

Создание адаптеров (строки 504-522) заменить на цикл по реестру:

```ts
  const adapters = new Map<TenderDataSource, TenderSourceAdapter>();
  for (const binding of SOURCE_BINDINGS) {
    if (!wanted.has(binding.source)) continue;
    const adapter = await binding.create();
    if (adapter === null) {
      console.log(`${binding.label}: источник не настроен, пропускаем`);
      continue;
    }
    adapters.set(binding.source, adapter);
  }
  const eisAdapter = adapters.get("EIS") ?? null;
  const sberAdapter = adapters.get("SBER_AST") ?? null;
  const konturAdapter = adapters.get("KONTUR") ?? null;
```

Контур при этом теряет отдельную ветку `wanted.has("KONTUR") ? await createKonturAdapter()
: null` — её заменяет `create()` привязки. Печать израсходованного бюджета сохранить,
прочитав счётчики из созданного адаптера:

```ts
  const kontur = adapters.get("KONTUR");
  if (kontur && "counters" in kontur) {
    const withCounters = kontur as KonturTenderSourceAdapter;
    const spent = withCounters.counters.requestsTodayByMethod;
    console.log(
      `Контур.Закупки: ${withCounters.contractSummary.baseUrl}, ` +
        `израсходовано сегодня — поиск ${spent.search}, карточки ${spent.card}`,
    );
  }
```

`perSource` (строки 531-533) уже строится из `SYNC_SOURCES`, поэтому новое значение
попадает в карту автоматически — править нечего, но проверить, что `TEK_TORG` в ней
появился:

```ts
  const perSource = new Map<TenderDataSource, number>(
    SYNC_SOURCES.map((s) => [s, 0]),
  );
```

- [x] **Шаг 6: убедиться, что скрипт собирается и не изменил поведение**

Выполнить: `npm run typecheck && npm test`
Ожидание: typecheck без вывода, все тесты зелёные.

Затем сухой прогон на живом API — он бесплатный для ЕИС и Сбербанк-АСТ и не должен
тратить запросы Контур.Закупок, поэтому Контур в списке источников не указываем:

```bash
npx tsx scripts/sync-eis.ts --dry-run --sources=EIS,SBER_AST,TEK_TORG
```

Флага `--limit` у скрипта нет: объём ограничивает `limitPerKeyword` в
`scripts/sync-profiles.json`, а неизвестный флаг был бы проигнорирован молча — прогон
выглядел бы ограниченным, оставаясь полным.

Ожидание в выводе (проверено 01.10.2026, прогон 12,5 с, EXIT=0):

```
РЕЖИМ --sources: опрашиваем только EIS, SBER_AST, TEK_TORG
Проверка связи · ЕИС: доступен (HTTP 200)
Проверка связи · Сбербанк-АСТ: доступен (HTTP 200)
Профиль «Автомобили» [ЕИС, Сбербанк-АСТ]:
...
Новых закупок, EIS: 130
TEK_TORG: не опрашивался — не выбран ни одним профилем
Новых закупок, SBER_AST: 39
KONTUR: не опрашивался — отключён флагом --sources
Уникальных закупок всего: 147.
--dry-run завершён за 12.5 с, в БД ничего не записано
```

Строки `ТЭК-Торг: доступен` и `ТЭК-Торг: источник не настроен, пропускаем` здесь НЕ
появляются, и это правильно: `wanted` строится из источников профиля, а ни один профиль
`TEK_TORG` пока не перечисляет. Обе строки приходят в задаче 6, когда источник будет
добавлен в `scripts/sync-profiles.json`. Что доказывает этот прогон сейчас: флаг
`--sources` принимает новое имя без «Неизвестный источник», проверка связи и создание
адаптеров работают через реестр, а выдача ЕИС и Сбербанк-АСТ не изменилась.

Если ЕИС недоступна из текущей сети — это штатная ветка, прогон обязан продолжить работу
по Сбербанк-АСТ и напечатать `недоступен`, а в итоге — `EIS: не опрашивался — не прошёл
проверку связи`.

- [x] **Шаг 7: прогнать гейт**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npx tsx scripts/check-distribution.ts
```

Ожидание: ноль падений, сборка проходит, распределение `EXIT=0`.

Проверено 01.10.2026: lint `✔ No ESLint warnings or errors`, typecheck без вывода,
112 файлов / 2302 теста, build EXIT=0, распределение EXIT=0 (все шесть требований true,
35 закупок, `{FZ_44: 21, FZ_223: 14}`).

---

### Чем реализация задачи 2 отличается от написанного выше

Отличия внесены по ходу работы и проверены гейтом; текст выше оставлен как был, чтобы
было видно, что именно и почему поехало.

1. **Реестр переехал в `src/services/tenderSourceRegistry.ts`** — см. «Структура файлов».

2. **У привязки появилось поле `honoursRegions: boolean`.** Перенос предупреждения
   «у ЕИС нет регионального фильтра» на реестр требовал решить, кто из источников фильтр
   применяет. Держать этот список в скрипте значит держать его рядом с кодом, который его
   печатает, а не рядом с фактом: новая площадка молча попала бы в список «фильтр
   применят» или молча из него выпала. Теперь факт записан в привязке и покрыт тестом:
   ЕИС — false (docs/ACCESS_EIS.md), ТЭК-Торг — false (в `exportRequestType` нет ни одного
   параметра региона), Сбербанк-АСТ — true, Контур — true. Предупреждение в логе стало
   общим: «`<источники>` не фильтрует выдачу по региону — по этому источнику закупки
   собираются по всей России».

3. **Итоговая строка различает «опросили — ноль» и «не опрашивались».** Раньше прогон
   печатал `Новых закупок, KONTUR: 0` и в том случае, когда Контур не спрашивали вовсе
   (нет ключа, --dry-run, интервал, исчерпан бюджет). С новым источником это стало бы
   постоянным: `TEK_TORG: 0` каждые два часа до задачи 5. Теперь источник, которого не
   спрашивали, печатает причину: не прошёл проверку связи / адаптер ещё не подключён /
   причина исключения (записывается там же, где принимается решение) / останов Контур.Закупок
   / отключён флагом --sources / не выбран ни одним профилем. В разделе примеров
   `--dry-run` пустые источники не печатаются: про них уже сказала итоговая строка.

4. **Остановка Контур.Закупок теперь действительно останавливает их до конца прогона.**
   `konturStopped` проверяется и перед каждым запросом источника, а не только при печати
   заголовка профиля. Раньше условие читалось один раз на профиль, поэтому после исчерпания
   бюджета оставшиеся ключевые слова того же профиля продолжали дёргать источник и
   печатали сообщение об остановке по разу на каждое слово — вопреки комментарию «сообщение
   уходит в лог один раз». Платных запросов это не добавляло (адаптер бросает исключение до
   обращения к сети), но лог врала.

5. **`eisApplies(profile, eisLaws)`** вынесено в функцию: правило «ЕИС опрашивается, только
   если у профиля есть законы кроме COMMERCIAL либо законы не заданы» нужно в двух местах —
   при сборе `wanted` для проверки связи и в цикле по профилям. Две копии разошлись бы
   молча: прогон печатал бы «ЕИС: доступен» и не опрашивал её.

6. **Условия в цикле по ключевым словам получили сужение типа**: `if (wantEis && eisAdapter)`,
   `if (wantSber && sberAdapter)` — адаптеры теперь берутся из карты и могут отсутствовать.
   Поведения это не меняет: `queried` включает только источники с созданным адаптером.

---

## Задача 3: SOAP-конверт и разбор ответа ТЭК-Торга

**Файлы:**
- Создать: `src/adapters/tender-source/tektorgFixtures.ts`
- Создать: `src/adapters/tender-source/tektorgSoap.ts`
- Создать: `src/adapters/tender-source/tektorgSoap.test.ts`

Правила транспорта и разбор живого ответа описаны в спеке, раздел «Что проверено и на что
можно опираться», и в `docs/REFERENCE_TEK_TORG_API.md`. Ниже — только то, что нужно для
кода, и две ловушки, которые уже стоили времени.

- [x] **Шаг 1: положить фикстуру живого ответа**

`src/adapters/tender-source/tektorgFixtures.ts` — обрезанный ответ за 01.10.2026: две
процедуры, одна с `eisRegistryNumber` и двумя лотами, одна без номера ЕИС, с лотом без
`startPrice` и с элементом `<removed>` вместо `<file>`. Фикстура обязана воспроизводить
реальную вложенность и имена элементов, включая атрибуты у `<lot>` — именно на них
спотыкался наивный разбор.

```ts
/**
 * Обрезанный живой ответ SOAP-экспорта ТЭК-Торга от 01.10.2026.
 *
 * Две процедуры: одна с номером ЕИС (значит 223-ФЗ и дедупликация по номеру
 * извещения), одна без него (чисто коммерческая, в ЕИС её нет). Во второй лот
 * без `startPrice` и элемент `<removed>` вместо `<file>` — оба случая настоящие,
 * они встретились в ответе за сутки.
 *
 * Личных данных сверх того, что площадка публикует сама, здесь нет.
 */
export const TEKTORG_TWO_PROCEDURES = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
 <SOAP-ENV:Body>
  <proceduresResponse xmlns="https://api.tektorg.ru/procedures/soap">
   <procedure>
    <registryNumber>ЗП610110</registryNumber>
    <eisRegistryNumber>32616430599</eisRegistryNumber>
    <title>Выполнение работ по ремонту кабельных линий</title>
    <sectionName>zakupki</sectionName>
    <typeId>2</typeId>
    <publishDate>2026-10-01T06:12:00+03:00</publishDate>
    <endDate>2026-10-09T10:00:00+03:00</endDate>
    <organizer>
     <fullName>Акционерное общество «Российские железные дороги»</fullName>
     <inn>7708503727</inn>
     <address><region>г. Москва</region></address>
    </organizer>
    <customers>
     <customer><inn>7708503727</inn><region>г. Москва</region></customer>
    </customers>
    <documentType><file>https://api.tektorg.ru/open-api/documents/procedure/111</file></documentType>
    <lots>
     <lot lotNumber="1">
      <subject>Ремонт кабельной линии 6 кВ, участок А</subject>
      <startPrice>1200000.00</startPrice>
      <currency>RUB</currency>
     </lot>
     <lot lotNumber="2">
      <subject>Ремонт кабельной линии 6 кВ, участок Б</subject>
      <startPrice>800000.00</startPrice>
      <currency>RUB</currency>
     </lot>
    </lots>
   </procedure>
   <procedure>
    <registryNumber>ЗП610102</registryNumber>
    <title>Поставка спецодежды для персонала</title>
    <sectionName>zakupki</sectionName>
    <typeId>5</typeId>
    <publishDate>2026-10-01T08:40:00+03:00</publishDate>
    <endDate>2026-10-07T12:00:00+03:00</endDate>
    <organizer>
     <fullName>Общество с ограниченной ответственностью «ЭнергоСбыт»</fullName>
     <inn>7701234567</inn>
     <address><region>Свердловская обл</region></address>
    </organizer>
    <documentType><removed>true</removed></documentType>
    <lots>
     <lot lotNumber="1">
      <subject></subject>
     </lot>
    </lots>
   </procedure>
  </proceduresResponse>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

/** Ответ с Fault: площадка сообщила об ошибке, это не пустая выдача. */
export const TEKTORG_FAULT = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
 <SOAP-ENV:Body>
  <SOAP-ENV:Fault>
   <faultstring>Некорректный период обновления</faultstring>
  </SOAP-ENV:Fault>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
```

- [x] **Шаг 2: написать падающие тесты разбора**

`src/adapters/tender-source/tektorgSoap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildProceduresRequest,
  parseProceduresResponse,
  TektorgSoapFaultError,
} from "./tektorgSoap";
import { TEKTORG_FAULT, TEKTORG_TWO_PROCEDURES } from "./tektorgFixtures";

describe("запрос экспорта процедур", () => {
  it("собирает конверт с операцией procedures и периодом обновления", () => {
    const body = buildProceduresRequest({
      section: "zakupki",
      startUpdateAt: "2026-10-01T00:00:00Z",
      endUpdateAt: "2026-10-02T00:00:00Z",
      limitPage: 500,
      page: 1,
    });

    expect(body).toContain("<procedures");
    expect(body).toContain("https://api.tektorg.ru/procedures/soap");
    expect(body).toContain("<section>zakupki</section>");
    expect(body).toContain("<startUpdateAt>2026-10-01T00:00:00Z</startUpdateAt>");
    expect(body).toContain("<endUpdateAt>2026-10-02T00:00:00Z</endUpdateAt>");
    expect(body).toContain("<limitPage>500</limitPage>");
    expect(body).toContain("<page>1</page>");
  });

  it("экранирует ИНН заказчика в запросе, а не подставляет как есть", () => {
    const body = buildProceduresRequest({
      section: "zakupki",
      customerINN: ["7708503727"],
    });
    expect(body).toContain("<customerINN>7708503727</customerINN>");
  });
});

describe("разбор ответа экспорта", () => {
  it("находит обе процедуры и сохраняет вложенность лотов", () => {
    const parsed = parseProceduresResponse(TEKTORG_TWO_PROCEDURES);

    expect(parsed.procedures).toHaveLength(2);
    expect(parsed.procedures[0]?.registryNumber).toBe("ЗП610110");
    expect(parsed.procedures[0]?.lots).toHaveLength(2);
    expect(parsed.procedures[0]?.lots[1]?.subject).toBe(
      "Ремонт кабельной линии 6 кВ, участок Б",
    );
  });

  it("не путает <file> с <filename> и не принимает <removed> за документ", () => {
    const parsed = parseProceduresResponse(TEKTORG_TWO_PROCEDURES);

    expect(parsed.procedures[0]?.documents).toEqual([
      "https://api.tektorg.ru/open-api/documents/procedure/111",
    ]);
    expect(parsed.procedures[1]?.documents).toEqual([]);
    expect(parsed.procedures[1]?.removedDocuments).toBe(1);
  });

  it("отсутствующая цена лота остаётся отсутствующей, а не нулём", () => {
    const parsed = parseProceduresResponse(TEKTORG_TWO_PROCEDURES);

    expect(parsed.procedures[0]?.lots[0]?.startPrice).toBe(1200000);
    expect(parsed.procedures[1]?.lots[0]?.startPrice).toBeNull();
  });

  it("пустой предмет лота остаётся пустой строкой", () => {
    const parsed = parseProceduresResponse(TEKTORG_TWO_PROCEDURES);
    expect(parsed.procedures[1]?.lots[0]?.subject).toBe("");
  });

  it("расшифровывает XML-сущности в названии", () => {
    const parsed = parseProceduresResponse(
      TEKTORG_TWO_PROCEDURES.replace(
        "Поставка спецодежды для персонала",
        "Поставка &amp; спецодежды &lt;для персонала&gt;",
      ),
    );
    expect(parsed.procedures[1]?.title).toBe(
      "Поставка & спецодежды <для персонала>",
    );
  });

  it("Fault — это ошибка, а не пустая выдача", () => {
    expect(() => parseProceduresResponse(TEKTORG_FAULT)).toThrow(
      TektorgSoapFaultError,
    );
    expect(() => parseProceduresResponse(TEKTORG_FAULT)).toThrow(
      /Некорректный период/,
    );
  });

  it("ответ без конверта — ошибка разбора, а не ноль процедур", () => {
    expect(() => parseProceduresResponse("<html>страница входа</html>")).toThrow(
      /не похож на ответ/,
    );
  });
});
```

- [x] **Шаг 3: убедиться, что тесты падают**

Выполнить: `npx vitest run src/adapters/tender-source/tektorgSoap.test.ts`
Ожидание: «Cannot find module './tektorgSoap'».

- [x] **Шаг 4: написать транспорт и разбор**

`src/adapters/tender-source/tektorgSoap.ts`. Обязательные свойства реализации:

1. Экспортирует типы `TektorgLot` (`lotNumber`, `subject`, `startPrice: number | null`,
   `currency: string | null`), `TektorgProcedure` (`registryNumber`,
   `eisRegistryNumber: string | null`, `title`, `sectionName`, `typeId: number | null`,
   `publishDate: string | null`, `endDate: string | null`, `organizerFullName`,
   `organizerInn: string | null`, `region`, `documents: string[]`,
   `removedDocuments: number`, `lots: TektorgLot[]`, `raw: string`), классы ошибок
   `TektorgSoapFaultError` и `TektorgParseError`, функции `buildProceduresRequest` и
   `parseProceduresResponse`, и `TEKTORG_ENDPOINTS`.

2. `TEKTORG_ENDPOINTS`:

```ts
export const TEKTORG_ENDPOINTS = {
  /** Официальный экспорт процедур: SOAP, ключа не требует. */
  procedures: "https://api.tektorg.ru/procedures/soap",
  /** Байты документов: тот же хост, тоже без ключа, поддерживает Range. */
  documents: "https://api.tektorg.ru/open-api/documents/procedure",
} as const;
```

3. `buildProceduresRequest(query)` возвращает строку-конверт. Пространство имён
   `https://api.tektorg.ru/procedures/soap`, `SOAPAction: urn:procedures`, один элемент
   запроса `symbol` типа `exportRequestType`. Внутри `<xsd:all>`, поэтому порядок полей
   не важен — но все значения обязаны быть экранированы (`escapeXml`) и пропущены через
   `encodeURIComponent` там, где это не XML, а URL. Необязательные поля
   (`customerINN`, `limitPage`, `page`, даты) в конверт не попадают вовсе, если не заданы:
   пустой тег площадка трактует как фильтр, а не как «не задано».

4. `parseProceduresResponse(xml)`:
   - если в ответе нет `SOAP-ENV:Envelope` (или `SOAP:Envelope`) — бросить
     `TektorgParseError` с сообщением, содержащим «не похож на ответ». Причина: успешный
     ответ приходит с `Content-Type: text/html`, поэтому по заголовку отличить страницу
     входа от выдачи нельзя — только по телу;
   - если есть `Fault` — бросить `TektorgSoapFaultError` с текстом `faultstring`;
   - процедуры резать по `/(?=<procedure[ >])/`, а не по `/(?=<procedure>)/`: элемент
     приходит с атрибутами, и наивный split возвращал ноль процедур;
   - теги с общими префиксами имен резать так, чтобы короткий не поймал длинный:
     `<file(?:\s[^>]*)?>`, а не `<file[^>]*>` (второе матчит `<filename>`, и вместо
     адреса документа получался 404);
   - числа читать через `Number.parseFloat`, `NaN` → `null`;
   - текст прогонять через `decodeXmlEntities` из `@/lib/fsnb/xmlTokenizer`;
   - новый XML-парсер не добавляем: токенайзер уже написан и протестирован.

5. `raw` каждой процедуры — её собственный обрезок XML: он нужен, чтобы запись в
   `tenders.raw_data` позволяла пересобрать строку без нового запроса (тот же приём, что
   у Контур.Закупок).

- [x] **Шаг 5: убедиться, что тесты проходят**

Выполнить: `npx vitest run src/adapters/tender-source/tektorgSoap.test.ts`
Ожидание: 10 passed. Факт: **29 passed** — на каждый ответ площадки пришлись две-три
проверки вместо одной, и сверху четыре теста «ответ, который нельзя принять за выдачу».

- [x] **Шаг 6: прогнать гейт**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npx tsx scripts/check-distribution.ts
```

Факт: lint «✔ No ESLint warnings or errors», typecheck молча, «Test Files 113 passed (113) /
Tests 2331 passed (2331)» (на один файл и 29 тестов больше, чем до задачи), build EXIT=0,
распределение `{RECOMMENDED: 10, MANUAL_REVIEW: 6, NOT_RECOMMENDED: 19}` на 35 закупках,
все шесть требований `true`, EXIT=0.

### Чем реализация задачи 3 отличается от написанного выше

План писался по догадке о схеме. Прежде чем писать парсер, я снял живой WSDL
(`https://api.tektorg.ru/procedures/wsdl`, 12 377 байт) и сделал два read-only вызова
экспорта — 105 процедур. Схема площадки разошлась с планом почти во всех полях, и парсер
с фикстурой собраны по живым байтам, а не по тексту ниже. Расхождения, которые важны для
задач 4–6:

**Фикстура.** Файл называется `src/adapters/tender-source/tektorgTestFixtures.ts`
(не `tektorgFixtures.ts`) — под существующее соглашение `sberAstTestFixtures.ts` и
`konturTestFixtures.ts`. Экспортирует `TEKTORG_LIVE_RESPONSE` (три настоящие процедуры:
`ЗП6082206` с номером ЕИС и двумя лотами, пришедшими в обратном порядке; `ЗП610102` —
коммерческая, без номера ЕИС и без цены; `ЗП6091269` с заполненным регионом),
`TEKTORG_REMOVED_DOCUMENT`, `TEKTORG_EMPTY_PAGE`, `TEKTORG_FAULT`, `TEKTORG_TRUNCATED`.
Две правки относительно байт-в-байт копии помечены в шапке файла: счётчики страниц
приведены к трём процедурам фикстуры, а имя, телефон и почта контактного лица заменены на
вымышленные (чужие персональные данные в репозиторий тащить незачем, на разбор подстановка
не влияет — парсер эти поля не читает). `TEKTORG_REMOVED_DOCUMENT`, пустая страница и
Fault — собраны по схеме и SOAP 1.1, а не сняты с ответа: варианта `<removed>` в 105
живых процедурах не встретилось ни разу, и это записано в комментарии фикстуры.

**Конверт ответа.** Обёртка — `<SOAP-ENV:proceduresResponse>`, а не голый список:
`parseProceduresResponse` возвращает страницу (`totalProcedures`, `currentPage`,
`totalPage`, `limitProceduresInPage`, `sectionCode`, `sectionName`, `procedures`), и
счётчики читаются из остатка конверта. В шапке ответа висит постороннее
`xmlns:ns1="http://tektorg.loc/api"` — утечка внутреннего пространства имён площадки,
на разбор не влияет. Проверка «конверт закрыт» добавлена сверх плана: площадка может
оборвать выдачу после полной первой процедуры, и наивный парсер молча вернул бы треть
суток.

**Поля запроса.** `sectionCode` (не `section`); `organizerINN` и `customerINN` —
`xsd:string maxOccurs="1"`, то есть строка, а не массив: один запрос на один ИНН.
Даты — `startDate`/`endDate` (публикация) и `startUpdateAt`/`endUpdateAt` (изменения).
`TEKTORG_REQUEST_HEADERS` вынесен отдельной константой (`Content-Type: text/xml;
charset=utf-8` и `SOAPAction: urn:procedures`) — без `SOAPAction` площадка не находит
операцию, и это стоит видеть в тестах, а не прятать в адаптере.

**Поля процедуры.** `datePublished`, `dateUpdated`, `dateEndRegistration` (не
`publishDate`/`endDate`); способ размещения — пара `procedureType{id,title}` (не
`typeId`); номер лота — элемент `<number>`, а `id` лота приходит атрибутом; `currency` —
на уровне процедуры, а не лота; заказчики живут внутри каждого лота, а не у процедуры;
адрес организатора — `organizer/legal/{index,region,settlement,city,street,house}`
(не `organizer/address/region`), и когда `legal` пуст, весь адрес целиком падает в
`<house>`. `<fullName>` приходит в CDATA, иногда с неэкранированными внутренними
кавычками (`"ДОМ ДОБРА И ПОМОЩИ "БЛАГО"`), поэтому содержимое CDATA через
`decodeXmlEntities` не прогоняется.

**Словарь `procedureType`, снятый с 105 процедур** (для задачи 4): 2 «Аукцион» ×22,
3 «Конкурс» ×8, 4 «Запрос предложений» ×7, 5 «Запрос цен» ×2, 18 «Запрос котировок» ×42,
21 «Запрос предоставления ценовой информации» ×19, 22 «Запрос оферт» ×4 и
**30 «TYPE_30» ×1** — площадка сама не знает названия этого типа. Это живое
подтверждение правила «неизвестный `typeId` → `OTHER`, а не ошибка».

**Окно синхронизации.** Окно изменений (`startUpdateAt`/`endUpdateAt`) возвращает
преимущественно архив: из 105 процедур 72 «Архив», 27 «Работа комиссии», 10 «Приём
заявок», 2 «Отменён». Задаче 5 нужно окно публикации (`startDate`/`endDate`), иначе
воркер будет каждый прогон пережёвывать закрытые закупки.

**Регионы.** `regionFromAddresses` из `src/domain/regions.ts:369` уже распознаёт все
формы, которые печатает площадка: «119180, Г.МОСКВА, вн.тер.г. МУНИЦИПАЛЬНЫЙ ОКРУГ
ЯКИМАНКА, УЛ БОЛЬШАЯ ПОЛЯНКА, Д. 2, СТР. 2» → «Москва», «624480, СВЕРДЛОВСКАЯ ОБЛАСТЬ,
Г СЕВЕРОУРАЛЬСК, УЛ ЛЕНИНА, Д. 33» → «Свердловская область», «Город Москва столица
Российской Федерации город федерального значения» → «Москва», «В соответствии с ТЗ» →
«Не указан». Проверено на живых строках. Значит, маппер задачи 4 может определять регион
сам, и `honoursRegions: false` у привязки остаётся честным: площадка фильтр по региону не
принимает, но регион мы из её данных достаём.

**Важно для задачи 4:** её тестовые сниппеты ниже писались до зонда и перечисляют поля,
которых в типах нет (`typeId`, `sectionName`, `endDate`, `lotNumber`, `currency` у лота).
Читать их нужно как список правил, а не как готовый код; настоящие имена — в
`src/adapters/tender-source/tektorgSoap.ts`.

---

## Задача 4: Маппер процедуры в Tender

**Файлы:**
- Создать: `src/adapters/tender-source/tektorgMapper.ts`
- Создать: `src/adapters/tender-source/tektorgMapper.test.ts`

Правила переноса полей — в спеке, раздел «2. ТЭК-Торг: адаптер, парсер, маппер». Каждое
правило проверяется отдельным тестом; значения в тестах сняты с разбора фикстуры
`tektorgTestFixtures.ts`, а не выдуманы.

> **Задача переписана после зонда.** Первоначальный текст перечислял поля, которых в
> ответе площадки нет (`typeId`, `sectionName` у процедуры, `endDate`, `lotNumber`,
> `currency` у лота), и ожидания, которым неоткуда взяться (цена 2 000 000, заказчик РЖД,
> регион «Свердловская обл»). Ниже — правила против настоящих имён из
> `src/adapters/tender-source/tektorgSoap.ts`.

### Что показал зонд секций и почему мапперу нужен `sectionCode`

Экспорт принимает `sectionCode`; площадка подтвердила значения (зонд 02.10.2026, по одному
read-only вызову на значение):

| `sectionCode` | `sectionName` | Процедур за 01.10.2026 | Откуда документы |
| --- | --- | --- | --- |
| не задан | Государственные закупки | 408 | — |
| `44fz` | Государственные закупки | 408 | `44.tektorg.ru` → редирект на `zakupki.gov.ru` |
| `zakupki` | 223-ФЗ и Коммерческие закупки | 75 | `api.tektorg.ru/open-api/documents/procedure/{id}` |
| `223fz`, `несостоявшиеся` | — | — | SOAP Fault «Section not found.» при status 200 |

Три следствия, которые меняют маппер:

1. **`sectionCode` по умолчанию — `44fz`, а не «все секции».** Не передать секцию значит
   молча получить государственные закупки вместо коммерческих. Адаптер (задача 5) обязан
   передавать `sectionCode` явно.
2. **Словарь `procedureType` у каждой секции свой.** `typeId=2` в `zakupki` — «Аукцион»,
   а в `44fz` — «Запрос котировок в электронной форме». Одна общая таблица перепутала бы
   способы размещения целиком, поэтому словарь — по секциям.
3. **В `44fz` номер ЕИС лежит прямо в `registryNumber`.** Из 100 процедур секции `44fz`
   `eisRegistryNumber` нет ни у одной, а `registryNumber` у всех ста — 19-значный номер
   ЕИС (`0321300070226000115`). В `zakupki` наоборот: `registryNumber` — номер площадки
   («ЗП6082206»), `eisRegistryNumber` есть у 49 из 75. Правило дедупликации обязано это
   учитывать, иначе закупка 44-ФЗ уедет в базу под ключом `TEKTORG-0321300070226000115` и
   не схлопнется с еисовской записью.

**Адаптер синхронизирует только `zakupki`.** Закупки 44-ФЗ по закону уже опубликованы в
ЕИС и приходят оттуда, а байты их документов площадка отдаёт редиректом на
`zakupki.gov.ru` — тем же путём, которым уже ходит загрузчик вложений ЕИС. Ценность
ТЭК-Торга — в коммерческих закупках, которых в ЕИС нет вовсе: 26 из 75 за сутки.
Поддержка `44fz` в маппере остаётся, чтобы будущая синхронизация этой секции не
перекрасила способы размещения молча.

- [x] **Шаг 1: написать падающие тесты правил**

`src/adapters/tender-source/tektorgMapper.test.ts`. Обязательный набор проверок:

```ts
import { describe, expect, it } from "vitest";
import { isPriceKnown } from "@/domain/entities";
import { TEKTORG_PLACING_WAYS, mapTektorgProcedure } from "./tektorgMapper";
import { parseProceduresResponse } from "./tektorgSoap";
import { TEKTORG_LIVE_RESPONSE } from "./tektorgTestFixtures";

const page = parseProceduresResponse(TEKTORG_LIVE_RESPONSE);
/** ЗП6082206: номер ЕИС есть, два лота с ценой, лоты пришли в обратном порядке. */
const withEis = page.procedures[0]!;
/** ЗП610102: коммерческая, номера ЕИС нет, цены нет, регион пуст (адрес уехал в <house>). */
const commercial = page.procedures[1]!;
/** ЗП6091269: <region> заполнен, один лот с ценой. */
const withRegion = page.procedures[2]!;
const ZAKUPKI = { sectionCode: "zakupki" } as const;

/** Номер процедуры 44-ФЗ такой, каким его отдаёт секция 44fz: 19 цифр, без eisRegistryNumber. */
const FZ44_NUMBER = "0321300070226000115";

describe("ключ дедупликации", () => {
  it("номер ЕИС становится reg_number: запись схлопывается с еисовской", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).regNumber).toBe("32616329240");
  });

  it("без номера ЕИС reg_number получает префикс площадки", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).regNumber).toBe("TEKTORG-ЗП610102");
  });

  it("external_id всегда равен номеру площадки: по нему работают карточка и документы", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).externalId).toBe("ЗП6082206");
    expect(mapTektorgProcedure(commercial, ZAKUPKI).externalId).toBe("ЗП610102");
  });

  it("в секции 44fz номер площадки и есть номер ЕИС — префикс сломал бы дедупликацию", () => {
    const fz44 = { ...commercial, registryNumber: FZ44_NUMBER };
    expect(mapTektorgProcedure(fz44, { sectionCode: "44fz" }).regNumber).toBe(FZ44_NUMBER);
  });

  it("id детерминированный: повторный прогон не плодит записи", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).id).toBe("tektorg-ЗП610102");
  });
});

describe("закон", () => {
  it("попадание в ЕИС означает 223-ФЗ", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).law).toBe("FZ_223");
  });

  it("процедура без номера ЕИС — коммерческая", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).law).toBe("COMMERCIAL");
  });

  it("секция 44fz даёт 44-ФЗ независимо от номера ЕИС", () => {
    const fz44 = { ...commercial, registryNumber: FZ44_NUMBER };
    expect(mapTektorgProcedure(fz44, { sectionCode: "44fz" }).law).toBe("FZ_44");
  });

  it("секция не задана — считаем закупочной: адаптер ходит только в nią", () => {
    expect(mapTektorgProcedure(commercial).law).toBe("COMMERCIAL");
  });
});

describe("цена", () => {
  it("один лот с ценой — берём её", () => {
    expect(mapTektorgProcedure(withRegion, ZAKUPKI).financial.price).toBe(137640);
  });

  it("несколько лотов, цена у всех — берём сумму", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).financial.price).toBe(3297903.75);
  });

  it("хотя бы у одного лота цены нет — цена неизвестна, а не занижена", () => {
    const t = mapTektorgProcedure(
      {
        ...withEis,
        lots: [...withEis.lots, { ...withEis.lots[0]!, id: "9", number: "3", startPrice: null }],
      },
      ZAKUPKI,
    );
    expect(t.financial.price).toBe(0);
  });

  it("нуль цены — это «не опубликована», и isPriceKnown её отличает", () => {
    const price = mapTektorgProcedure(commercial, ZAKUPKI).financial.price;
    expect(price).toBe(0);
    expect(isPriceKnown(price)).toBe(false);
  });

  it("валюта берётся из ответа площадки", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).financial.currency).toBe("RUB");
  });
});

describe("предмет, лоты и заказчик", () => {
  it("предмет закупки — название процедуры", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).subject).toBe(
      "Поставка электро-бензоинструмента (лот 1, лот 2) АО «Регионгаз-инвест»",
    );
  });

  it("лоты приходят в обратном порядке — сортируем по номеру", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).lots.map((l) => l.number)).toEqual([1, 2]);
  });

  it("пустой предмет лота не заменяется названием процедуры", () => {
    const t = mapTektorgProcedure(
      { ...commercial, lots: [{ ...commercial.lots[0]!, subject: "" }] },
      ZAKUPKI,
    );
    expect(t.lots[0]?.subject).toBe("");
  });

  it("заказчик — из лота: организатор проводит процедуру, а покупает заказчик", () => {
    const t = mapTektorgProcedure(withEis, ZAKUPKI);
    expect(t.customerName).toContain("РЕГИОНГАЗ-ИНВЕСТ");
    expect(t.customerInn).toBe("6659075136");
  });

  it("когда заказчика в лоте нет, остаётся организатор", () => {
    const t = mapTektorgProcedure(
      {
        ...commercial,
        lots: [{ ...commercial.lots[0]!, customerName: null, customerInn: null }],
      },
      ZAKUPKI,
    );
    expect(t.customerName).toContain("РГ-СНАБЖЕНИЕ");
    expect(t.customerInn).toBe("2203002720");
  });

  it("регион — из адреса организатора, когда <region> пуст", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).region).toBe("Москва");
  });

  it("регион — из <region>, когда он заполнен", () => {
    expect(mapTektorgProcedure(withRegion, ZAKUPKI).region).toBe("Ульяновская область");
  });

  it("коды ОКПД2 поднимаются из лотов на уровень закупки без повторов", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).okpd2Codes).toEqual(["28.24.12.190"]);
  });
});

describe("способ размещения", () => {
  it("аукцион секции zakupki ложится в ELECTRONIC_AUCTION", () => {
    expect(mapTektorgProcedure({ ...withEis, procedureTypeId: 2 }, ZAKUPKI).placingWay).toBe(
      "ELECTRONIC_AUCTION",
    );
  });

  it("запрос котировок ложится в REQUEST_FOR_QUOTATION", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).placingWay).toBe("REQUEST_FOR_QUOTATION");
  });

  it("тот же typeId в другой секции значит другое: 2 в 44fz — запрос котировок", () => {
    expect(
      mapTektorgProcedure({ ...withEis, procedureTypeId: 2 }, { sectionCode: "44fz" }).placingWay,
    ).toBe("REQUEST_FOR_QUOTATION");
  });

  it("запрос ценовой информации — не котировки: это сбор цен, а не закупка", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).placingWay).toBe("OTHER");
  });

  it("неизвестный typeId — OTHER, а не ошибка: словарь площадка пополняет", () => {
    expect(mapTektorgProcedure({ ...withEis, procedureTypeId: 999 }, ZAKUPKI).placingWay).toBe(
      "OTHER",
    );
    expect(() =>
      mapTektorgProcedure({ ...withEis, procedureTypeId: null }, ZAKUPKI),
    ).not.toThrow();
  });

  it("словарь перечисляет типы, снятые с живого ответа, вместе с их названиями", () => {
    expect(TEKTORG_PLACING_WAYS.zakupki?.[18]).toBe("REQUEST_FOR_QUOTATION");
    expect(TEKTORG_PLACING_WAYS["44fz"]?.[0]).toBe("ELECTRONIC_AUCTION");
  });
});

describe("служебные поля", () => {
  it("источник — TEK_TORG, ссылка ведёт на карточку площадки", () => {
    const t = mapTektorgProcedure(commercial, ZAKUPKI);
    expect(t.dataSource).toBe("TEK_TORG");
    expect(t.eisUrl).toBe("https://www.tektorg.ru/223-fz/procedures/19911463");
  });

  it("срок подачи переносится из dateEndRegistration", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).deadlines.submissionEnd).toBe(
      "2026-10-12T12:00:00+03:00",
    );
  });

  it("метка партии — syncedAt, когда она передана", () => {
    const t = mapTektorgProcedure(commercial, {
      sectionCode: "zakupki",
      syncStartedAt: "2026-10-01T03:00:00.000Z",
    });
    expect(t.syncedAt).toBe("2026-10-01T03:00:00.000Z");
  });

  it("требования, история изменений и документы пусты: экспорт их не содержит", () => {
    const t = mapTektorgProcedure(withEis, ZAKUPKI);
    expect(t.requirements).toEqual([]);
    expect(t.changeLog).toEqual([]);
    expect(t.documents).toEqual([]);
    expect(t.nationalRegime).toBe(false);
    expect(t.onlyForSmp).toBe(false);
  });
});
```

- [x] **Шаг 2: убедиться, что тесты падают**

Выполнить: `npx vitest run src/adapters/tender-source/tektorgMapper.test.ts`
Ожидание: «Failed to resolve import "@/adapters/tender-source/tektorgMapper"».

- [x] **Шаг 3: написать маппер**

`src/adapters/tender-source/tektorgMapper.ts`. Обязательные свойства:

1. Экспортирует `mapTektorgProcedure(procedure: TektorgProcedure,
   options?: TektorgMappingOptions): Tender` и `TEKTORG_PLACING_WAYS:
   Readonly<Record<string, Readonly<Record<number, PlacingWay>>>>`.
   `TektorgMappingOptions = { sectionCode?: string | null; syncStartedAt?: string | null }`.
   Секция нужна, потому что от неё зависят закон, ключ дедупликации и словарь типов.

2. `id` — `tektorg-${registryNumber}`: детерминированный, чтобы повторный прогон не плодил
   записи; ключ записи в базе всё равно `reg_number`.

3. `regNumber` — номер ЕИС, когда он известен, иначе номер площадки с префиксом
   `TEKTORG-`. В секции `zakupki` номер ЕИС — это `eisRegistryNumber`; в `44fz` его нет,
   а `registryNumber` уже является 19-значным номером ЕИС, поэтому префикс там не
   добавляется. `externalId` — всегда `registryNumber`: по нему работают карточка и
   документы.

4. `law`: `sectionCode === "44fz"` → `FZ_44`; иначе есть номер ЕИС → `FZ_223`; иначе
   `COMMERCIAL`. Секция не задана — считаем `zakupki`: адаптер ходит только в неё.

5. Словарь способов размещения — по секциям, значения сняты с живого ответа 01–02.10.2026
   и зафиксированы комментарием с названием типа и числом встреч:

   `zakupki`: 2 «Аукцион» → `ELECTRONIC_AUCTION`; 3 «Конкурс» → `OPEN_CONTEST`;
   4 «Запрос предложений» → `REQUEST_FOR_PROPOSALS`; 5 «Запрос цен» и 18 «Запрос
   котировок» → `REQUEST_FOR_QUOTATION`; 22 «Запрос оферт» → `REQUEST_FOR_PROPOSALS`;
   21 «Запрос предоставления ценовой информации» → `OTHER`; 30 «TYPE_30» → `OTHER`.

   `44fz`: 0 «Аукцион» → `ELECTRONIC_AUCTION`; 1 «Открытый конкурс» → `OPEN_CONTEST`;
   2 «Запрос котировок в электронной форме» → `REQUEST_FOR_QUOTATION`; 6 «Закупка
   товаров» → `OTHER`.

   Неизвестный или отсутствующий `typeId`, как и неизвестная секция, → `OTHER`, а не
   ошибка: словарь площадка пополняет (в живой выдаче встретился тип, у которого она сама
   печатает заглушку «TYPE_30»).

   **21 → `OTHER` — осознанное решение, а не пропуск.** Запрос предоставления ценовой
   информации собирает цены для обоснования НМЦК и не заканчивается договором; положить
   его в `REQUEST_FOR_QUOTATION` значило бы засорить фильтр котировок процедурами, где
   нечего выигрывать. Доля заметная — 19 из 105 процедур окна изменений.

6. `financial.price` — сумма цен лотов, если цена есть у всех; иначе `0`. Нуль в домене
   означает «цена не опубликована», а не бесплатную закупку (`isPriceKnown`), и занижать
   цену закупки из-за одного лота без цены нельзя. `currency` — из процедуры, по
   умолчанию «RUB».

7. `region` — `regionFromAddresses([procedure.region, procedure.organizerAddress,
   ...lots.flatMap((l) => l.deliveryAddresses)])`. Функция уже распознаёт и форму ФИАС
   («Город Москва столица Российской Федерации город федерального значения»), и адрес
   целиком в `<house>`, и «В соответствии с ТЗ» → «Не указан»; проверено на живых строках.

8. `customerName`/`customerInn` — заказчик первого лота, при его отсутствии организатор.
   Организатор проводит процедуру, а покупает заказчик: у ЗП6082206 это разные лица
   (ООО «РГ-СНАБЖЕНИЕ» против АО «РЕГИОНГАЗ-ИНВЕСТ»). Пустой заказчик — `UNKNOWN_CUSTOMER`.

9. `lots` — отсортированы по `number` по возрастанию: площадка отдаёт лоты и в обратном
   порядке (в фикстуре лот 2 лежит раньше лота 1). Пустой предмет лота названием
   процедуры не заменяется. `deliveryTermDays` — `null`: экспорт срока поставки не
   содержит.

10. `deadlines.submissionEnd` — `dateEndRegistration`, `publicationDate` — `datePublished`,
    `lastUpdateDate` — `dateUpdated` с откатом на `datePublished`. Пустая строка, когда
    даты нет: подставлять текущее время нельзя, а выдуманная дата сортировала бы закупку
    в ленте.

11. `documents` в `Tender` не заполняются: их отдаёт `fetchDocuments` адаптера, а не
    список процедур.

12. `requirements`, `changeLog`, `nationalRegime`, `onlyForSmp` — пустые/`false`: экспорт
    площадки этих сведений не содержит. Придумывать их нельзя — пустое требование и
    отсутствующее различаются в вердикте.

13. `eisUrl` — `urlToShowcase`: адрес карточки на площадке, а не на zakupki.gov.ru. У
    закупки, которой в ЕИС нет, еисовская ссылка была бы битой. Пустая строка, когда
    площадка карточку не отдала.

14. `syncedAt` — `options.syncStartedAt`, если передан: метка партии, по которой
    находится результат последнего прогона.

- [x] **Шаг 4: убедиться, что тесты проходят**

Выполнить: `npx vitest run src/adapters/tender-source/tektorgMapper.test.ts`
Ожидание: все зелёные. Факт: **32 passed (32)**.

Проверка на холостой ход: три правила сломаны одновременно (сумма лотов считает цену
несмотря на отсутствующую, сортировка лотов убрана, тип 21 положен в котировки) —
**3 failed | 29 passed**, то есть каждое правило покрыто своим тестом. Файл восстановлен,
повторный прогон зелёный.

- [x] **Шаг 5: прогнать гейт**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npx tsx scripts/check-distribution.ts
```

Факт: lint «✔ No ESLint warnings or errors», typecheck молча, «Test Files 114 passed (114) /
Tests 2363 passed (2363)» (на один файл и 32 теста больше, чем до задачи), build EXIT=0,
распределение `{RECOMMENDED: 10, MANUAL_REVIEW: 6, NOT_RECOMMENDED: 19}` на 35 закупках,
все шесть требований `true`, EXIT=0.

### Дополнение 02.10.2026: регион из названия процедуры

Правка внесена после живого сухого прогона задачи 5 и до первого настоящего прогона, чтобы
неверный регион не лёг в базу.

Что показал прогон: из 75 процедур за сутки **27 получили «Москва» (36 %)**, потому что поле
`<region>` у площадки часто пусто, место поставки лота стоит заглушкой («В соответствии с
документацией о закупке», «В соответствии с ТЗ»), и регион находился из адреса организатора.
Головной офис заказчика — не место работ. Из этих 27 как минимум 8 — ложные, и это видно по
названию: «Оказание услуг автотранспортными средствами **на о. Сахалин**», «перевозка
элементов строительных лесов **в г. Рязань**», кузовной ремонт в Башкортостане, медосмотры в
Тюменской области, заправка картриджей в Самарской области.

Правка: название процедуры и предметы лотов добавлены в список признаков региона **после**
места поставки и `<region>`, но **до** адреса организатора — и на уровне закупки
(`mapTektorgProcedure`), и на уровне лота (`mapTektorgLot`). Название работает только там,
где площадка не дала ни места поставки, ни региона, поэтому переопределить верный признак
оно не может; это закреплено отдельным тестом.

Три теста в `tektorgMapper.test.ts`: регион из названия при заглушке поставки; название не
перекрывает ни место поставки, ни `<region>`; регион поставки лота из предмета лота.
Первый и третий падали до правки ровно так, как надо, — «Москва» вместо «Сахалинская
область».

Проверка тем же живым прогоном после правки: расхождений названия и региона **ноль** (было
восемь), Москва — **19 из 75** вместо 27, закупка `32616428629` показывает «Сахалинская
область» и на уровне закупки, и на уровне лота.

Чего правка не лечит, и это надо помнить при разборе выдачи: `regionFromAddresses` знает
субъекты, но не города, поэтому «в г. Ангарск» региона не даёт (Ангарск — Иркутская область)
и такая закупка по-прежнему уедет в адрес организатора. Из 75 процедур субъект назван в
названии у 16, у остальных 59 признака нет вовсе. Дальше — либо словарь городов, либо место
поставки из документации; подробности в `docs/REFERENCE_TEK_TORG_API.md`, раздел «Регион».

---


## Задача 5: Адаптер порта и живой сухой прогон

**Файлы:**
- Создать: `src/adapters/tender-source/tektorgTenderSourceAdapter.ts`
- Создать: `src/adapters/tender-source/tektorgTenderSourceAdapter.test.ts`
- Изменить: `src/services/tenderSourceRegistry.ts:71-90` (привязка TEK_TORG)
- Изменить: `scripts/sync-eis.ts` (ветка запроса ТЭК-Торга)
- Изменить: `scripts/sync-profiles.json` (источник в профиле)

### Чем реализация задачи 5 отличается от написанного выше

Три правки, каждая — по живому зонду 01–02.10.2026.

**1. Файла `src/adapters/tender-source/registry.ts` не существует.** Привязки источников
живут в `src/services/tenderSourceRegistry.ts` (см. `SOURCE_BINDINGS`, запись TEK_TORG на
строках 71–90). Причина там же в шапке файла: привязка Контура создаёт адаптер через
`createKonturAdapter`, который читает бюджет из базы, а по правилам слоёв `adapters/` не
может импортировать `services/`.

**2. Окно публикации, а не окно изменений.** План звал `fetchTenders` с
`startUpdateAt`/`endUpdateAt`. Зонд 01.10.2026 по секции `zakupki`:

| Окно | Процедур | Приём заявок | Работа комиссии | Архив | Отменён |
| --- | --- | --- | --- | --- | --- |
| `startUpdateAt`/`endUpdateAt` | 105 | 10 | 27 | 72 | 2 |
| `startDate`/`endDate` | 75 | **76 лотов из 76** | 0 | 0 | 0 |

Окно изменений на две трети состоит из архива: площадка меняет запись и тогда, когда
приём заявок давно закрыт. Окно публикации возвращает только то, что опубликовано за
период, и все лоты в нём живые — значит, `activeOnly` в адаптере не нужен вовсе, а
`checkChanges` остаётся на окне изменений, где оно и уместно.

**3. `ATTACHMENT` в домене нет.** `TenderDocumentType`
(`src/domain/enums/index.ts:186`) — это `NOTICE | TECHNICAL_SPEC | DRAFT_CONTRACT |
PROJECT_DOCUMENTATION | COST_JUSTIFICATION | OTHER`. Документов лота в ответе тоже нет:
`<documents>` лежит на уровне процедуры. Тип определяется по имени файла готовой функцией
`mapKonturDocumentType(null, filename)` из `src/adapters/tender-source/konturParser.ts:328`.

**4. `sync-eis.ts` не опрашивает источник по реестру.** Скрипт строит по `SOURCE_BINDINGS`
только список источников и проверку связи, а сами запросы делает в трёх именованных ветках
(`wantEis`, `wantSber`, `wantKontur`, строки 658–746). Подключённая привязка без четвёртой
ветки напечатала бы «ТЭК-Торг» в заголовке профиля и «Новых закупок, TEK_TORG: 0» в итоге —
ровно то, против чего предостерегает собственный комментарий скрипта: «строка обещала бы
больше, чем делает прогон». Ветка обязательна.

**5. Один запрос на профиль, а не на ключевое слово.** В `exportRequestType` нет ни слов,
ни регионов: только даты, секция, номера, ИНН, тип и постраничная раздача. Значит, отбор по
словам локальный, а повторять запрос на каждое слово профиля значит скачать ту же страницу
(429 802 байта на 01.10.2026) несколько раз.

**6. Пустое тело при HTTP 200 — наблюдаемый случай.** Зонд 02.10.2026: из трёх запросов,
отправленных подряд без паузы, один вернулся **пустым телом** — ни конверта, ни Fault.
Повторный такой же запрос через секунду отдал нормальные 29 787 байт, значит это сбой
транспорта, а не поведение площадки. `parseProceduresResponse` на пустом теле бросает
`TektorgParseError` («в теле нет конверта Envelope») — значит, повторы нужны именно на нём.
Заодно зонд подтвердил: троттлинга на темпе «запрос в секунду» нет, а пустая выдача
площадки — это 793 байта с `<totalProcedures>0</totalProcedures>` и `<procedures/>`, ровно
как в фикстуре `TEKTORG_EMPTY_PAGE`.

- [x] **Шаг 1: написать падающие тесты адаптера**

Тесты не ходят в сеть: `fetch` подменяется через `vi.stubGlobal`, ответы — фикстуры
`tektorgTestFixtures.ts`. Обязательный набор:

1. `fetchTenders` за сутки отправляет один запрос с `limitPage=500`, секцией `zakupki` и
   периодом `startDate`/`endDate`, возвращает `Tender[]` с `dataSource: "TEK_TORG"`;
2. отбор по словам выполняется локально — площадка такого параметра не имеет:
   из трёх процедур фикстуры при `keywords: ["кузовному"]` остаётся одна (`ЗП610102`);
3. отбор по регионам тоже локальный и считает неизвестный регион неизвестным, а не чужим:
   при `regions: ["Ульяновская область"]` остаётся `ЗП6091269`, а при
   `regions: ["Москва"]` — `ЗП6082206` и `ЗП610102`;
4. `customerInns` из запроса уходят в конверт полем `customerINN` — единственная
   фильтрация, которую площадка умеет; несколько ИНН означают несколько запросов, потому
   что WSDL допускает `maxOccurs="1"`;
5. `limit` обрезает выдачу после отбора, а не до;
6. HTTP 500 повторяется `maxRetries` раз, затем бросается;
7. оборванное тело (`TEKTORG_TRUNCATED`) повторяется так же, как сетевой сбой: это сбой
   транспорта, а не отказ площадки;
8. `TektorgSoapFaultError` не повторяется: это не сбой сети, а отказ площадки;
9. `fetchDocuments(id)` возвращает по одному `TenderDocument` на каждый документ с `<file>`:
   `url` — адрес из `<file>`, `fileName` — из `<filename>` ответа, `type` — из
   `mapKonturDocumentType(null, fileName)`, `text` пустой (текст загружает воркер);
10. `<removed>` документом не становится: адреса у него нет, и площадка отдала бы страницу
    ошибки, которую парсер принял бы за текст документа;
11. `fetchTenderById` ищет по `registryNumber` и возвращает `null` для процедуры, которой
    нет в ответе, а не бросает;
12. `fetchTenderById` принимает и внутренний id (`tektorg-ЗП610102`), и номер (`ЗП610102`),
    и номер с префиксом (`TEKTORG-ЗП610102`);
13. `checkChanges(tenderId, since)` использует `startUpdateAt = since` и возвращает `true`,
    если процедура пришла в дельте;
14. пауза между запросами соблюдается: два запроса разделяет не меньше `1000 / rateLimitPerSec`.

Про `eisRegistryNumber` отдельного теста нет, и это решение, а не упущение. Зонд
02.10.2026: заведомо несуществующее `eisRegistryNumber=99999999999` вернуло всю секцию
(5 процедур из `limitPage=5`, `totalProcedures` 136 256), а несуществующее
`registryNumber=ЗП9999999` — ноль. Площадка параметр игнорирует, поэтому точечный поиск по
номеру извещения ЕИС невозможен, и `fetchTenderById` обязан ходить по `registryNumber`.

- [x] **Шаг 2: убедиться, что тесты падают**

Выполнить: `npx vitest run src/adapters/tender-source/tektorgTenderSourceAdapter.test.ts`
Ожидание: «Cannot find module».

- [x] **Шаг 3: написать адаптер**

Обязательные свойства:

1. Класс `TektorgTenderSourceAdapter` реализует `TenderSourceAdapter` из
   `src/adapters/types.ts` — все четыре метода, без `any`.
2. Опции: `{ rateLimitPerSec, maxRetries, timeoutMs, sectionCode?, lookbackDays?,
   pageSize?, maxPages?, nowProvider?, fetchImpl? }`. Пауза между запросами соблюдается
   так же, как в `sberAstTenderSourceAdapter.ts` — образец брать оттуда.
3. Заголовки — `TEKTORG_REQUEST_HEADERS` из задачи 3, а не literals: `Content-Type:
   text/xml; charset=utf-8`, `SOAPAction: urn:procedures`.
4. Успех определяется телом, а не кодом и не заголовком: площадка отвечает 200 с
   `Content-Type: text/html`. Проверка — в `parseProceduresResponse` (задача 3).
5. Повторы — на сетевой ошибке, на `!res.ok` и на `TektorgParseError`, с экспоненциальной
   задержкой. На `TektorgSoapFaultError` — сразу наружу: повтор не починит отказ площадки,
   а «Section not found.» должен доехать до оператора дословно.
6. Таймаут по умолчанию 60 с: страница из 500 процедур приходила за 20,3 с, а полный
   ответ секции — до 26 с. Зонд 02.10.2026: страница из 5 процедур — 8,5–10,7 с, то есть
   площадка медленная всегда, а не только на большой выдаче.
7. Окно по умолчанию — сутки назад от `nowProvider()`, секция `zakupki`
   (`TEKTORG_ZAKUPKI_SECTION` из задачи 4).
8. Пагинация: `pageSize` 500, выход по `currentPage >= totalPage` или по короткой странице,
   дедупликация по `id` процедуры — выдача может повторять запись на границе страниц.
9. Ошибки бросаются своими классами, и `describeError` из `src/lib/errors` обязан их
   распознавать — проверить, что сообщение в логе человекочитаемое.

- [x] **Шаг 4: подключить привязку и ветку прогона**

`src/services/tenderSourceRegistry.ts` — заменить заглушку в `create()` привязки
`TEK_TORG`:

```ts
    async create() {
      return new TektorgTenderSourceAdapter({
        rateLimitPerSec: RATE_LIMIT_PER_SEC,
        maxRetries: MAX_RETRIES,
      });
    },
```

`honoursRegions` остаётся `false`, но комментарий к нему устарел: адаптер применяет
регион локально, как Контур.Закупки. Флаг означает «площадка фильтрует на своей стороне»,
поэтому значение верное, а текст нужно привести к факту.

`scripts/sync-eis.ts` — добавить `const tektorgAdapter = adapters.get("TEK_TORG") ?? null;`
рядом с остальными (строка 558), `wantTektorg` в `queried` и ветку запроса **вне** цикла по
ключевым словам, передав `keywords: profile.keywords` целиком:

```ts
      // ТЭК-Торг: экспорт площадки не принимает ни слов, ни регионов, поэтому
      // запрос один на профиль, а отбор локальный. Цикл по ключевым словам
      // скачивал бы ту же страницу на каждое слово.
      if (wantTektorg && tektorgAdapter) {
        const fetched = await collectFrom(
          "ТЭК-Торг",
          profile.keywords.join(" "),
          () =>
            tektorgAdapter.fetchTenders({
              laws: profile.laws.length > 0 ? profile.laws : ["FZ_223", "COMMERCIAL"],
              keywords: profile.keywords,
              minPrice: profile.minPrice ?? null,
              maxPrice: profile.maxPrice ?? null,
              regions: regionNames.length > 0 ? regionNames : undefined,
              limit: profile.limitPerKeyword ?? 10,
            }),
          unique,
        );
        perSource.set("TEK_TORG", (perSource.get("TEK_TORG") ?? 0) + fetched);
      }
```

`scripts/sync-profiles.json` — добавить `"TEK_TORG"` в `sources` того профиля, который
собирает коммерческие закупки (рядом с `SBER_AST`).

Тест «интервал платного источника задан, бесплатного — нет» остаётся зелёным: ТЭК-Торг
бесплатный, `cadenceHours: null`. В ветку `--dry-run` платный источник не прячем: запрос
бесплатный, и прятать его значило бы лишить сухой прогон смысла.

- [x] **Шаг 5: убедиться, что тесты проходят, и прогнать гейт**

```bash
npx vitest run src/adapters/tender-source/tektorgTenderSourceAdapter.test.ts
npm run lint && npm run typecheck && npm test && npm run build && npx tsx scripts/check-distribution.ts
```

- [x] **Шаг 6: живой сухой прогон**

```bash
npx tsx scripts/sync-eis.ts --dry-run --sources=TEK_TORG --limit=50
```

Ожидание в выводе: `Проверка связи · ТЭК-Торг: доступен`, число процедур в суточном окне
публикации (на 01.10.2026 — **75**, а не «порядка 200»), сколько отсеяно профилем, сколько
совпало с ЕИС по номеру извещения (на 01.10.2026 — 49 из 75 несут `eisRegistryNumber`, то
есть чистый прирост источника — 26 закупок), и ни одной записи в базу. Запрос бесплатный,
расход тарифа Контур.Закупок не меняется — проверить до и после через
`GET https://tender-fit.ru/api/kontur/usage` (`spentTodayByMethod` не должен вырасти).

Если окно пустое (площадка не публиковала процедур за сутки) — это не сбой: проверить
период, расширив его до семи суток, и убедиться, что разбор работает на непустом ответе.

---

## Задача 6: Миграция и первый настоящий прогон

**Файлы:**
- Создать: `supabase/migrations/20261001000006_add_tek_torg_source.sql`

- [x] **Шаг 1: написать миграцию**

По образцу `supabase/migrations/20260921000003_add_kontur_source.sql`, раздел 1: найти
имя CHECK-ограничения через `pg_constraint` (оно генерируется автоматически), снять его и
добавить заново со значением `TEK_TORG` в списке:

```sql
-- 20261001000006_add_tek_torg_source.sql
-- Источник «ТЭК-Торг» (api.tektorg.ru): значение TEK_TORG в tenders.data_source.
--
-- ПРИМЕНЯТЬ ЧЕРЕЗ SQL EDITOR: Supabase CLI в этом проекте не работает.
-- Проект zeypawygxijctavhasyn (Stockholm).
-- Зависит от 20260921000003_add_kontur_source.sql — применяйте по порядку.
--
-- Новых колонок и таблиц не нужно: raw_data и synced_at добавлены миграцией
-- Контур.Закупок и пригодятся любому источнику, а кэш сырых ответов ТЭК-Торг
-- не нужен — экспорт бесплатный, повторный запрос ничего не стоит.

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

comment on constraint tenders_data_source_check on public.tenders is
  'Источник строки. TEK_TORG добавлен 01.10.2026: бесплатный экспорт процедур с байтами документов.';
```

- [ ] **Шаг 2: применить миграцию**

Миграция применяется вручную через SQL Editor проекта `zeypawygxijctavhasyn` — CLI в этом
проекте не работает. Это действие над прод-базой: перед применением сказать владельцу,
что будет выполнено, и получить слово. Порядок «сначала код, потом данные» уже соблюдён:
`byDefault: false` не даёт источнику попасть в плановый прогон до этого шага.

- [ ] **Шаг 3: включить источник в профиль и прогнать по-настоящему**

Добавить `"TEK_TORG"` в `sources` профиля «Строительство и ремонт» в
`scripts/sync-profiles.json` — рядом с `"KONTUR"`.

```bash
npx tsx scripts/sync-eis.ts --sources=TEK_TORG --limit=50
```

- [ ] **Шаг 4: сверить результат с базой**

Проверить через `GET https://tender-fit.ru/api/tenders` (или SQL Editor):

1. появились строки `data_source = 'TEK_TORG'`;
2. ни одного дубля: `select reg_number, count(*) from tenders group by reg_number having
   count(*) > 1` — пусто. Правило «одна закупка — одна строка» уже реализовано в
   `tenderRepository.upsertByRegNumber`, но проверить нужно, потому что префикс
   `TEKTORG-` — новый ключ;
3. у процедур с `eisRegistryNumber` `reg_number` равен номеру ЕИС и строка не задвоилась
   с еисовской;
4. у каждой новой строки заполнены `subject`, `region` (если площадка его отдала) и
   `eis_url`, ведущий на tektorg.ru;
5. у закупок без цены в `financial.price` пусто, и лента показывает их с пометкой «цена не
   указана» (поведение задачи #98).

Записать фактические числа в `docs/REFERENCE_TEK_TORG_API.md` — раздел с итогом первого
прогона, по образцу записи про Контур.Закупки от 24.09.2026.

- [ ] **Шаг 5: прогнать гейт и задеплоить воркер**

Гейт целиком, затем деплой воркера на российский сервер — именно он выполняет плановую
синхронизацию:

```bash
TENDERFIT_SSH_KEY=~/.ssh/id_ed25519_tenderfit_vps \
TENDERFIT_VPS=root@5.35.86.186 deploy/deploy-worker.sh
```

Без `--restart`: скрипт печатает команду, а перезапуск прерывает текущее задание — решать,
сейчас ли это уместно, должен человек. Перед перезапуском убедиться, что очередь пуста
(`GET https://tender-fit.ru/api/sync-jobs` → `status.pending: 0` и `lastJob.status` не
`processing`). База нормативов на сервере уже лежит, флаг `--with-base` не нужен.

---

## Задача 7: Документы ТЭК-Торга через очередь воркера

**Файлы:**
- Изменить: `src/domain/sources.ts` (`documents`, `documentsReason` и новое поле
  `publishedInEis` у TEK_TORG)
- Изменить: `src/services/tenderDocumentsFetcher.ts` (`publishedInEis` и план загрузки
  байтов площадки)
- Изменить: `src/domain/sources.test.ts` (ожидание про список источников с документами)
- Изменить: `src/services/tenderDocumentsFetcher.test.ts` (ЕИС не ищет номер площадки)

- [x] **Шаг 1: изменить тест, а не код**

`src/domain/sources.test.ts` — ожидание из задачи 1 (`documentationSources()` равен
`["EIS", "KONTUR"]`) заменить на `["EIS", "TEK_TORG", "KONTUR"]` в порядке каталога и
добавить проверку, что у ТЭК-Торга больше нет причины отказа:

```ts
  it("документацию отдают ЕИС, ТЭК-Торг и Контур.Закупки", () => {
    expect(documentationSources()).toEqual(["EIS", "TEK_TORG", "KONTUR"]);
  });

  it("ТЭК-Торг отдаёт байты документов без ключа", () => {
    expect(sourceFacts("TEK_TORG").documents).toBe("bytes");
    expect(sourceFacts("TEK_TORG").documentsReason).toBeNull();
  });
```

Выполнить: `npx vitest run src/domain/sources.test.ts`
Ожидание: оба новых теста КРАСНЫЕ — каталог ещё говорит `"none"`.

- [x] **Шаг 2: переключить каталог**

`src/domain/sources.ts`, запись TEK_TORG: `documents: "bytes"`, `documentsReason: null`.
Комментарий «До задачи 7 байты не скачиваются» удалить.

Выполнить: `npx vitest run src/domain/sources.test.ts src/domain/deepAnalysis.test.ts`
Ожидание: зелёные.

- [x] **Шаг 3: разделить «документация читаема» и «публикуется в ЕИС»**

Шаг 2 ломает загрузчик, если остановиться на нём: `publishedInEis` в
`src/services/tenderDocumentsFetcher.ts:38` возвращает
`DOCUMENTATION_SOURCES.includes(dataSource)`, а после переключения каталога ТЭК-Торг в этот
список входит. Дальше `planFetch` построил бы `eisPrintFormUrl("TEKTORG-ЗП610102")` — адрес
ЕИС с номером, которого в ЕИС нет, — и обход ушёл бы в реестр за чужой закупкой. Два разных
факта сидели в одном списке; их нужно развести.

Сначала тест (`src/services/tenderDocumentsFetcher.test.ts`), оба ожидания КРАСНЫЕ:

```ts
  it("ТЭК-Торг не публикуется в ЕИС: обход не идёт в реестр с номером площадки", () => {
    expect(
      publishedInEis({ dataSource: "TEK_TORG" }),
    ).toBe(false);
  });

  it("для ТЭК-Торга план не строит адрес печатной формы ЕИС", () => {
    expect(
      expectedDocumentFilename({
        regNumber: "TEKTORG-ЗП610102",
        law: "COMMERCIAL",
        dataSource: "TEK_TORG",
      }),
    ).toBeNull();
  });
```

Потом каталог: в `SourceFacts` добавить поле `readonly publishedInEis: boolean` — `true` у
ЕИС и Контур.Закупок (агрегатор отдаёт тот же номер извещения), `false` у остальных, —
и функцию `eisPublishedSources()`. `publishedInEis` в сервисе читает каталог:

```ts
export function publishedInEis(target: Pick<TenderDocumentTarget, "dataSource">): boolean {
  return sourceFacts(target.dataSource).publishedInEis;
}
```

`DOCUMENTATION_SOURCES` остаётся списком «разбор возможен» и больше не отвечает на вопрос
«где искать байты». Комментарий над `publishedInEis` переписать: он объясняет, что список
один на две задачи, а это как раз то, что оказалось неправдой.

- [x] **Шаг 4: научить загрузчик брать байты площадки**

Сделано не совсем так, как написано выше, и отступление стоит того, чтобы его зафиксировать.
Ветка появилась не в `planFetch` внутри `tenderDocumentsFetcher.ts`, а в загрузчике
`scripts/fetch-tender-documents.ts`: после того как ЕИС ответила «недоступно», функция
`trySourceDocuments` читает `data_source` закупки и выбирает запасной путь — ТЭК-Торг
(бесплатный SOAP-экспорт, включён всегда) или Контур.Закупки (платная карточка, только под
флагом `--kontur-cards`). Причина в том, что `planFetch` строит план из страниц реестра, а у
площадки плана нет: список документов приходит из экспорта процедур вместе с отметкой
`<removed>`. Тащить площадку внутрь планировщика значило бы смешать два разных способа
узнать список файлов.

Сама загрузка вынесена в `src/services/tektorgDocumentFetch.ts` — порты вместо сети и базы,
18 тестов. Нумерация одинаковых имён вынесена в общий `src/services/attachmentFilenames.ts`,
и платный путь Контура переведён на неё же: две копии одного правила — это две возможности
разойтись. В адаптере появился метод `readDocumentList`, который, в отличие от
`fetchDocuments`, не выбрасывает снятые с публикации документы: загрузчику нужен сам факт
отзыва, чтобы записать причину, а не потерять файл молча.

Заодно исправлена настоящая ошибка драйвера: статус `already` («документы уже в базе») не
считался успехом, и закупка, у которой всё уже загружено, не попадала в очередь разбора.
Теперь считается.

Все три требования шага проверены тестами: печатную форму ЕИС план не строит
(`publishedInEis` — шаг 3), причина отказа не возвращается (`documents: "bytes"` в каталоге —
шаг 2), отозванный документ попадает в пропущенные с причиной про отзыв.

Живьём проверено без записи в базу (миграция ещё не применена): `ЗП610102` — 2 документа,
44 380 байт, 17 945 знаков; `ЗП6082206` — 3 документа, 262 269 знаков при бюджете 400 000,
а при бюджете 30 000 оба архива помечены «не влез в бюджет» без единого скачивания. Числа
лежат в `docs/REFERENCE_TEK_TORG_API.md`, раздел «Документы площадки».

- [ ] **Шаг 5: живой прогон документации**

```bash
npx tsx scripts/fetch-tender-documents.ts --tender <номер TEKTORG-...> --no-worker
```

Номер взять из первого настоящего прогона (задача 6, шаг 4) — закупку, которой нет в ЕИС.
Ожидание: в `tender_documents` появились строки с непустым `text`, в логе число файлов и
знаков, платных запросов ноль (ТЭК-Торг бесплатный, Контур не вызывается).

- [ ] **Шаг 6: первый глубокий разбор**

Разбор платный: суточный лимит 20 (`src/domain/analysisQuota.ts`) не меняется, а тратит его
владелец. Поэтому шаг выполняется только после его слова. Проверка: на карточке закупки
`data_source = 'TEK_TORG'` активна кнопка глубокого разбора, после прогона в карточке
есть находки и вердикт пересчитан.

- [ ] **Шаг 7: прогнать гейт и задеплоить**

Гейт целиком, затем три деплоя в порядке: Vercel → воркер → приложение.

```bash
npx vercel deploy --prod --yes
TENDERFIT_SSH_KEY=~/.ssh/id_ed25519_tenderfit_vps TENDERFIT_VPS=root@5.35.86.186 deploy/deploy-worker.sh
TENDERFIT_SSH_KEY=~/.ssh/id_ed25519_tenderfit_vps TENDERFIT_VPS=root@5.35.86.186 deploy/deploy-app.sh
```

Порядок важен: приложение и воркер живут в одном каталоге `/opt/tenderfit-ai`, и
`deploy-app.sh` пересобирает `.next` и перезапускает `tenderfit-app`. Если деплой
приложения идёт последним, рассинхрона `.next` и `node_modules` не остаётся. Перезапуск
воркера — только когда очередь пуста.

---

## Итоговая проверка

- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` и
  `npx tsx scripts/check-distribution.ts` — зелёные по всему дереву до и после каждой
  задачи. Дерево правят несколько сессий, поэтому гейт прогоняется непосредственно перед
  деплоем, а не «по своим файлам».
- Тест покрытия: `SOURCES`, `SOURCE_BINDINGS` и `TenderDataSource` описывают одно и то же
  множество источников; добавить источник в домен и забыть в адаптерах больше нельзя.
- Живой сухой прогон печатает, сколько процедур пришло, сколько отсеяно профилем и сколько
  совпало с ЕИС по номеру, и не пишет в базу.
- Первый настоящий прогон: в ленте закупки с `data_source: TEK_TORG`, у каждой есть предмет
  и хотя бы один документ, у закупки без номера ЕИС активна кнопка глубокого разбора.
- Бюджет Контур.Закупок не изменился: `spentTodayByMethod` до и после прогона ТЭК-Торга
  одинаковый.
- Дублей нет: `select reg_number, count(*) from tenders group by reg_number having
  count(*) > 1` возвращает пусто.

## Что остаётся за пределами плана

- Полный перебор 136 254 процедур секции `zakupki` (273 страницы, порядка полутора часов,
  ~1,3 ГБ ответов). Первая волна — суточная дельта: ценность в свежих закупках с открытым
  сроком подачи, а не в архиве закрытых. Решение о полном переборе принимает владелец.
- Серверный полнотекст по документации — задача #99. Понадобится, когда строк станет
  больше нескольких тысяч: сейчас лента ранжирует то, что пришло из `/api/tenders`
  (до 1000 строк).
- Отключение Контур.Закупок. После 03.10.2026 источник отключится сам, если подписку не
  продлят: код к этому готов штатной веткой `create(): null` и остановкой источника по
  `KonturAuthError` (`konturSourceStop`).
- Площадки, закрытые антиботом или отдающие список только внутренним API со статическим
  токеном из JS-бандла. Обходить защиту мы не будем.

## Дополнение 02.10.2026: Росэлторг подключён, Фабрикант нет

План описывал ТЭК-Торг, но владелец попросил завести «туда же» ещё две площадки —
Фабрикант и Росэлторг. Зонд третьей волны закрыл обе зацепки
(`docs/REFERENCE_PLATFORM_PROBES.md`, раздел «Третья волна»), и решения разошлись.

**Росэлторг подключён по-настоящему.** Публичный вход нашёлся там, где первая волна его не
искала: не на ExtJS-оболочке `com.roseltorg.ru`, а на `www.roseltorg.ru/procedures/search`,
которая отправляет форму на `/procedures/search_ajax?page=N` и возвращает фрагмент выдачи
(59 649 байт и 10 строк против 426 781 байта полной страницы, 0,09 с). Ключа не требует,
`robots.txt` хоста `www` содержит `Allow: /procedures/search?page=` и не запрещает ни
`search_ajax`, ни карточку процедуры.

Сделано поверх плана, тем же устройством слоя — каталог, привязка, адаптер:

- `src/adapters/tender-source/roseltorgSearch.ts` — адрес поиска, словарь секций, разбор
  фрагмента выдачи, цена, валюта, срок приёма заявок;
- `src/adapters/tender-source/roseltorgMapper.ts` — лоты одной процедуры в `Tender`;
- `src/adapters/tender-source/roseltorgTenderSourceAdapter.ts` — порт, отбор, счётчики;
- `src/adapters/tender-source/roseltorgTestFixtures.ts` — фикстуры, снятые с живой выдачи;
- запись `ROSELTORG` в `SOURCES` и `SOURCE_BINDINGS`, значение в `TenderDataSource`,
  подписи в `src/lib/labels.ts`, ветка в `scripts/sync-eis.ts`, источник во всех трёх
  профилях `scripts/sync-profiles.json`;
- `supabase/migrations/20261002000007_add_roseltorg_source.sql` — зависит от миграции
  ТЭК-Торга и применяется после неё.

Три правила, которых в плане не было, потому что их показала только живая выдача:

1. **Строка выдачи — это лот, а не закупка.** Поиск по слову возвращает совпавшие лоты:
   «насадка» нашла только лоты 196 и 197 процедуры `B2509261618185`, где их больше сотни с
   ценами от 250 ₽ до 280 000 ₽. Сложить цены найденного — значит показать закупку за 220 ₽
   там, где она стоит миллионы. Переносить сюда правило `mergeSberTenders` нельзя. Поэтому
   из выдачи берутся только номера процедур, а полный набор лотов добирается отдельным
   запросом `query_field={номер}`; цена — сумма всех лотов, а если набор неполный, смешаны
   валюты или у лота нет цены, цена не публикуется вовсе.
2. **Приоритет ниже агрегаторов (15, между Контуром и демо-данными)** — единственное
   осознанное нарушение порядка «площадка-первоисточник выше агрегатора». Запись Росэлторга
   беднее всех: нет даты публикации, кодов ОКПД2 и документов, а секции 223-ФЗ печатают
   номер извещения ЕИС, то есть совпадение с чужой строкой вероятно. `update` пишет null на
   место отсутствующих значений, поэтому без этого правила прогон стёр бы ОКПД2, дату и
   ссылку на карточку реестра. Ценность источника — процедуры с собственными номерами
   площадки (префикс `ROSELTORG-`), у которых совпадений не бывает вовсе: из 60 проверенных
   зондом строк таких 44.
3. **Конец обхода определяют два признака, и оба — слова площадки**: «Нет результатов» на
   странице вне диапазона и отсутствие кнопки «Далее». Длину страницы признаком не считать:
   10 строк площадка держит всегда, а в доборе лотов короткая страница с живой кнопкой
   означала бы неполный набор и заниженную сумму, которая выглядит полной. Даты фильтрами не
   задаются вовсе (`start_date_published` и `end_date_published` игнорируются), поэтому
   закрытое отсеивается по сроку приёма заявок в самой строке — «Портал Поставщиков»
   печатает «Прием заявок» со сроком десять месяцев назад, и `status[]=0` от этого не спасает.

Документов нет: ссылки ведут на `com.roseltorg.ru/file/get/…`, а `robots.txt` того хоста —
`Disallow: /`; тот же путь на `www` отвечает 404. Значит `documents: "none"`, честная
`documentsReason` в каталоге, пустой список из `fetchDocuments` без единого запроса и
никакого значения `roseltorg_api` в `tender_documents.source_type` — записывать его некому.

Живой сухой прогон 02.10.2026, только Росэлторг, три профиля: **130 уникальных закупок за
111,6 с**, база не тронута. «Автомобили» — 201 строка выдачи, 115 процедур, добрано 50, в
выдаче 50; «Компьютеры и оргтехника» — 173 строки, 61 процедура, добрано 56, в выдаче 50
(6 отброшены фильтром цены); «Строительство и ремонт» — 150 строк, 109 процедур, 30 и 30.
Отброшено строк с истёкшим сроком приёма заявок: 43, 55 и 35. Первый прогон показал 107
закупок и «предел запросов по номерам достигнут» в двух профилях из трёх: потолок добора
лотов (40) оказался ниже `limit` профиля из пяти слов (50), то есть выдачу резала страховка,
а не настройка. Потолок поднят до 60, после чего оба профиля добирают ровно свой `limit`.

**Фабрикант не подключён, и это решение, а не очередь** *(отменено тем же днём — см.
дополнение «Фабрикант подключён» ниже)*. Коммерческая секция у площадки
есть, и первая волна ошиблась, назвав её зеркалом ЕИС: из десяти карточек живой выдачи у трёх
`purchaseOosNumber` равен `null` — это закупки, которых в реестре нет. Но в карточке списка
нет ни региона, ни ИНН, ни ОКПД2, а цена лежит позиционно внутри flight-потока
(`["854 404",["$","span",…,[",","90"," ","RUB"]]]`) — парсить её значит привязываться к
порядку элементов в сериализованном React-дереве. Все нужные поля есть только на
`/v2/trades/procedure/view/{id}`, то есть по запросу на каждую закупку (N+1) там, где
Росэлторг обходится двумя. Документация закрыта со всех четырёх сторон: `content.` —
`Disallow: /` и `Crawl-delay: 3`; `www` запрещает `/files/`, `?action=download` и
`?action=xml_export_auctions`; `api.` отвечает 403; у `44.` robots нет, но и прямых ссылок на
файлы в карточке нет. Записи в каталоге источников нет: раздел зонда и есть причина, а
заглушка без объяснения нарушила бы правило проекта. Вернуться стоит, если площадка откроет
экспорт (строка `action=xml_export_auctions` намекает, что механизм существует) или появится
договор, который заодно решит вопрос с байтами.

Что из этого следует для архитектуры «10 площадок»: автоматическая выгрузка байтов без
договора недоступна нигде, кроме ЕИС и ТЭК-Торга, и это не техническое ограничение, а
заявленная политика площадок. Зато список процедур без ключа читается у многих — Росэлторг
стал третьим таким источником, и его прирост измеряется не извещениями 223-ФЗ, которых полно
в реестре, а процедурами с номерами площадки, которых там нет вообще.

## Дополнение 02.10.2026 (вечер): Фабрикант подключён

Тем же днём владелец отменил решение выше одним словом — «сделай фабрикант». Адаптер
построен тем же устройством слоя, что Росэлторг и ТЭК-Торг:

- `src/adapters/tender-source/fabrikantSearch.ts` — адрес поиска, словарь секций, statuses,
  разбор RSC-потока: строки выдачи, пагинация и три исхода поиска;
- `src/adapters/tender-source/fabrikantCard.ts` — карточка `/v2/trades/procedure/view/{id}`:
  панели, организатор, номер извещения ЕИС, лоты, число страниц и вид адреса строки выдачи;
- `src/adapters/tender-source/fabrikantMapper.ts` — процедура с набором лотов в `Tender`;
- `src/adapters/tender-source/fabrikantTenderSourceAdapter.ts` — порт, отбор, счётчики;
- `src/adapters/tender-source/fabrikantTestFixtures.ts` — фикстуры, собранные по живым
  ответам; контактные данные в них заменены заглушками;
- запись `FABRIKANT` в `SOURCES` (приоритет 35) и `SOURCE_BINDINGS`
  (`probeUrl: https://www.fabrikant.ru/`, `cadenceHours: null`, `honoursRegions: true`),
  значение в `TenderDataSource`, подписи в `src/lib/labels.ts`, ветка в
  `scripts/sync-eis.ts`, источник во всех трёх профилях `scripts/sync-profiles.json`;
- `supabase/migrations/20261002000008_add_fabrikant_source.sql` — применяется после миграций
  ТЭК-Торга и Росэлторга: каждая миграция переписывает CHECK `data_source` целиком.

Довод, по которому Фабрикант отложили, — запрос на каждую закупку — не подтвердился ценой:
живой прогон трёх профилей занял 119,8 с при бюджете задачи в 25 минут. Подтвердился
второй довод, хрупкость: RSC-поток Next.js придётся пересобирать из кусков, а карточка —
легаси jQuery SSR с панелями по классам. Документов нет по-прежнему (`content.fabrikant.ru`
— `Disallow: /`), поэтому `documents: "none"`, честная `documentsReason` и пустой список из
`fetchDocuments` без единого запроса.

Четыре правила, которых в плане не было, потому что их показала только живая площадка:

1. **У поиска три исхода, а не два.** Кроме выдачи и честной пустоты «По вашему запросу
   ничего не найдено» площадка отвечает отказом показать: «Доступ к просмотру процедуры
   ограничен … авторизуйтесь на ЭТП» при HTTP 200. Признак — одна дословная фраза, потому
   что площадка режет предложение на четыре текстовых узла RSC и склеенного предложения в
   flight-тексте нет. Это правило площадки, а не факт о рынке, и подменять его пустотой
   значило бы сказать владельцу, что таких закупок не существует.
2. **Обход ключевых слов независим.** Отказ по одному слову не отменяет выдачу по
   остальным: `try/catch` на слово, счётчики `restrictedKeywords` и `failedKeywords`,
   падение только когда не ответило ни одно слово. Иначе исключение уносит из `fetchTenders`
   уже собранные результаты — живой прогон потерял так весь профиль из пяти слов.
3. **Статистика адаптера сбрасывается в начале каждого вызова и печатается только после
   состоявшегося запроса.** `filterStats` живёт в адаптере, а одним адаптером прогон обходит
   несколько профилей: после сбоя числа принадлежат предыдущему профилю. Драйвер печатал
   «ОШИБКА …» и следом 99 строк выдачи соседнего профиля. Правило общее для Фабриканта,
   Росэлторга и ТЭК-Торга: `collectFrom` возвращает `{ found, ok }`, и при `ok === false`
   строки статистики нет вовсе — причину уже назвала строка ошибки.
4. **Причина пропуска строки зависит от вида её адреса.** Строка выдачи ведёт не только на
   карточку `/v2`: «Маркет», секция Росатома, секция 44-ФЗ и извещения ЕИС — разные факты.
   `fabrikantCardUrlKind` различает их, `isFabrikantCardUrl` — это ровно `kind === "v2"`, а
   общий счётчик «карточка вне публичного хоста» смешивал дубль ЕИС (не потеря: то же
   извещение приносит адаптер реестра и с документами) с настоящей потерей.

Регион площадка в строке выдачи не печатает, а `customer_region_ids[]` фильтрует по региону
заказчика, а не по месту поставки: закупка с поставкой в нужный субъект исчезла бы без
следа. Поэтому регион применён по карточке на стороне адаптера, а закупки с неопределённым
регионом считаются отдельной причиной. Границы цены площадке намеренно не передаются, хотя
`price_from` и `price_to` она принимает: не замерено, отбрасывает ли серверный фильтр
закупки «Без указания цены», а потерять их молча нельзя. ОКПД2 в выдаче нет вовсе, поэтому
коды не передаются — параметр, уходящий впустую, создавал бы ложное впечатление фильтра.

Живой сухой прогон 02.10.2026, только Фабрикант, три профиля: **96 уникальных закупок за
119,8 с**, база не тронута. «Автомобили» — 99 строк выдачи, 67 процедур (57 с номером ЕИС),
в выдаче 50; «Компьютеры и оргтехника» — 44 строки, 28 процедур (20 с номером ЕИС), в выдаче
21, и по одному слову площадка ответила ограничением доступа; «Строительство и ремонт» —
58 строк, 43 процедуры (15 с номером ЕИС), в выдаче 30. Отброшено строк: «Маркет» 6, секция
Росатома 25, прочее 1.

Первый прогон до исправлений занял 78,2 с и показал 80 новых закупок, из которых профиль
«Компьютеры и оргтехника» не дал ни одной: слово «МФУ» упёрлось в страницу с ограниченным
доступом, адаптер принял исправный HTTP 200 за чужую страницу, потратил три повтора и
уронил весь профиль, а журнал напечатал рядом с ошибкой статистику соседнего профиля. Все
три дефекта поймал живой прогон — тесты на фикстурах их не ловили, потому что фикстуры
строились по выдаче, а не по отказу.

Слои и проверки: `npx tsc --noEmit` чисто, `npm run lint` чисто, 2719 тестов в 124 файлах
зелёные, `npm run build` собирается. До деплоя владелец применяет миграции в порядке имён
файлов: ТЭК-Торг → Росэлторг → Фабрикант.
