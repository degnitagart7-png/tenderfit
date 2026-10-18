import { isSameRegion, regionCodeOf } from "@/domain/regionCodes";
import { matchStems, stemsOf } from "@/domain/estimate/municipalityMatch";
import { resolveNorthByText, northSubjectOf } from "@/domain/estimate/north";
import { formatDecimal, WINTER, winterRow } from "@/domain/estimate/normatives";
import type { AppliedNormative } from "@/domain/estimate/types";
import type { WinterNormRow, WinterZonePart } from "@/domain/estimate/normativeTypes";
import type { WorkKind } from "@/domain/estimate/workKinds";

/**
 * Зимнее удорожание по Методике 325/пр (приказ Минстроя России от 25.05.2021 N 325/пр).
 *
 * Что установлено первоисточником (`data/fsnb/normatives/winter.json`, `sources/325-pr-...txt`):
 * - это Методика определения дополнительных затрат при производстве работ в зимнее время, а не ГСН
 *   81-05-02: ГСН 81-05-02-2007 заменена ею; норматив (НДЗ) — % от стоимости работ, по температурным
 *   зонам I-VIII;
 * - НДЗ приложений 1 и 2 — среднегодовые и применяются на ВЕСЬ период строительства (п. 11): доля
 *   зимних месяцев не вычисляется. Исключение (п. 9) — строительство «исключительно в летний период»:
 *   тогда НДЗ не применяются. Поэтому периоду работ нужен один ответ — задевают ли они зимний период
 *   части субъекта (даты начала и конца — приложение 4), и пропорции из этого не следует;
 * - к НДЗ применяется коэффициент части субъекта (графа 6 приложения 4, п. 13);
 * - база — стоимость работ вместе с временными зданиями и сооружениями (п. 18, 21, 23, 23(1)): порядок
 *   `(СМР + временные) × зимнее %` в `computeTotals` верен.
 */

export type WinterWork = "YES" | "NO" | "PART";

export interface WorkPeriod {
  /** ISO-дата начала работ («2026-09-01») или null. */
  readonly start: string | null;
  readonly end: string | null;
}

/* --------------------------- Часть субъекта (приложение 4) --------------------------- */

/** Имя субъекта в приложении 4 без оговорки в скобках: «Архангельская область (за исключением …)». */
function subjectKey(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/u, "").trim();
}

/** Субъекты, которые приложение 4 перечисляет внутри другого: Тюменская область «включая» ХМАО и ЯНАО. */
const INCLUDED_IN: ReadonlyMap<string, string> = new Map([
  ["86", "Тюменская область"],
  ["89", "Тюменская область"],
]);

/** Части субъекта (одна — субъект без деления). Пусто — субъекта нет в приложении 4. */
export function winterPartsOf(subject: string | null): WinterZonePart[] {
  if (subject === null || subject.trim() === "") return [];
  const code = regionCodeOf(subject.trim().toLowerCase())?.code ?? null;
  const target = code !== null && INCLUDED_IN.has(code) ? (INCLUDED_IN.get(code) as string) : subject;
  return WINTER.zoneParts.filter((part) => isSameRegion(target, subjectKey(part.subject)));
}

export type WinterZoneBasis =
  /** У субъекта одна часть. */
  | "SINGLE"
  /** Территория названа в приказе списком (улусы, города), и закупка называет её. */
  | "UNITS"
  /** «Остальная территория»: муниципалитет не отнесён ни к одной части, заданной линией. */
  | "REST"
  /** Часть выбрал человек. */
  | "USER";

export type WinterZoneResult =
  | { readonly ok: true; readonly part: WinterZonePart; readonly basis: WinterZoneBasis; readonly matched: string | null; readonly assumption: string | null }
  | { readonly ok: false; readonly reason: string; readonly candidates: readonly WinterZonePart[] };

const CITY_PREFIX = /^(?:г|город[а-я]*)$/u;

function unitMatched(units: readonly string[], words: readonly string[]): string | null {
  let best: { unit: string; length: number } | null = null;
  for (const unit of units) {
    const found = matchStems(stemsOf(unit), words);
    if (found === null) continue;
    const prev = words[found.start - 1] ?? "";
    const next = words[found.end + 1] ?? "";
    // «Горный» без «улус»/«район» рядом — просто слово; город — только с «г.».
    const context =
      CITY_PREFIX.test(prev) || next.startsWith("улус") || next.startsWith("район") || (next === "р" && words[found.end + 2] === "н") || next.startsWith("городск") || prev.startsWith("улус") || prev.startsWith("район");
    if (!context) continue;
    if (best === null || found.length > best.length) best = { unit, length: found.length };
  }
  return best === null ? null : best.unit;
}

