import { isServiceItem, resolveServicePrice, type ZoneAutoServices } from "@/domain/estimate/autoServices";
import {
  EMPTY_GENERATED_DEBRIS,
  GENERATED_DEBRIS_SECTION,
  type GeneratedDebrisStats,
} from "@/domain/estimate/generatedItems";
import { normalizeText } from "@/domain/estimate/normalize";
import type { BillOfWorkItem, BillOfWorkSection, NormRecord, NormResource } from "@/domain/estimate/types";
import { deriveUnitDivisor, parseUnit } from "@/domain/estimate/units";

/**
 * Строительный мусор: погрузка, перевозка и размещение — строками, которых нет в ведомости (детерминированно, без ИИ).
 *
 * Откуда мусор. Нормы на разборку и демонтаж несут выходной ресурс «999-9900 Строительный мусор», т на единицу нормы (в выгрузке ФСНБ-2022 он у 1 019 норм).
 * Ведомость называет разборку, а вывоз результата обычно не называет — и в смете заказчика он стоит отдельными строками: «Погрузка строительного
 * мусора» (ФГИС ЦС ПРР, 49-1), «Перевозка грузов … на 47 км» (02-15-1-01-0047), «Размещение отходов». Тоннаж = Σ расход ресурса × объём в единицах нормы
 * по всем позициям, чья норма (подобранная расчётом) его содержит.
 *
 * Что считается ценой, а что — нет. Погрузка и перевозка — услуги по сметным ценам зоны (ФГИС ЦС, `autoServices.ts`): шифр строки назначается кодом, цену
 * находит обычный расчёт (`resolveServicePrice`). Расстояние берётся из документов (`debrisDistanceKm`); не найдено — строка добавляется без цены с
 * причиной «расстояние до полигона не указано», а не с придуманным километражем. Размещение (утилизация) цены в открытых данных не имеет: без тарифа в
 * документе (`debrisDisposalTariff`) строка идёт без цены с причиной «тариф полигона не известен — укажите свою цену». Строка без цены в расчёт стоимостью
 * не входит и пишет пробел с этой причиной (`BillOfWorkItem.generatedUnpricedReason`); цену укажет человек той же правкой «своя цена», что и у любой строки.
 *
 * Не дублирует ведомость: строки погрузки, вывоза, перевозки, утилизации или размещения мусора и отходов, уже названные в ведомости, не повторяются
 * (`existingDebrisRows`).
 *
 * Модуль чистый: ни сети, ни базы; норму позиции ему подаёт вызывающий код.
 */

/** Код ресурса «Строительный мусор» в нормах ФСНБ-2022. */
export const DEBRIS_RESOURCE_CODE = "999-9900";

/** Погрузка мусора: «Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3» (ФГИС ЦС ПРР); у ручной погрузки группа 47, у транспортёров 48. */
export const DEBRIS_LOAD_CODE = "49-1";
/**
 * Перевозка мусора по таблице ФГИС ЦС: «02-15-1-01-NNNN» — самосвалы до 15 т, груз I класса, дороги с усовершенствованным покрытием, NNNN км. Класс и тип
 * дорог сверены со сметой заказчика закупки 0134600012126000001 («02-15-1-01-0047», 619,94 ₽/т, перевозка мусора на 47 км).
 */
export const DEBRIS_TRANSPORT_PREFIX = "02-15-1-01";
/** Больше этого километража в таблицах зоны нет (`transportPriceByCode`): расстояние сверх него считается неизвестным. */
const MAX_DISTANCE_KM = 1500;

export const DEBRIS_LOAD_NAME = "Погрузка строительного мусора";
export const DEBRIS_DISPOSAL_NAME = "Размещение (утилизация) строительного мусора";
export const DEBRIS_TRANSPORT_NAME = "Перевозка строительного мусора";

const ID_LOAD = "gen-debris-load";
const ID_TRANSPORT = "gen-debris-transport";
const ID_DISPOSAL = "gen-debris-disposal";

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
/** Число по-русски, без разделителей разрядов: «0,565». */
const num = (value: number, digits = 3): string => String(Number(value.toFixed(digits))).replace(".", ",");

/* ------------------------------ тоннаж по нормам ------------------------------ */

