import { extractLlmJson } from "@/lib/llmJson";
import { z } from "zod";

import { isServiceItem } from "@/domain/estimate/autoServices";
import { clip, type NormPickCandidate } from "@/domain/estimate/normCandidates";
import { findNorms, normKey, type NormSearchIndex } from "@/domain/estimate/matchNorms";
import { EQUIPMENT_DEMOLITION, formatDecimal } from "@/domain/estimate/normatives";
import { normalizeText } from "@/domain/estimate/normalize";
import { MAX_REQUEST_RESOURCES, type ResourcePickCandidate } from "@/domain/estimate/resourceCandidates";
import type { AiNormPick, BillOfWorkItem, CustomerConditions, NormRecord } from "@/domain/estimate/types";
import { deriveUnitDivisor } from "@/domain/estimate/units";

/**
 * «ИИ-сметчик»: выбор нормы для позиции ведомости без шифра — из списка, который собрал код.
 *
 * Граница ответственности. Модель делает одно: из кандидатов (`normCandidates.ts`) называет одного или никого. Цены,
 * объёмы, единицы, коэффициенты считает код. Ответ модели ничего не значит, пока не прошёл проверку:
 * - шифр обязан быть среди кандидатов, отправленных модели (придумать расценку нельзя по построению);
 * - единица нормы обязана переводиться из единицы позиции (`deriveUnitDivisor`): иначе позиция в расчёт не войдёт;
 * - принятая норма кладётся в позицию как шифр (`normCode` + `normBaseType`) — дальше расчёт идёт по ней, как по шифру
 *   из документа, а в позиции остаётся пометка `aiNormPick` с обоснованием модели.
 *
 * Приоритет источников нормы: шифр из документа > выбор ИИ > подбор по наименованию. Позиции с шифром модели не уходят вовсе.
 *
 * Материалы. Строка ведомости может быть поставкой, а не работой («11.1 Трубы стальные … м 681,75» под «11 Укладка …»): для неё нормы нет,
 * а цена — у ресурса справочника цен (`resourceCandidates.ts`, `billMaterial.ts`). Позиция с `kind = "material"` уходит модели с кандидатами-ресурсами,
 * позиция с `kind = "ambiguous"` — с обоими списками, и модель решает, что перед нами. Ответ «РЕСУРС|шифр» проверяется так же строго, как норма:
 * шифр среди кандидатов, единица переводится. Норма для материала и ресурс для работы не принимаются никогда.
 *
 * Материал нормы «по проекту». Норма работы называет общий материал без марки с числовым расходом («Состав двухкомпонентный на основе
 * полиуретановых смол» в изоляции из напыляемого ППУ), цены на группу в книге нет, и основной материал работы выпадал из сметы. Для ведомости без
 * сметы заказчика такая пара «позиция + ресурс нормы» уходит модели видом «norm_material» (`normMaterial.ts`) с кандидатами-ресурсами справочника цен:
 * модель выбирает конкретный материал по описанию работы или никакой, код проверяет шифр среди кандидатов и единицу. Расход и цену считает расчёт.
 *
 * Модуль чистый: ни сети, ни базы на диске.
 */

/** Сколько позиций уходит модели за один вызов. */
export const NORM_PICK_BATCH_SIZE = 10;
/** Предел кандидатов на позицию в запросе: больше сборщик не отдаёт, а ручка не принимает. */
export const MAX_REQUEST_CANDIDATES = 30;

/** Уверенность модели: «low» — сомнение, позиция подсвечивается «проверьте». */
export type NormPickConfidence = "high" | "low";

/** Позиция в запросе к модели. */
/** Что известно о строке: работа (по умолчанию), материал (поставка) или неясно. */
export type NormPickKind = "work" | "material" | "ambiguous" | "norm_material";

/**
 * Ресурс нормы без марки, для которого модель выбирает материал справочника (`NormPickKind = "norm_material"`): что норма о нём знает.
 * Расход — на единицу нормы; `null` — «по проекту» (число не названо; такие пары модели не уходят, но схема их допускает).
 */
export interface NormMaterialNeed {
  /** Код ресурса нормы (группа без марки). */
  readonly code: string;
  /** Наименование ресурса в норме; может быть пустым. */
  readonly name: string;
  readonly unit: string;
  readonly quantity: number | null;
  /** Норма целиком, как её видит сметчик: «ГЭСН 26-01-021-01 «Изоляция …», единица нормы 100 м2». */
  readonly norm: string;
  /** Сколько этого ресурса на весь объём позиции (расход × объём в единицах нормы); null — расход не числом. Справка для модели. */
  readonly total?: number | null;
}