/**
 * Температурная зона для объекта: часть субъекта по приложению 4.
 *
 * Делящиеся субъекты. Приложение задаёт части либо списком территорий (улусы Якутии, города
 * Краснодарского края), либо линиями («севернее линии Шипишка - Тунгокочен …»); линии к
 * муниципалитетам по тексту приказа не привязываются. Поэтому: список — по названию в закупке;
 * линия — «остальная территория», если муниципалитет не назван или не относится к северным по
 * перечню районов Крайнего Севера (постановление 1946); спорные случаи (северный район в
 * субъекте с отдельными северными частями) не угадываются — нужен выбор человека.
 */
export function resolveWinterZone(
  subject: string | null,
  words: readonly string[],
  userPartId: string | null = null,
): WinterZoneResult {
  const parts = winterPartsOf(subject);
  if (parts.length === 0) {
    return {
      ok: false,
      reason:
        subject === null || subject.trim() === ""
          ? "регион закупки не определён, температурную зону выбрать нельзя"
          : `субъекта «${subject}» нет в приложении 4 Методики 325/пр`,
      candidates: [],
    };
  }
  const only = parts[0];
  if (parts.length === 1 && only !== undefined) return { ok: true, part: only, basis: "SINGLE", matched: null, assumption: null };

  if (userPartId !== null) {
    const chosen = parts.find((part) => part.id === userPartId);
    if (chosen !== undefined) return { ok: true, part: chosen, basis: "USER", matched: null, assumption: null };
  }

  // Территория, названная в приказе списком.
  for (const part of parts) {
    if (part.units.length === 0) continue;
    const unit = unitMatched(part.units, words);
    if (unit !== null) return { ok: true, part, basis: "UNITS", matched: unit, assumption: null };
  }

  const rest = parts.find((part) => part.rest);
  const north = subject === null ? null : northSubjectOf(subject);
  const northNamed = subject !== null && north !== null && north.whole === null && resolveNorthByText(subject, words) !== null;
  if (rest !== undefined && !northNamed) {
    const named = words.length > 0 ? "муниципалитет по закупке не отнесён ни к одной из частей, заданных линиями" : "муниципалитет закупки не определён";
    return {
      ok: true,
      part: rest,
      basis: "REST",
      matched: null,
      assumption: `${named}; принята «${rest.description}» (приложение 4, п. ${rest.item}), температурная зона ${rest.zone}`,
    };
  }
  return {
    ok: false,
    reason:
      rest === undefined
        ? `субъект делится на части линиями (${parts.map((part) => `п. ${part.item}`).join(", ")}), по муниципалитету закупки часть выбрать нельзя — укажите температурную зону вручную`
        : "закупка называет северный район субъекта, который делится линиями на части, — часть территории надо указать вручную",
    candidates: parts,
  };
}

/* --------------------------------- Период работ --------------------------------- */

function parseDayMonth(value: string): { day: number; month: number } {
  const [day, month] = value.split(".");
  return { day: Number.parseInt(day ?? "1", 10), month: Number.parseInt(month ?? "1", 10) };
}

