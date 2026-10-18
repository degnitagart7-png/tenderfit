import type { NormResource, ResourceKind } from "@/domain/estimate/types";

/**
 * Классификация ресурсов нормы по коду.
 *
 * Смысл кодов установлен измерением по реальной выгрузке ФСНБ-2022
 * (редакция 12.08.2026), а не взят из описания формата. Переписаны все пять
 * книг норм — 56 242 работы: ГЭСН 30 028, ГЭСНм 19 208, ГЭСНр 3 976,
 * ГЭСНп 2 605, ГЭСНмр 425. Числа ниже помечены книгой, по которой измерены.
 *
 * — Код «2» в книге ГЭСН встретился 23 334 раза и ни разу в норме без машин.
 *   Это затраты труда машинистов. Тождество сошлось количественно: для нормы
 *   01-01-001-01 бульдозер 91.01.01-035 (1,6 маш.-ч, звено 1,00) плюс
 *   экскаватор 91.01.05-128 (1,6 маш.-ч, звено 3,00) дают 6,4 чел.-ч — ровно
 *   значение «2».
 *
 * — Код «1» встречается в 6 731 работе пяти книг (ГЭСН 3 273, ГЭСНп 2 605,
 *   ГЭСНм 443, ГЭСНр 375, ГЭСНмр 35), всегда без наименования, и во всех
 *   6 731 без исключения равен сумме разрядных строк той же работы с точностью
 *   до 0,02. Это итог труда, а не самостоятельный ресурс.
 *
 * — Труд рабочих записан двумя способами, которые никогда не смешиваются:
 *   46 058 работ содержат «1-100-XX» (средний разряд XX/10), 5 267 работ —
 *   «2-100-XX» (рабочий N разряда), и ни одна работа не содержит оба варианта.
 *   Значит начислять деньги нужно по разрядным строкам, а строку «1» оставлять
 *   справочной.
 *
 * — Труд специалистов записан третьим семейством, «3-*»: 7 кодов и 6 183 строки
 *   в 2 653 работах (ГЭСНп 2 565, ГЭСНм 53, ГЭСНмр 35). В 19 работах ГЭСНмр
 *   «3-*» встречается вместе с «1-100-*», поэтому в сверку итога кода «1»
 *   входят оба семейства. Ставки для специалистов в выгрузке нет — см.
 *   `SPECIALIST_CODE_PATTERN`.
 *
 * — Код «4-100-XXX» в нормах не встречается ни разу: это DriverCode машины из
 *   справочника цен. Оплата машиниста уже внутри стоимости маш.-ч, поэтому
 *   такой код отнесён к затратам труда машинистов — он даёт часы, но не деньги.
 *
 * — Коды «91.*» — машины, коды вида «NN.*» (например «01.7.12.05-0131») —
 *   материалы: книги классификатора всегда двузначные.
 */

/** Итоговые затраты труда рабочих — сумма строк «2-100-*» нормы. */
export const WORKER_HOURS_TOTAL_CODE = "1";

/** Затраты труда машинистов — сумма (маш.-ч × численность звена) по машинам. */
export const MACHINIST_HOURS_CODE = "2";

/**
 * Код тарифной ставки. Цифры после «-100-» читаются по-разному в зависимости от
 * префикса, и это установлено переписью всех пяти книг норм:
 *
 * — «1-100-XX», 54 кода и 46 058 строк: XX — разряд, умноженный на десять.
 *   «1-100-38» сопровождается наименованием «Средний разряд работы 3,8»,
 *   «1-100-80» — «Средний разряд работы 8,0».
 * — «2-100-XX», 7 кодов и 14 334 строки: XX — сам разряд, от 01 до 07.
 *   «2-100-04» сопровождается наименованием «Рабочий 4 разряда».
 * — «4-100-XXX», в ресурсах норм не встречается ни разу: это DriverCode машины
 *   из справочника цен, где «4-100-060» соответствует разряду 6,0, а
 *   «4-100-093» — 9,3, то есть снова деление на десять.
 *
 * Перепутать префиксы 1 и 2 дорого: разряд 4, прочитанный как 0,4, уводит
 * ставку ниже первого разряда шкалы и занижает оплату труда примерно на 29 %,
 * а вместе с ней — накладные расходы и сметную прибыль.
 */
const WAGE_CODE_PATTERN = /^([124])-100-(\d{2,3})$/;

/**
 * Код труда специалистов (ИТР). Семь кодов, все с реальными наименованиями из
 * выгрузки: «3-100-01» Техник I категории (460 строк), «3-100-02» Техник II
 * категории (334), «3-200-01» Инженер I категории (1 545), «3-200-02» Инженер
 * II категории (1 513), «3-200-03» Инженер III категории (1 204),
 * «3-300-01» Ведущий инженер (918), «3-400-01» Главный технолог (209).
 *
 * Это труд, а не неизвестный ресурс: часы специалистов входят в итог кода «1»
 * и в трудозатраты позиции. Ставки для них опубликованы в реестре ставок оплаты
 * труда зоны под теми же кодами и наименованиями («3-200-03» — «Инженер III
 * категории»), но не на первой странице реестра, а дальше. У должности нет
 * разряда, поэтому `rankFromWageCode` на таких кодах возвращает null, а ставка
 * ищется по точному коду в шкале зоны (`resolveSpecialistWage`). Нет записи —
 * расчёт начисляет ноль и ставит пометку NO_WAGE.
 *
 * Соблазн приравнять инженера к разряду надо отвергать осознанно: в книге ГЭСНп
 * 2 565 работ из 2 605 несут специалистов и при этом не содержат ни машин, ни
 * материалов, так что выдуманная ставка ИТР определила бы почти всю стоимость
 * пусконаладки. Берётся только то, что реестр назвал.
 */
