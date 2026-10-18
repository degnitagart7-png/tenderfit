import type { BillOfWorkItem, BillOfWorkSection, EstimateDocument, GeneratedKind } from "@/domain/estimate/types";

/**
 * Позиции, которых нет в ведомости, но которые сметчик добавляет по технологии: общие понятия двух этапов.
 *
 * Зачем. Смета по ведомости объёмов (ВОР, ТЗ; ЛСР заказчика нет) пропускает работу, которую профессиональный сметчик добавляет сам: на закупке
 * 0134300025826000377 (ремонт утепления фасада) у заказчика «ГЭСН08-07-001-02 Установка и разборка наружных инвентарных лесов» стоила 798 700 ₽ — половину
 * сметы, — а в ведомости были только фасадные работы. Два этапа добавляют такие строки, оба отключаются пользователем (`EstimateOptions`):
 * - `DEBRIS` (`debrisItems.ts`, без ИИ): погрузка, перевозка и размещение строительного мусора; тоннаж — из норм (ресурс 999-9900) × объёмы;
 * - `AI_IMPLIED` (`impliedWorks.ts`): леса, защитные сетки, ограждения, подъём материалов — предложение ИИ из белого списка, объём — формула
 *   над объёмами ведомости, которую считает код, норма — выбор «ИИ-сметчика» из кандидатов кода.
 *
 * Добавленная строка не маскируется под строку документа: у неё есть `generated`, пояснение `generatedNote` и своя подпись в таблице
 * «Ведомость и нормы». Этот модуль чистый: названия, подписи и счётчики.
 */

/** Раздел ведомости со строками про мусор. */
export const GENERATED_DEBRIS_SECTION = "Добавлено расчётом: строительный мусор";
/** Раздел ведомости с работами, предложенными ИИ по технологии. */
export const GENERATED_IMPLIED_SECTION = "Добавлено ИИ: работы по технологии";

/** Подпись в таблице ведомости. */
export const GENERATED_LABEL: Readonly<Record<GeneratedKind, string>> = {
  AI_IMPLIED: "добавлено ИИ",
  DEBRIS: "добавлено расчётом (мусор)",
};

/** Строка добавлена расчётом или ИИ, а не документом. */
export function isGenerated(item: Pick<BillOfWorkItem, "generated">): boolean {
  return item.generated !== undefined;
}

/** Строки, добавленные расчётом, по видам: счётчик и деньги (стоимость СМР без НДС; без цены — не считается). */
export interface GeneratedDebrisStats {
  /** Этап включён (`EstimateOptions.generateDebris !== false`) и применим (источник объёмов — не смета заказчика). */
  readonly enabled: boolean;
  /** Сколько строк добавлено (погрузка, перевозка, размещение). */
  readonly rows: number;
  /** Тонн строительного мусора по нормам, до 0,001. */
  readonly tons: number;
  /** Расстояние до полигона из документов, км; null — не найдено. */
  readonly distanceKm: number | null;
  /** Добавленных строк без цены (расстояние неизвестно, тарифа полигона нет, цены нет в таблицах зоны). */
  readonly unpriced: number;
  /** Почему ничего не добавлено: «мусора по нормам нет», «в ведомости уже есть вывоз мусора»; null — добавлено или этап выключен. */
  readonly skipped: string | null;
  /** Стоимость добавленных строк в сметном документе, ₽ без НДС (прямые затраты, НР и СП). */
  readonly rub: number;
}

export interface GeneratedImpliedStats {
  readonly enabled: boolean;
  /** Сколько дополнений предложила модель (до 8). */
  readonly proposed: number;
  /** Принято: формула, единица, норма прошли проверку кода. */
  readonly accepted: number;
  /** Отклонено проверкой (формула, ссылки, единицы, дубль, нет кандидатов, норму не выбрали). */
  readonly rejected: number;
  /** Обращение к модели не удалось: сбой ручки, не JSON. 0 или 1. */
  readonly failed: number;
  /** Токены предложения и подбора норм для добавленных строк. */
  readonly tokens: number;
  /** Стоимость принятых строк в сметном документе, ₽ без НДС. */
  readonly rub: number;
  /** Почему этап не шёл: «нет подборщика норм», «источник объёмов — смета заказчика»; null — шёл или выключен. */
  readonly skipped: string | null;
  /** Первые причины отказов и сбоев — для журнала. */
  readonly notes: readonly string[];
}

export interface GeneratedStats {
  readonly debris: GeneratedDebrisStats;
  readonly implied: GeneratedImpliedStats;
}

export const EMPTY_GENERATED_DEBRIS: GeneratedDebrisStats = { enabled: false, rows: 0, tons: 0, distanceKm: null, unpriced: 0, skipped: null, rub: 0 };
export const EMPTY_GENERATED_IMPLIED: GeneratedImpliedStats = { enabled: false, proposed: 0, accepted: 0, rejected: 0, failed: 0, tokens: 0, rub: 0, skipped: null, notes: [] };
export const EMPTY_GENERATED_STATS: GeneratedStats = { debris: EMPTY_GENERATED_DEBRIS, implied: EMPTY_GENERATED_IMPLIED };

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Стоимость строк документа по видам добавленных позиций: прямые затраты, НР и СП строки. */
export function generatedCosts(
  document: Pick<EstimateDocument, "sections">,
  sections: readonly BillOfWorkSection[],
): Readonly<Record<GeneratedKind, number>> {
  const kindOf = new Map<string, GeneratedKind>();
  for (const section of sections) for (const item of section.items) if (item.generated !== undefined) kindOf.set(item.id, item.generated);
  const costs: Record<GeneratedKind, number> = { AI_IMPLIED: 0, DEBRIS: 0 };
  for (const section of document.sections) {
    for (const line of section.lines) {
      const kind = kindOf.get(line.itemId);
      if (kind !== undefined) costs[kind] += line.directCost + line.overheadCost + line.profitCost;
    }
  }
  return { AI_IMPLIED: round2(costs.AI_IMPLIED), DEBRIS: round2(costs.DEBRIS) };
}

/** Счётчики с деньгами из готового расчёта: деньги известны только после него. */
export function withGeneratedCosts(
  stats: GeneratedStats,
  document: Pick<EstimateDocument, "sections">,
  sections: readonly BillOfWorkSection[],
): GeneratedStats {
  const costs = generatedCosts(document, sections);
  return { debris: { ...stats.debris, rub: costs.DEBRIS }, implied: { ...stats.implied, rub: costs.AI_IMPLIED } };
}