function utc(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

/**
 * Пересекаются ли работы [start, end] с расчётным зимним периодом части субъекта (приложение 4,
 * графы 4-5; период может переходить через Новый год). Включительно по обоим концам.
 */
export function overlapsWinter(part: WinterZonePart, start: string, end: string): boolean {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return false;
  const s = parseDayMonth(part.winterStart);
  const e = parseDayMonth(part.winterEnd);
  const wraps = s.month > e.month || (s.month === e.month && s.day > e.day);
  const firstYear = new Date(from).getUTCFullYear() - 1;
  const lastYear = new Date(to).getUTCFullYear() + 1;
  for (let year = firstYear; year <= lastYear; year += 1) {
    const winterFrom = utc(year, s.month, s.day);
    const winterTo = wraps ? utc(year + 1, e.month, e.day) : utc(year, e.month, e.day);
    if (from <= winterTo && to >= winterFrom) return true;
  }
  return false;
}

/* --------------------------------- Расчёт --------------------------------- */

const SOURCE_TITLE = "Приказ Минстроя России от 25.05.2021 N 325/пр (ред. приказа от 21.03.2025 N 170/пр)";

export interface WinterInput {
  readonly kind: WorkKind | null;
  readonly subject: string | null;
  /** Слова адреса, заказчика и названия закупки (нормализованные). */
  readonly words: readonly string[];
  readonly partId?: string | null;
  readonly winterWork?: WinterWork | null;
  readonly period?: WorkPeriod | null;
}

export interface WinterResult {
  readonly percent: number;
  readonly applied: AppliedNormative;
}

function notApplied(reason: string, missingData: boolean, text: string): WinterResult {
  return {
    percent: 0,
    applied: {
      code: "WINTER",
      title: "Зимнее удорожание",
      text,
      value: "0 %",
      source: `${SOURCE_TITLE}, п. 9, 11`,
      applied: false,
      reason,
      missingData,
    },
  };
}

function periodText(period: WorkPeriod | null | undefined): string {
  if (period?.start && period.end) return `${period.start} — ${period.end}`;
  return "";
}

export function computeWinterSurcharge(input: WinterInput): WinterResult {
  const { kind } = input;
  if (kind === null) {
    return notApplied(
      "зимнее удорожание не начислено: не указан вид работ (снос, капитальный ремонт, строительство)",
      true,
      "Норматив зависит от вида работ и объекта",
    );
  }
  const row: WinterNormRow | null = winterRow(kind.winterRow);
  if (row === null) return notApplied(`в справочнике нет строки ${kind.winterRow}`, false, kind.label);

  const zone = resolveWinterZone(input.subject, input.words, input.partId ?? null);
  if (!zone.ok) {
    return notApplied(`зимнее удорожание не начислено: ${zone.reason}`, true, `Вид работ: ${kind.label}`);
  }

  const { part } = zone;
  // Период работ: даты из документации или ввода — главнее ответа «зимой / нет»: даты проверяемы.
  let winterApplies: boolean | null = null;
  let periodNote = "";
  const period = input.period ?? null;
  if (period?.start && period.end) {
    winterApplies = overlapsWinter(part, period.start, period.end);
    periodNote = `работы ${periodText(period)}; расчётный зимний период ${part.winterStart}-${part.winterEnd} (приложение 4, п. ${part.item}) ${winterApplies ? "пересекается с ними" : "с ними не пересекается"}`;
  } else if (input.winterWork === "YES" || input.winterWork === "PART") {
    winterApplies = true;
    periodNote = input.winterWork === "PART" ? "работы частично в зимний период (по указанию пользователя)" : "работы в зимний период (по указанию пользователя)";
  } else if (input.winterWork === "NO") {
    winterApplies = false;
    periodNote = "работы только в летний период (по указанию пользователя)";
  }
  if (winterApplies === null) {
    return notApplied(
      "зимнее удорожание не начислено: не известен период работ",
      true,
      `Вид работ: ${kind.label}; температурная зона ${part.zone} (приложение 4, п. ${part.item})`,
    );
  }
  if (!winterApplies) {
    return notApplied(
      `зимнее удорожание не начислено: ${periodNote}; НДЗ не применяются при работах исключительно в летний период (п. 9)`,
      false,
      `Вид работ: ${kind.label}; температурная зона ${part.zone}`,
    );
  }

  const base = row.percent[part.zone];
  if (base === undefined) {
    return notApplied(
      `в таблице приложения ${row.table === "A1" ? "1" : "2"} для температурной зоны ${part.zone} по виду «${row.name}» стоит прочерк — норматив не установлен`,
      false,
      `Вид работ: ${kind.label}`,
    );
  }
  const percent = Number((base * kind.winterMultiplier * part.coefficient).toFixed(4));
  const appendix = row.table === "A1" ? "1" : "2";
  const textParts = [
    `НДЗ «${row.name}» для ${part.zone} температурной зоны: ${formatDecimal(base)} %`,
    `коэффициент к НДЗ части субъекта (приложение 4, графа 6): ${formatDecimal(part.coefficient)}`,
    "среднегодовой НДЗ применяется на весь период работ (п. 11), база — стоимость работ с временными зданиями (п. 18, 21, 23, 23(1))",
    periodNote,
  ].filter((item) => item !== "");
  return {
    percent,
    applied: {
      code: "WINTER",
      title: "Зимнее удорожание",
      text: textParts.join("; "),
      value: `${formatDecimal(percent)} %`,
      source: `${SOURCE_TITLE}, приложение ${appendix}, п. ${row.item}; приложение 4, п. ${part.item}${part.description === "" ? "" : ` («${part.description}»)`}`,
      applied: true,
      ...(zone.assumption === null ? {} : { assumption: zone.assumption }),
    },
  };
}