/** Ресурс нормы — строительный мусор в тоннах: по коду 999-9900 или по названию. */
export function isDebrisResource(resource: NormResource): boolean {
  if (!(resource.quantity > 0)) return false;
  const unit = parseUnit(resource.unit);
  if (unit === null || unit.unit !== "т" || unit.multiplier !== 1) return false;
  if (resource.code.trim() === DEBRIS_RESOURCE_CODE) return true;
  return /мусор\p{L}*\s+строительн|строительн\p{L}*\s+мусор/u.test(normalizeText(resource.name));
}

/** Вклад одной нормы в тоннаж. */
export interface DebrisPart {
  readonly baseType: string;
  readonly code: string;
  /** Объём в единицах нормы (сумма по позициям с этой нормой). */
  readonly normQuantity: number;
  readonly tons: number;
}

export interface DebrisTonnage {
  /** Всего, т, округлено до 0,001. */
  readonly tons: number;
  readonly parts: readonly DebrisPart[];
}

/** Позиция даёт норме объём: работа по расценке, не поставка, не услуга, не цена человека и не исключение. */
function usesNorm(item: BillOfWorkItem): boolean {
  return (
    item.generated === undefined &&
    item.materialRow === undefined &&
    item.resourceCode === null &&
    item.customerPriceOnly !== true &&
    item.deduction !== true &&
    !((item.ownUnitPrice ?? 0) > 0) &&
    !isServiceItem(item) &&
    item.quantity > 0
  );
}

/**
 * Тоннаж строительного мусора по нормам позиций: Σ (расход 999-9900 на единицу нормы × объём позиции в единицах нормы).
 * Позиция, единица которой не переводится в единицу нормы, в тоннаж не входит: расчёт её тоже не посчитает.
 */
export function debrisTonnage(
  sections: readonly BillOfWorkSection[],
  normOf: (item: BillOfWorkItem) => NormRecord | null,
): DebrisTonnage {
  const byNorm = new Map<string, { baseType: string; code: string; normQuantity: number; tons: number }>();
  let raw = 0;
  for (const section of sections) {
    for (const item of section.items) {
      if (!usesNorm(item)) continue;
      const norm = normOf(item);
      if (norm === null) continue;
      const resource = norm.resources.find(isDebrisResource);
      if (resource === undefined) continue;
      const divisor = deriveUnitDivisor(item.quantityUnit, norm.unit);
      if (divisor === null || !(divisor > 0)) continue;
      const normQuantity = item.quantity / divisor;
      const tons = resource.quantity * normQuantity;
      raw += tons;
      const key = `${norm.baseType}|${norm.code}`;
      const entry = byNorm.get(key);
      if (entry === undefined) byNorm.set(key, { baseType: norm.baseType, code: norm.code, normQuantity, tons });
      else {
        entry.normQuantity += normQuantity;
        entry.tons += tons;
      }
    }
  }
  return {
    tons: round3(raw),
    parts: [...byNorm.values()].map((part) => ({ ...part, normQuantity: round3(part.normQuantity), tons: round3(part.tons) })),
  };
}

/** Сколько слагаемых показывает пояснение; остальные — «и ещё N норм». */
const MAX_PARTS_IN_NOTE = 6;

/** «мусор по нормам: 0,49 т (ГЭСНр 66-01-024-02 × 0,565) + 1,2 т (ГЭСН 46-02-009-01 × 4,5) = 1,69 т». */
export function tonnageNote(tonnage: DebrisTonnage): string {
  const shown = tonnage.parts.slice(0, MAX_PARTS_IN_NOTE).map((part) => `${num(part.tons)} т (${part.baseType} ${part.code} × ${num(part.normQuantity)})`);
  const rest = tonnage.parts.length - shown.length;
  const sum = tonnage.parts.length > 1 || rest > 0 ? ` = ${num(tonnage.tons)} т` : "";
  return `мусор по нормам: ${shown.join(" + ")}${rest > 0 ? ` + ещё ${String(rest)} норм` : ""}${sum}`;
}

/* ------------------------------ строки мусора, уже названные в ведомости ------------------------------ */

/** Какие стороны вывоза мусора ведомость уже называет. */
export interface ExistingDebrisRows {
  readonly load: boolean;
  readonly transport: boolean;
  readonly disposal: boolean;
  /** Названия найденных строк — для пояснения. */
  readonly names: readonly string[];
}