export interface NormPickItem {
  /** Короткий идентификатор внутри пачки («1»…«10»): модель отвечает им, а не идентификатором ведомости. */
  readonly id: string;
  readonly workName: string;
  readonly quantity: number;
  /** Единица ведомости, как в документе. */
  readonly unit: string;
  /** Вторая величина парного объёма («46 шт» при «м2»): уходит в промпт как справка, на подбор не влияет. */
  readonly extraVolumes?: readonly string[];
  readonly remark: string | null;
  readonly section: string | null;
  /** Нет — работа. У материала список норм пуст, у неясной строки — оба списка. */
  readonly kind?: NormPickKind;
  readonly candidates: readonly NormPickCandidate[];
  /** Ресурсы справочника цен для материала, неясной строки и материала нормы «по проекту». */
  readonly resources?: readonly ResourcePickCandidate[];
  /** Только у `kind = "norm_material"`: ресурс нормы без марки, под который ищется материал. */
  readonly normResource?: NormMaterialNeed;
}

export interface NormPickContext {
  readonly regNumber: string;
  readonly subject: string;
  /** Задание расчёта: метка для журнала расхода llm_usage_log. */
  readonly jobId?: string | null;
}

export interface NormPickBatch {
  readonly context: NormPickContext;
  readonly items: readonly NormPickItem[];
}

/** Ответ модели по одной позиции — как пришёл, до проверки. */
export interface RawNormPick {
  readonly id: string;
  /** «книга|шифр» или null — «подходящей нормы среди кандидатов нет». */
  readonly pick: string | null;
  /** Норма на устройство применена к демонтажу: коэффициенты 571/пр наложит код. */
  readonly demolition: boolean;
  /** null — модель не ответила уверенностью (старый ответ): решает покрытие слов. */
  readonly confidence: NormPickConfidence | null;
  readonly reason: string;
}

export interface NormPickResponse {
  readonly picks: readonly RawNormPick[];
  readonly tokens: number;
  /** Элементов ответа, не подошедших под схему. */
  readonly malformed: number;
}

/** Выбор нормы: подменяется в тестах; в воркере — вызов прода (`remoteNormPicker`). */
export type NormPicker = (batch: NormPickBatch) => Promise<NormPickResponse>;

/** Счётчики подбора для отчёта расчёта. */
export interface NormPickStats {
  /** Позиций, отправленных на подбор (с кандидатами). */
  readonly requested: number;
  /** Норма принята и записана в позицию. */
  readonly picked: number;
  /** Модель ответила «подходящей нормы нет» — остаётся подбор по наименованию. */
  readonly declined: number;
  /** Ответ модели не прошёл проверку (вне списка кандидатов, единица не сходится, нормы нет в базе). */
  readonly rejected: number;
  /** Позиции, для которых ответа нет: пачка упала (HTTP, не JSON, таймаут) или модель пропустила позицию. */
  readonly fallback: number;
  /** Принятых, но подсвеченных «проверьте». */
  readonly review: number;
  /** Принятых, у которых применены коэффициенты 571/пр на демонтаж. */
  readonly demolitionCoefficients: number;
  /** Позиции без кандидатов или без читаемой единицы: на подбор не уходили. */
  readonly skipped: number;
  /**
   * Материалы. Строк, опознанных как поставка (подномер под работой, название изделия без глагола работы — `billMaterial.ts`), и неясных строк.
   * Счётчики `picked`, `declined`, `rejected`, `fallback` выше включают и материалы, отправленные модели; здесь — отдельно то, что касается материалов.
   */
  readonly materialRows: number;
  readonly ambiguousRows: number;
  /** Отправлено модели с кандидатами-ресурсами (материалы и неясные строки). */
  readonly materialRequested: number;
  /** Ресурс принят по ответу модели. */
  readonly materialPicked: number;
  /** Ответ модели про ресурс не прошёл проверку (вне списка, единица не переводится, норма для материала). */
  readonly materialRejected: number;
  /** Ресурс выбран кодом по наименованию без модели (высокое покрытие слов, явный лидер). */
  readonly materialFallback: number;
  /** Материал без ресурса: «нет цены — проверьте»; норма работы ему не подбиралась. */
  readonly materialUnpriced: number;
  /**
   * Материал нормы «по проекту» (`normMaterial.ts`): пара «позиция + ресурс нормы без марки с числовым расходом» в ведомости без сметы заказчика,
   * у которой в ведомости нет отдельной строки материала. Отправлено модели с кандидатами-ресурсами; принято по ответу модели; отказано
   * («подходящего нет»); не прошло проверку (вне списка, единица не переводится); выбрано кодом по наименованию без модели (единственный
   * кандидат с высоким покрытием слов, «проверьте»). Остальные пары остаются пробелом «ресурс без марки».
   */
  readonly normMaterialRequested: number;
  readonly normMaterialPicked: number;
  readonly normMaterialDeclined: number;
  readonly normMaterialRejected: number;
  readonly normMaterialFallback: number;
  readonly batches: number;
  readonly failedBatches: number;
  readonly tokens: number;
  /** Первые причины отказов и сбоев — для журнала; полный список в отчёт не идёт. */
  readonly notes: readonly string[];
}