const SPECIALIST_CODE_PATTERN = /^3-\d{3}-\d{2}$/;

/** Машины и механизмы в классификаторе живут в книге 91. */
const MACHINE_CODE_PREFIX = "91.";

/** Ставит виду ресурса по его коду. */
export function classifyResourceCode(code: string): ResourceKind {
  const trimmed = code.trim();
  if (trimmed === WORKER_HOURS_TOTAL_CODE) return "WORKER_HOURS_TOTAL";
  if (trimmed === MACHINIST_HOURS_CODE) return "MACHINIST_HOURS";

  const wage = WAGE_CODE_PATTERN.exec(trimmed);
  if (wage !== null) {
    // Префикс 4 — звено машины: часы машинистов, деньги уже в цене маш.-ч.
    return wage[1] === "4" ? "MACHINIST_HOURS" : "LABOUR";
  }

  if (SPECIALIST_CODE_PATTERN.test(trimmed)) return "LABOUR";

  if (trimmed.startsWith(MACHINE_CODE_PREFIX)) return "MACHINE";
  // Книги материалов: «01.1.01.01-0002», «20.1.02.13-0001» и т. п.
  if (/^\d{2}\./.test(trimmed)) return "MATERIAL";
  return "UNKNOWN";
}

/** Префикс кодов с явным разрядом: «2-100-04» — рабочий 4 разряда. */
const EXPLICIT_RANK_PREFIX = "2";

/**
 * Разряд из кода тарифной ставки: «1-100-38» → 3.8, «2-100-04» → 4,
 * «4-100-060» → 6.0.
 *
 * null — когда разряда нет: коды «3-*» описывают должность специалиста, а не
 * разряд, машины и материалы к тарифной сетке не относятся. Именно этот null
 * превращается в пометку NO_WAGE, а не в ставку по догадке.
 */
export function rankFromWageCode(code: string): number | null {
  const match = WAGE_CODE_PATTERN.exec(code.trim());
  const digits = match?.[2];
  if (digits === undefined) return null;
  const value = Number.parseInt(digits, 10);
  return match?.[1] === EXPLICIT_RANK_PREFIX ? value : value / 10;
}

/** Единица измерения ресурса по его виду. */
export function unitForResourceKind(kind: ResourceKind): string {
  switch (kind) {
    case "LABOUR":
    case "WORKER_HOURS_TOTAL":
    case "MACHINIST_HOURS":
      return "чел.-ч";
    case "MACHINE":
      return "маш.-ч";
    case "MATERIAL":
    case "UNKNOWN":
      return "";
  }
}

/** Вход `toNormResource`: то, что известно о ресурсе из выгрузки. */
export interface NormResourceInput {
  readonly code: string;
  readonly name: string;
  readonly quantity: number;
  /** Единица из классификатора, если она есть в выгрузке. */
  readonly unit?: string | null;
  /** Пометка количества, когда оно не число: «П» — по проекту. */
  readonly quantityNote?: string | null;
  /** Ресурс без конкретной марки: AbstractResource или ServiceResource. */
  readonly projectSpecific?: boolean;
  /** Код технологической группы, если он задан. */
  readonly technologyGroup?: string | null;
}

/**
 * Ресурс нормы с уже определённым видом.
 *
 * Единица труда и машин («чел.-ч», «маш.-ч») определяется видом ресурса, а не
 * берётся из каталога: справочник цен хранит единицу материала («м2», «т»,
 * «100 компл»), а для часов она всегда одна и та же.
 */
export function toNormResource(input: NormResourceInput): NormResource {
  const kind = classifyResourceCode(input.code);
  const unit = unitForResourceKind(kind);
  const fromCatalog = (input.unit ?? "").trim();
  return {
    code: input.code.trim(),
    kind,
    name: input.name.trim(),
    quantity: input.quantity,
    unit: unit.length > 0 ? unit : fromCatalog,
    quantityNote: input.quantityNote?.trim() || null,
    projectSpecific: input.projectSpecific ?? false,
    technologyGroup: input.technologyGroup?.trim() || null,
  };
}

/**
 * Сумма затрат труда машинистов, посчитанная от состава звена машин.
 * Используется для сверки со служебным кодом «2»: если они расходятся, значит
 * либо выгрузка неполная, либо наша модель неверна.
 */
export function machinistHoursFromMachines(
  resources: readonly NormResource[],
  machinistHoursByCode: ReadonlyMap<string, number>,
): number | null {
  let total = 0;
  let seen = false;
  for (const resource of resources) {
    if (resource.kind !== "MACHINE") continue;
    const crew = machinistHoursByCode.get(resource.code);
    if (crew === undefined) continue;
    seen = true;
    total += resource.quantity * crew;
  }
  return seen ? roundTo(total, 4) : null;
}

/** Округление до указанного числа знаков без накопления двоичной ошибки. */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