const DEBRIS_SUBJECT = /мусор|отход/u;
const LOAD_VERB = /погрузк/u;
const TRANSPORT_VERB = /перевозк|транспортировк/u;
const DISPOSAL_VERB = /утилизац|размещени|захоронен|складирован|обезвреж/u;
/** «Вывоз мусора» — вывоз целиком: погрузка, перевозка и размещение в одной строке, как её понимает сметчик. */
const REMOVAL_VERB = /вывоз|вывезти|вывозк/u;

/**
 * Строки ведомости про вывоз строительного мусора и отходов: слово «мусор» или «отход» и глагол в одном наименовании. «Вывоз мусора» закрывает все три
 * стороны; «Погрузка мусора», «Перевозка отходов», «Утилизация мусора» — каждая свою. Строки, добавленные расчётом, не считаются.
 */
export function existingDebrisRows(sections: readonly BillOfWorkSection[]): ExistingDebrisRows {
  let load = false;
  let transport = false;
  let disposal = false;
  const names: string[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      if (item.generated !== undefined) continue;
      const name = normalizeText(item.workName);
      if (!DEBRIS_SUBJECT.test(name)) continue;
      const removal = REMOVAL_VERB.test(name);
      const hasLoad = removal || LOAD_VERB.test(name);
      const hasTransport = removal || TRANSPORT_VERB.test(name);
      const hasDisposal = removal || DISPOSAL_VERB.test(name);
      if (!hasLoad && !hasTransport && !hasDisposal) continue;
      load ||= hasLoad;
      transport ||= hasTransport;
      disposal ||= hasDisposal;
      names.push(item.workName.replace(/\s+/gu, " ").trim());
    }
  }
  return { load, transport, disposal, names };
}

/* ------------------------------ расстояние и тариф из документов ------------------------------ */

/** Слова, рядом с которыми расстояние — расстояние до полигона. */
const DISTANCE_ANCHOR = /полигон|вывоз\p{L}*|вывезти|утилизац\p{L}*|свалк\p{L}*|захоронен\p{L}*|размещени\p{L}*\s+(?:отход|мусор)\p{L}*/giu;
/** «51км», «на расстояние 47 км», «12,5 км»; не «км/ч» и не «км2». */
const DISTANCE_VALUE = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:км|километр\p{L}*)(?![\p{L}\d/²])/giu;
const DISTANCE_BEFORE = 100;
const DISTANCE_AFTER = 220;

export interface DebrisDistance {
  /** Целых километров вверх: таблица перевозки — по целым км. */
  readonly km: number;
  /** Фраза документа, из которой взято расстояние. */
  readonly quote: string;
}

function snippet(text: string, from: number, to: number): string {
  return text.slice(Math.max(0, from), Math.min(text.length, to)).replace(/\s+/gu, " ").trim();
}

/**
 * Расстояние до полигона из текста документов: число с «км» рядом (до 100 знаков до и 220 после) со словами «полигон», «вывоз», «утилизация», «свалка».
 * Из нескольких берётся ближайшее к слову; не найдено — null (расстояние не придумывается). Нулевое и больше таблицы зоны (1 500 км) не принимаются.
 */
export function debrisDistanceKm(texts: readonly string[]): DebrisDistance | null {
  let best: { km: number; quote: string; gap: number } | null = null;
  for (const text of texts) {
    for (const anchor of text.matchAll(DISTANCE_ANCHOR)) {
      const at = anchor.index ?? 0;
      const start = Math.max(0, at - DISTANCE_BEFORE);
      const window = text.slice(start, at + anchor[0].length + DISTANCE_AFTER);
      for (const found of window.matchAll(DISTANCE_VALUE)) {
        const value = Number((found[1] as string).replace(",", "."));
        const km = Math.ceil(value - 1e-9);
        if (!Number.isFinite(km) || km < 1 || km > MAX_DISTANCE_KM) continue;
        const position = start + (found.index ?? 0);
        const gap = Math.abs(position - at);
        if (best === null || gap < best.gap) best = { km, gap, quote: snippet(text, Math.min(at, position) - 20, Math.max(at + anchor[0].length, position + found[0].length) + 20) };
      }
    }
  }
  return best === null ? null : { km: best.km, quote: best.quote };
}