export const EMPTY_NORM_PICK_STATS: NormPickStats = {
  requested: 0,
  picked: 0,
  declined: 0,
  rejected: 0,
  fallback: 0,
  review: 0,
  demolitionCoefficients: 0,
  skipped: 0,
  materialRows: 0,
  ambiguousRows: 0,
  materialRequested: 0,
  materialPicked: 0,
  materialRejected: 0,
  materialFallback: 0,
  materialUnpriced: 0,
  normMaterialRequested: 0,
  normMaterialPicked: 0,
  normMaterialDeclined: 0,
  normMaterialRejected: 0,
  normMaterialFallback: 0,
  batches: 0,
  failedBatches: 0,
  tokens: 0,
  notes: [],
};

/** Подбор, который ничего не выбирает: бенчмарк по ЛСР заказчика (нормы уже названы шифрами) и тесты. */
export const NO_NORM_PICKER: NormPicker = async () => ({ picks: [], tokens: 0, malformed: 0 });

/* ------------------------------ запрос к ручке ------------------------------ */

const clipped = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().slice(0, max))
    .pipe(z.string().min(1));

const optionalClipped = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => {
      const text = (value ?? "").trim().slice(0, max);
      return text === "" ? null : text;
    });

const candidateSchema = z.object({
  key: clipped(80),
  book: clipped(16),
  code: clipped(24),
  tableCode: clipped(24),
  tableName: clipped(300),
  rowName: z.string().transform((value) => value.trim().slice(0, 240)),
  unit: clipped(48),
  collection: z.string().transform((value) => value.trim().slice(0, 160)),
  summary: z.string().transform((value) => value.trim().slice(0, 320)),
});

const resourceSchema = z.object({
  key: clipped(40),
  code: clipped(24),
  name: clipped(300),
  unit: clipped(48),
  price: z.number().finite().min(0),
});

/**
 * Схема тела запроса к `/api/estimate/norm-pick`.
 *
 * Ручка, которая пересылает модели произвольный текст, — бесплатный прокси к платному шлюзу (см. `bill-rows`). Здесь запрос
 * собирается на сервере по неизменному шаблону, а вход ограничен: не больше десяти позиций, тридцати кандидатов на позицию,
 * и у каждого поля есть предел длины. Длинное обрезается, а не отклоняется: лишнее слово в примечании не должно ронять расчёт.
 */
const normResourceSchema = z.object({
  code: clipped(40),
  name: z.string().transform((value) => value.trim().slice(0, 300)),
  unit: clipped(48),
  quantity: z.number().finite().positive().nullable(),
  norm: clipped(500),
  total: z.number().finite().positive().nullish().transform((value) => value ?? null),
});

export const normPickRequestSchema = z.object({
  regNumber: clipped(64),
  subject: clipped(1000),
  jobId: z.string().min(1).max(64).optional(),
  items: z
    .array(
      z.object({
        id: clipped(16),
        workName: clipped(500),
        quantity: z.number().finite(),
        unit: clipped(48),
        extraVolumes: z.array(clipped(64)).max(4).optional(),
        remark: optionalClipped(300),
        section: optionalClipped(300),
        kind: z.enum(["work", "material", "ambiguous", "norm_material"]).optional(),
        candidates: z.array(candidateSchema).max(MAX_REQUEST_CANDIDATES),
        resources: z.array(resourceSchema).max(MAX_REQUEST_RESOURCES).optional(),
        normResource: normResourceSchema.optional(),
      })
        .refine((item) => item.candidates.length + (item.resources?.length ?? 0) > 0, { message: "нужен хотя бы один кандидат: норма или ресурс", path: ["candidates"] })
        .refine((item) => item.kind !== "norm_material" || (item.normResource !== undefined && (item.resources?.length ?? 0) > 0), {
          message: "материалу нормы нужны ресурс нормы и кандидаты-ресурсы",
          path: ["normResource"],
        }),
    )
    .min(1)
    .max(NORM_PICK_BATCH_SIZE),
});

export type NormPickRequestBody = z.infer<typeof normPickRequestSchema>;

/* ------------------------------ промпт ------------------------------ */

const NUMBER_FORMAT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });

/**
 * Кандидаты позиции, сгруппированные по таблицам: наименование и состав таблицы не повторяются у каждой строки. Группа — это
 * таблица и её начало наименования: в таблице 63-03-007 строки 01–03 — «из металлического сайдинга», 04–06 — «из пластикового», и
 * общий заголовок над всеми шестью приписал бы пластику металл.
 */
function renderCandidates(candidates: readonly NormPickCandidate[]): string {
  const lines: string[] = [];
  let current = "";
  for (const candidate of candidates) {
    const table = `${candidate.book}|${candidate.tableCode}|${candidate.tableName}`;
    if (table !== current) {
      current = table;
      lines.push(`${candidate.book} ${candidate.tableCode} «${candidate.tableName}» — ${candidate.collection}`);
      if (candidate.summary !== "") lines.push(`  Состав: ${candidate.summary}`);
    }
    lines.push(`  ${candidate.key} | ${candidate.rowName === "" ? "(единственная строка таблицы)" : candidate.rowName} | ед. ${candidate.unit}`);
  }
  return lines.join("\n");
}

const PRICE_FORMAT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Ресурсы-кандидаты: «РЕСУРС|шифр | наименование | ед. | цена». Цена — справка для различения, считает её код. */
function renderResources(resources: readonly ResourcePickCandidate[]): string {
  return resources.map((resource) => `  ${resource.key} | ${resource.name} | ед. ${resource.unit} | цена ${PRICE_FORMAT.format(resource.price)} ₽`).join("\n");
}

const KIND_LABEL: Readonly<Record<NormPickKind, string>> = {
  norm_material:
    "материал нормы «по проекту» — норма называет общий материал без марки; выбери конкретный материал из «Кандидаты-ресурсы» по описанию работы",
  work: "работа",
  material: "материал — поставка, не работа: ресурс выбирай из списка «Кандидаты-ресурсы»",
  ambiguous: "неясно — работа или материал: реши сам; работа — норма из «Кандидаты», материал — ресурс из «Кандидаты-ресурсы»",
};

/** Ресурс нормы без марки: что норма о нём говорит. Количество — справка, считает его код. */
function renderNormResource(need: NormMaterialNeed): string[] {
  const quantity =
    need.quantity === null
      ? "расход «по проекту» (число в норме не названо)"
      : `расход по норме ${NUMBER_FORMAT.format(need.quantity)} ${need.unit} на единицу нормы${
          need.total === undefined || need.total === null ? "" : `, на весь объём позиции около ${NUMBER_FORMAT.format(need.total)} ${need.unit}`
        }`;
  return [
    `Норма: ${need.norm}`,
    `Материал нормы без марки: ${need.name === "" ? "(наименование не названо)" : `«${need.name}»`}, код ${need.code}, единица ${need.unit}; ${quantity}`,
  ];
}

function renderItem(item: NormPickItem): string {
  const volume = `${NUMBER_FORMAT.format(item.quantity)} ${item.unit}${
    item.extraVolumes === undefined || item.extraVolumes.length === 0 ? "" : ` (в той же строке: ${item.extraVolumes.join("; ")})`
  }`;
  const kind = item.kind ?? "work";
  const resources = item.resources ?? [];
  return [
    `### Позиция ${item.id}`,
    ...(item.kind === undefined || item.kind === "work" ? [] : [`Тип: ${KIND_LABEL[kind]}`]),
    `${kind === "material" ? "Наименование" : "Работа"}: ${item.workName}`,
    `Объём: ${volume}`,
    ...(kind === "norm_material" && item.normResource !== undefined ? renderNormResource(item.normResource) : []),
    ...(item.section === null ? [] : [`Раздел ведомости: ${item.section}`]),
    ...(item.remark === null ? [] : [`Примечание: ${item.remark}`]),
    ...(item.candidates.length === 0
      ? []
      : ["Кандидаты (шифр | окончание наименования строки | единица нормы):", renderCandidates(item.candidates)]),
    ...(resources.length === 0 ? [] : ["Кандидаты-ресурсы (шифр | наименование | единица | цена за единицу):", renderResources(resources)]),
  ].join("\n");
}

/**
 * Промпт подбора норм. Шаблон неизменный: ничего, кроме подбора из присланных кандидатов, эта ручка сделать не может.
 */