const TARIFF_ANCHOR = /полигон|размещени\p{L}*|утилизац\p{L}*|захоронен\p{L}*|обезвреж\p{L}*/giu;
/** Слова о цене: без них число с «руб./т» рядом с полигоном — не тариф. */
const TARIFF_WORD = /тариф|стоимост|(?:^|[^\p{L}])цен[аыуе](?![\p{L}])|плат[аыуе](?![\p{L}])/iu;
/** «1 250 руб./т», «850,50 руб. за тонну», «1200 ₽/т». */
const TARIFF_VALUE = /(\d{1,3}(?:[\s ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:руб(?:\.|л\p{L}*)?|₽|р\.)\s*(?:\/|за\s+(?:1\s*)?|на\s+(?:1\s*)?)\s*(?:т(?![\p{L}])|тонн\p{L}*)/giu;

export interface DebrisTariff {
  /** ₽ за тонну, как указано в документе (с НДС или без — документ не всегда говорит). */
  readonly price: number;
  readonly quote: string;
}

/**
 * Тариф размещения (утилизации) мусора, если документ его называет: «тариф … полигона … 1 250 руб./т». Нужны слово о цене, слово про полигон или
 * размещение и сумма «за тонну» в одной фразе (до 160 знаков вокруг). Не найден — null: цены у размещения в открытых данных нет.
 */
export function debrisDisposalTariff(texts: readonly string[]): DebrisTariff | null {
  for (const text of texts) {
    for (const anchor of text.matchAll(TARIFF_ANCHOR)) {
      const at = anchor.index ?? 0;
      const start = Math.max(0, at - 160);
      const window = text.slice(start, at + anchor[0].length + 160);
      if (!TARIFF_WORD.test(window)) continue;
      for (const found of window.matchAll(TARIFF_VALUE)) {
        const whole = (found[1] as string).replace(/[\s ]/gu, "");
        const price = Number(`${whole}.${found[2] ?? "0"}`);
        if (!(price > 0) || price > 100_000) continue;
        const position = start + (found.index ?? 0);
        return { price, quote: snippet(text, Math.min(at, position) - 20, Math.max(at + anchor[0].length, position + found[0].length) + 20) };
      }
    }
  }
  return null;
}

/* ------------------------------ строки ------------------------------ */

export interface DebrisInput {
  readonly sections: readonly BillOfWorkSection[];
  /** Норма позиции в расчёте (после выбора ИИ и подбора по шифру или наименованию); null — нормы нет. */
  readonly normOf: (item: BillOfWorkItem) => NormRecord | null;
  /** Тексты документов закупки: расстояние до полигона и тариф ищутся в них. */
  readonly texts: readonly string[];
  /** Таблицы услуг зоны: по ним проверяется, что цена погрузки и перевозки есть; null — таблиц нет. */
  readonly services: ZoneAutoServices | null;
}

export interface DebrisResult {
  /** Раздел с добавленными строками; null — добавлять нечего. */
  readonly section: BillOfWorkSection | null;
  readonly stats: GeneratedDebrisStats;
}

function generatedItem(id: string, workName: string, tons: number, note: string, extra: Partial<BillOfWorkItem>): BillOfWorkItem {
  return {
    id,
    workName,
    quantity: tons,
    quantityUnit: "т",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    resourceCode: null,
    sourceQuote: note,
    sourceDocument: null,
    billSection: GENERATED_DEBRIS_SECTION,
    generated: "DEBRIS",
    generatedNote: note,
    ...extra,
  };
}

/** Цена услуги в таблицах зоны есть? Нет — причина для строки без цены; да — null. */
function missingServicePrice(services: ZoneAutoServices | null, item: BillOfWorkItem): string | null {
  if (services === null || (services.load.size === 0 && services.transport.size === 0)) {
    return "таблиц сметных цен ФГИС ЦС на перевозку и погрузку по зоне расчёта нет";
  }
  const looked = resolveServicePrice(services, {
    serviceCode: item.serviceCode ?? null,
    workName: item.workName,
    quantityUnit: item.quantityUnit,
    quantity: item.quantity,
  });
  if (looked === null) return "строка не распознана как услуга ФГИС ЦС";
  return looked.ok ? null : `цены услуги ФГИС ЦС нет: ${looked.reason}`;
}

/**
 * Строки про мусор для ведомости: погрузка, перевозка, размещение. Тоннаж — по нормам позиций; стороны, которые ведомость уже называет, не дублируются.
 * Нет мусора по нормам или всё названо в ведомости — раздел null и причина в `stats.skipped`.
 */
export function buildDebrisItems(input: DebrisInput): DebrisResult {
  const enabled = { ...EMPTY_GENERATED_DEBRIS, enabled: true };
  const tonnage = debrisTonnage(input.sections, input.normOf);
  if (!(tonnage.tons > 0)) return { section: null, stats: { ...enabled, skipped: "нормы позиций не дают строительного мусора (ресурс 999-9900)" } };

  const existing = existingDebrisRows(input.sections);
  if (existing.load && existing.transport && existing.disposal) {
    return { section: null, stats: { ...enabled, tons: tonnage.tons, skipped: `в ведомости уже есть вывоз мусора: «${existing.names.slice(0, 2).join("»; «")}»` } };
  }

  const distance = debrisDistanceKm(input.texts);
  const tariff = debrisDisposalTariff(input.texts);
  const computed = tonnageNote(tonnage);
  const items: BillOfWorkItem[] = [];

  if (!existing.load) {
    const item = generatedItem(
      ID_LOAD,
      DEBRIS_LOAD_NAME,
      tonnage.tons,
      `${computed}; цена — сметная цена погрузки ФГИС ЦС ${DEBRIS_LOAD_CODE} (мусор строительный, погрузка экскаваторами с ковшом до 0,5 м3; при ручной погрузке цена другая — группа 47)`,
      { serviceCode: DEBRIS_LOAD_CODE, serviceRow: true },
    );
    const missing = missingServicePrice(input.services, item);
    items.push(missing === null ? item : { ...item, generatedUnpricedReason: missing });
  }

  if (!existing.transport) {
    if (distance === null) {
      items.push(
        generatedItem(ID_TRANSPORT, DEBRIS_TRANSPORT_NAME, tonnage.tons, `${computed}; расстояние до полигона в документах не указано`, {
          serviceRow: true,
          generatedUnpricedReason: "расстояние до полигона не указано",
        }),
      );
    } else {
      const code = `${DEBRIS_TRANSPORT_PREFIX}-${String(distance.km).padStart(4, "0")}`;
      const item = generatedItem(
        ID_TRANSPORT,
        `${DEBRIS_TRANSPORT_NAME} на ${String(distance.km)} км`,
        tonnage.tons,
        `${computed}; расстояние ${String(distance.km)} км — по документу: «${distance.quote}»; цена — сметная цена перевозки ФГИС ЦС ${code} (самосвалы до 15 т, груз I класса, дороги с усовершенствованным покрытием)`,
        { serviceCode: code, serviceRow: true },
      );
      const missing = missingServicePrice(input.services, item);
      items.push(missing === null ? item : { ...item, generatedUnpricedReason: missing });
    }
  }

  if (!existing.disposal) {
    if (tariff === null) {
      items.push(
        generatedItem(ID_DISPOSAL, DEBRIS_DISPOSAL_NAME, tonnage.tons, `${computed}; тариф полигона в документах не указан`, {
          generatedUnpricedReason: "тариф полигона не известен — укажите свою цену",
        }),
      );
    } else {
      items.push(
        generatedItem(
          ID_DISPOSAL,
          DEBRIS_DISPOSAL_NAME,
          tonnage.tons,
          `${computed}; тариф ${num(tariff.price, 2)} ₽ за т — по документу: «${tariff.quote}» (проверьте, с НДС он или без: цена в расчёте принята без НДС)`,
          { ownUnitPrice: tariff.price },
        ),
      );
    }
  }

  const unpriced = items.filter((item) => item.generatedUnpricedReason !== undefined).length;
  return {
    section: { title: GENERATED_DEBRIS_SECTION, items },
    stats: { enabled: true, rows: items.length, tons: tonnage.tons, distanceKm: distance?.km ?? null, unpriced, skipped: null, rub: 0 },
  };
}