export function buildNormPickPrompt(batch: NormPickBatch): string {
  const { context, items } = batch;
  return `Ты — аттестованный сметчик. Составляешь локальную смету ресурсно-индексным методом по Методике определения сметной стоимости строительства (приказ Минстроя России 421/пр) и Методике применения сметных норм (приказ 571/пр). К каждой позиции ведомости объёмов работ нужно выбрать норму из ФСНБ-2022 (ГЭСН, ГЭСНр, ГЭСНм, ГЭСНп).

Закупка № ${context.regNumber}
Предмет закупки: ${context.subject}

## Как выбирать
- **Только из кандидатов.** Под каждой позицией перечислены нормы, найденные в базе. Выбирай шифр из этого списка, в том виде, как он напечатан («книга|шифр»). Шифр, которого в списке нет, отбрасывают вместе с ответом — не придумывай и не правь шифры.
- **По технологии, а не по словам.** Выбирай норму, чей состав работ и материал соответствуют тому, что реально делается на объекте. Совпадение слов — не довод: «Демонтаж профлиста» и «Замена облицовки наружных стен из металлического сайдинга» — одна работа, а «Демонтаж буровой установки» — нет.
- **Строка таблицы.** Внутри таблицы выбери строку по характеристикам позиции: толщина, число слоёв, высота, диаметр, материал, площадь. Данных для строки нет — возьми ближайшую по смыслу и поставь confidence «low».
- **Демонтаж, снятие, разборка.** Ищи норму на разборку или демонтаж (ГЭСНр, ГЭСН сборника 46, «Разборка…», «Снятие…»). Норма «Замена…», включающая демонтаж и монтаж, — тоже допустимый выбор, если иной разборки нет; demolition=false. Если нормы на разборку нет, а есть норма на устройство, установку или монтаж того же предмета, выбери её и поставь demolition=true: код применит к ней коэффициенты Методики 571/пр (п. 83, таблица 2; п. 84, таблица 3: труд и машины × 0,3–0,8, материалы не учитываются). Для остальных работ demolition=false.
- **Лучше null, чем слабая догадка.** Если ни один кандидат не описывает эту работу по технологии (другой материал, другое назначение, другой вид работ), верни pick=null. Позиция без нормы уйдёт на проверку человеку, а неверная норма даст неверные деньги.
- **Ничего не считай.** Ни объёмов, ни цен, ни коэффициентов, ни единиц: единицу измерения нормы проверит код. Нужен только выбор.
- **confidence.** «high» — норма описывает именно эту работу. «low» — похоже, но есть сомнение: другой материал или состав, не хватает данных для выбора строки.
- **reason.** Одно короткое предложение по-русски (не длиннее 160 знаков): почему эта норма, или почему ничего не подошло.

## Материалы и оборудование (поставка)
Ведомость перечисляет материалы строками под работой: «11 Укладка стальных водопроводных труб» и «11.1 Трубы стальные электросварные … м 681,75»; «13 Установка задвижек» и «13.1 Задвижка клиновая … шт». Монтаж — отдельная работа и уже стоит своей строкой, а сам материал считается как поставка по цене ресурса справочника цен (ФСБЦ).
- **Тип «материал».** Это поставляемый материал или изделие, а не работа. Выбери ресурс из «Кандидаты-ресурсы» в виде «РЕСУРС|шифр», как он напечатан: "РЕСУРС|23.3.06.04-0026". Норму работы для материала выбирать нельзя — такой ответ отбросят, даже если норма называется так же («Установка задвижек» не заменяет цену самой задвижки).
- **Тип «неясно».** Реши по смыслу и по соседним строкам: подномер вида «11.1» под работой «11» и название изделия без глагола («Трубы…», «Отвод…», «Песок…») — признаки материала; глагол работы («Монтаж», «Укладка», «Окраска») — признак работы. Работа — выбери норму (шифр «книга|шифр»), материал — ресурс («РЕСУРС|шифр»). Не подошло ничего — pick=null.
- **Позиция без типа — работа.** Ресурс для работы выбирать нельзя, ответ «РЕСУРС|…» на работу отбросят.
- **Характеристики ресурса.** Выбирай ресурс с теми же диаметром, толщиной стенки, маркой стали, классом, давлением, материалом, что в наименовании. Такого ресурса среди кандидатов нет — pick=null: строка без цены с пометкой «проверьте» лучше, чем цена чужого изделия.
- **Единицы и цена.** Единицу ресурса проверит код: «м» и «т» не переводятся друг в друга без массы метра, поэтому труба с ценой за тонну при объёме в метрах будет отброшена. Объём и цену не пересчитывай и не называй.

## Материал нормы «по проекту»
Норма работы может называть материал без марки — «по проекту»: «Состав двухкомпонентный на основе полиуретановых смол», «Трубы стальные», «Кабель». Расход и единица в норме заданы, а какой именно материал, определяет проект. Позиция такого типа несёт название и объём работы, описание ресурса нормы и «Кандидаты-ресурсы» — материалы справочника цен (ФСБЦ).
- **Тип «материал нормы».** Выбери конкретный материал, который соответствует описанию работы: вид материала, марка, толщина, плотность, диаметр, класс — всё, что названо в наименовании работы, её примечании и в самой норме. Ответ — «РЕСУРС|шифр» из списка, как он напечатан. Норму работы выбирать нельзя: такой ответ отбросят.
- **Только из кандидатов.** Шифр вне списка отбрасывают вместе с ответом. Единицу ресурса и расход проверит и пересчитает код.
- **Лучше null, чем чужой материал.** Подходящего материала среди кандидатов нет (другой вид, нет данных, чтобы отличить марки или толщины) — pick=null: строка с пробелом «материал по проекту» видна человеку, а цена чужого материала — нет.
- **Количество и цену не называй и не пересчитывай:** расход берётся из нормы.

## Формат ответа
Только JSON, без пояснений вокруг. По одному элементу на каждую позицию; id — как в заголовке позиции. Для работы pick — «книга|шифр» нормы, для материала — «РЕСУРС|шифр»:
{"items": [{"id": "1", "pick": "ГЭСН|15-01-070-01", "demolition": true, "confidence": "high", "reason": "..."}, {"id": "2", "pick": null, "demolition": false, "confidence": "high", "reason": "..."}, {"id": "3", "pick": "РЕСУРС|23.3.06.04-0026", "demolition": false, "confidence": "high", "reason": "..."}]}
Для материала нормы «по проекту» pick — «РЕСУРС|шифр» подходящего материала или null.

## Позиции
${items.map(renderItem).join("\n\n")}`;
}

/** Токенов выходного ответа на пачку: около шестидесяти на позицию с обоснованием, с запасом. */
export function normPickMaxTokens(items: number): number {
  return 400 + items * 140;
}

/* ------------------------------ разбор ответа ------------------------------ */

const answerItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  pick: z
    .string()
    .nullish()
    .transform((value) => {
      const text = (value ?? "").trim();
      return text === "" || /^(?:null|нет|none)$/iu.test(text) ? null : text;
    }),
  demolition: z.boolean().nullish().transform((value) => value === true),
  confidence: z
    .string()
    .nullish()
    .transform((value): NormPickConfidence | null => {
      const text = (value ?? "").trim().toLowerCase();
      if (text === "high" || text === "высокая" || text === "высокий") return "high";
      if (text === "low" || text === "низкая" || text === "низкий" || text === "medium" || text === "средняя") return "low";
      return null;
    }),
  reason: z
    .string()
    .nullish()
    .transform((value) => clip(value ?? "", 240)),
});

/**
 * Разбор ответа модели. Принимает объект `{"items": [...]}` и голый массив, с ограждением ``` и без него.
 * Элементы разбираются поодиночке: одна кривая строка стоит одной позиции, а не пачки (как в `parseBillResponse`).
 */
export function parseNormPickResponse(raw: string): { picks: RawNormPick[]; malformed: number } {
  const cleaned = extractLlmJson(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Модель вернула не JSON при подборе норм; длина ответа ${String(raw.length)}, начало: ${raw.slice(0, 160).replace(/\s+/gu, " ")}`);
  }

  const list: unknown =
    Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? ((parsed as { items?: unknown; picks?: unknown }).items ?? (parsed as { picks?: unknown }).picks) : undefined;
  if (!Array.isArray(list)) throw new Error("Ответ модели при подборе норм не содержит списка items");

  const picks: RawNormPick[] = [];
  let malformed = 0;
  for (const candidate of list) {
    const item = answerItemSchema.safeParse(candidate);
    if (!item.success) {
      malformed += 1;
      continue;
    }
    picks.push(item.data);
  }
  return { picks, malformed };
}

/* ------------------------------ проверка ответа ------------------------------ */

export type PickCheck =
  | { readonly status: "NONE" }
  | { readonly status: "REJECTED"; readonly reason: string }
  | { readonly status: "ACCEPTED"; readonly norm: NormRecord };

/**
 * Проверка ответа модели по одной позиции.
 *
 * `pick = null` — не отказ, а ответ «подходящей нормы нет». Остальное — три проверки по порядку: шифр среди отправленных
 * кандидатов, норма есть в базе, единица нормы переводится из единицы позиции. Единицы берутся из всех величин строки: у парного
 * объёма («м3/т») подходит любая из них, а какая именно — решит `withUnitDivisor` по единице нормы.
 */
export function checkPick(
  pick: string | null,
  candidates: readonly Pick<NormPickCandidate, "key">[],
  index: NormSearchIndex,
  units: readonly string[],
): PickCheck {
  if (pick === null) return { status: "NONE" };
  if (!candidates.some((candidate) => candidate.key === pick)) {
    return { status: "REJECTED", reason: `шифр «${clip(pick, 40)}» вне списка кандидатов` };
  }
  const separator = pick.indexOf("|");
  const norm = separator < 0 ? undefined : index.byKey.get(normKey(pick.slice(0, separator), pick.slice(separator + 1)));
  if (norm === undefined) return { status: "REJECTED", reason: `нормы «${pick}» нет в базе` };
  if (!units.some((unit) => deriveUnitDivisor(unit, norm.unit) !== null)) {
    return {
      status: "REJECTED",
      reason: `единица нормы «${norm.unit}» не переводится из единицы позиции «${units.join("», «")}» (${norm.baseType} ${norm.code})`,
    };
  }
  return { status: "ACCEPTED", norm };
}

/* ------------------------------ демонтаж по норме на устройство ------------------------------ */

type ConstructionRow = 1 | 2 | 3 | 4 | 5;

/** Сборники ГЭСН, которые сами называют материал или сеть: таблица 2, строки 1–5 Методики 571/пр. */
const ROW_BY_COLLECTION: Readonly<Record<string, ConstructionRow>> = {
  "07": 1, // Бетонные и железобетонные конструкции сборные
  "10": 2, // Деревянные конструкции
  "09": 4, // Строительные металлические конструкции
  "16": 3, // Трубопроводы внутренние
  "17": 3, // Водопровод и канализация — внутренние устройства
  "18": 3, // Отопление — внутренние устройства
  "19": 3, // Газоснабжение — внутренние устройства
  "20": 3, // Вентиляция и кондиционирование воздуха
  "22": 5, // Водопровод — наружные сети
  "23": 5, // Канализация — наружные сети
  "24": 5, // Теплоснабжение и газопроводы — наружные сети
  "33": 5, // Линии электропередачи
};

const MATERIAL_TEXT: readonly { readonly row: ConstructionRow; readonly pattern: RegExp }[] = [
  { row: 4, pattern: /металл|сталь|стальн|алюмин|оцинкован|профилирован|профлист|профнастил|композит|сайдинг|нержавеющ/u },
  { row: 2, pattern: /деревян|брус|досок|досч|бревен|древесн|фанер|вагонк/u },
  { row: 1, pattern: /железобетон|бетонн|сборн\S* плит|ж\/б/u },
];

/** Норма сама называет разборку, снятие или замену: коэффициенты 571/пр к ней не применяются (они — для норм на устройство). */
const DISMANTLING_NORM = /разборк|демонтаж|снятие|снятия|снос|замен[аы]|смен[аы]|разрушен|выломк|удален/u;

/** Строка таблицы 2 по сборнику нормы, а если он материала не называет — по тексту наименований; неоднозначно — null. */
function constructionRowOf(norm: NormRecord, workName: string): ConstructionRow | null {
  const byCollection = ROW_BY_COLLECTION[norm.collectionCode];
  if (byCollection !== undefined) return byCollection;
  const text = normalizeText(`${norm.fullName} ${workName}`);
  const rows = new Set(MATERIAL_TEXT.filter((entry) => entry.pattern.test(text)).map((entry) => entry.row));
  if (rows.size !== 1) return null;
  return [...rows][0] ?? null;
}

const k = (value: number): string => formatDecimal(value, 2);

/** Итог разбора демонтажа: коэффициенты (если строка определена) и пояснение для человека. */
export interface DemolitionOutcome {
  readonly special?: NonNullable<CustomerConditions["special"]>;
  /** Причина, по которой коэффициентов нет, а подсветка «проверьте» нужна. */
  readonly unresolved?: string;
  /** Пояснение: что применено или почему не применено. */
  readonly note: string;
}

/**
 * Коэффициенты 571/пр на демонтаж по норме на устройство.
 *
 * Выбирается строка таблицы по книге нормы и материалу, и только когда она однозначна:
 * - ГЭСН — таблица 2 п. 83 (конструкции, системы и сети): строка по сборнику или по материалу в наименованиях;
 * - ГЭСНм — таблица 3 п. 84 (оборудование): строки различаются тем, пригодно ли оборудование к повторному использованию и
 *   разбирается ли оно, а этого в ведомости нет — строку выбирать нельзя, ставится «проверьте»;
 * - остальные книги (ГЭСНр, ГЭСНп, ГЭСНмр) — таблицы Методики к ним не относятся (п. 83: «нормы на устройство, установку (ГЭСН)»).
 * Норма, которая сама называет разборку или замену, коэффициентов не получает: демонтаж в ней уже есть.
 */
export function demolitionCoefficients(norm: NormRecord, workName: string): DemolitionOutcome {
  if (DISMANTLING_NORM.test(normalizeText(norm.fullName))) {
    return { note: "норма уже включает разборку или замену — коэффициенты 571/пр на демонтаж не применялись" };
  }
  if (norm.baseType === "ГЭСНм") {
    return {
      unresolved: "демонтаж по норме монтажа оборудования ГЭСНм: строка таблицы 3 Методики 571/пр (оборудование годное, в лом) по ведомости не определяется",
      note: "демонтаж по норме монтажа оборудования: коэффициенты таблицы 3 Методики 571/пр не применены — строку выберет сметчик",
    };
  }
  if (norm.baseType !== "ГЭСН") {
    return {
      unresolved: `демонтаж по норме на устройство из книги ${norm.baseType}: коэффициенты таблицы 2 Методики 571/пр даны к нормам ГЭСН`,
      note: `демонтаж по норме на устройство (${norm.baseType}): коэффициенты 571/пр не применены — они даны к нормам ГЭСН`,
    };
  }
  const row = constructionRowOf(norm, workName);
  const entry = row === null ? undefined : EQUIPMENT_DEMOLITION.equipmentDemolition.find((candidate) => candidate.table === 2 && candidate.row === row);
  if (entry === undefined) {
    return {
      unresolved: "демонтаж по норме на устройство: материал конструкции не определён, строка таблицы 2 Методики 571/пр неоднозначна",
      note: "демонтаж по норме на устройство: коэффициенты таблицы 2 Методики 571/пр не применены — строка по материалу неоднозначна",
    };
  }
  const label =
    `${entry.order} ${entry.point} (разборка и демонтаж конструкций, систем и сетей по норме на устройство: труд, машины и машинисты × ${k(entry.labour)}, ` +
    `материалы не учитываются; «${entry.title}») — выбрано при подборе нормы ИИ, не из сметы заказчика`;
  return {
    special: { id: entry.id, labour: entry.labour, machines: entry.machines, materials: entry.materials, valueVerified: entry.valueVerified, label },
    note: `демонтаж по норме на устройство: ${entry.order} ${entry.point}, «${entry.title}» — труд и машины × ${k(entry.labour)}, материалы не учитываются`,
  };
}

/* ------------------------------ запись выбора в позицию ------------------------------ */

/**
 * Охват слов работы нормой — запасной сигнал, когда модель не назвала уверенность: совсем нет общих слов — подсветить.
 * Нормы нет среди найденных — 0.
 */
export const MIN_PICK_COVERAGE = 0.25;

/** Покрытие слов работы выбранной нормой по тому же поиску, что и подбор по наименованию; нормы нет среди 60 лучших — 0. */
export function lexicalCoverage(index: NormSearchIndex, workName: string, norm: NormRecord): number {
  const found = findNorms(index, { workName, limit: 60 }).find((match) => match.norm.baseType === norm.baseType && match.norm.code === norm.code);
  return found?.coverage ?? 0;
}

/**
 * Можно ли отправлять позицию на подбор: у неё нет шифра ни в самой строке, ни в смете заказчика (шифр — решение документа, оно
 * сильнее модели), это работа, а не поставка по справочнику цен, услуга перевозки, оборудование по цене заказчика, цена человека,
 * исключение из ЛСР или остаток ЛСР.
 */
export function needsNormPick(item: BillOfWorkItem): boolean {
  return (
    item.normCode === null &&
    item.normCodeHint == null &&
    item.resourceCode === null &&
    item.customerPriceOnly !== true &&
    item.ownUnitPrice == null &&
    item.unaccountedOf === undefined &&
    item.deduction !== true &&
    item.aiNormPick === undefined &&
    item.materialRow === undefined &&
    item.quantity > 0 &&
    !isServiceItem(item)
  );
}

/**
 * Запись принятого выбора в позицию: шифр и книга нормы, пометка с обоснованием и, для демонтажа по норме на устройство,
 * коэффициенты 571/пр.
 *
 * «Проверьте» (`aiNormPick.review`) выставляется в трёх случаях:
 * 1. модель сказала `confidence = low`;
 * 2. модель уверенность не назвала, а слов работы в норме почти нет (`coverage < MIN_PICK_COVERAGE`) — тогда это угадывание;
 * 3. демонтаж по норме на устройство, а строку таблицы 571/пр определить нельзя — коэффициент не применён, деньги завышены;
 * а также у позиции из сметы заказчика по ТСН-2001: подбор по смыслу чужой базы всегда на сверку.
 * Низкое покрытие слов при уверенности «high» — не повод: ради таких позиций («профлист» → «металлический сайдинг») подбор
 * и существует.
 */
export function applyNormPick(
  item: BillOfWorkItem,
  norm: NormRecord,
  raw: Pick<RawNormPick, "demolition" | "confidence" | "reason">,
  coverage: number | null,
): BillOfWorkItem {
  const demolition = raw.demolition ? demolitionCoefficients(norm, item.workName) : null;
  const lowCoverage = raw.confidence === null && coverage !== null && coverage < MIN_PICK_COVERAGE;
  const confidence: NormPickConfidence = raw.confidence ?? (lowCoverage ? "low" : "high");
  const review = confidence === "low" || demolition?.unresolved !== undefined || item.foreignBase === "TSN_2001_MOSCOW";

  const reason = raw.reason === "" ? "причина не названа" : raw.reason.replace(/[.\s]+$/u, "");
  const parts = [
    `норма подобрана ИИ: ${reason}`,
    ...(demolition === null ? [] : [demolition.note]),
    ...(confidence === "low" ? ["модель не уверена в выборе"] : []),
    ...(lowCoverage ? ["слов работы в норме почти нет"] : []),
  ];
  const pick: AiNormPick = {
    reason,
    confidence,
    review,
    demolition: raw.demolition,
    note: parts.join("; "),
    ...(demolition?.special === undefined ? {} : { special: demolition.special }),
  };
  return {
    ...item,
    normCode: norm.code,
    normBaseType: norm.baseType,
    aiNormPick: pick,
  };
}

/**
 * Коэффициенты 571/пр из выбора ИИ — в условия позиции, независимо от переключателя «Применять коэффициенты заказчика»:
 * коэффициенты здесь не заказчика, а выбранные при подборе нормы. Правка строки «коэффициенты» (включить/отключить) работает
 * с ними так же, как с коэффициентами из ЛСР.
 */
export function withAiDemolition(item: BillOfWorkItem): BillOfWorkItem {
  const special = item.aiNormPick?.special;
  if (special === undefined) return item;
  const existing = item.customerConditions;
  if (existing?.special !== undefined) return item;
  const conditions: CustomerConditions = {
    confirmed: existing?.confirmed ?? null,
    rejected: existing?.rejected ?? [],
    ...(existing?.rates === undefined ? {} : { rates: existing.rates }),
    special,
    label: existing?.label ? `${existing.label}; ${special.label}` : special.label,
    enabled: existing?.enabled ?? true,
    forceUnconfirmed: existing?.forceUnconfirmed ?? false,
  };
  return { ...item, customerConditions: conditions };
}

/**
 * Снимает выбор ИИ с позиции — когда норму выбрал человек: его норма не «подобрана ИИ», а коэффициенты на демонтаж
 * относились к норме модели, а не к новой.
 */
export function stripAiNormPick(item: BillOfWorkItem): BillOfWorkItem {
  const pick = item.aiNormPick;
  if (pick === undefined) return item;
  const { aiNormPick: _removed, ...rest } = item;
  const conditions = rest.customerConditions;
  if (pick.special === undefined || conditions?.special?.id !== pick.special.id) return rest;
  const { special: _special, ...others } = conditions;
  const keeps = others.confirmed !== null || others.rejected.length > 0 || others.rates !== undefined;
  if (!keeps) {
    const { customerConditions: _conditions, ...withoutConditions } = rest;
    return withoutConditions;
  }
  return { ...rest, customerConditions: { ...others, label: others.label.replace(pick.special.label, "").replace(/;\s*$/u, "").trim() } };
}
