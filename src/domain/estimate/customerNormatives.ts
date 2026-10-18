import { formatDecimal, WORK_CONDITIONS, WINTER, temporaryRow, winterRow } from "@/domain/estimate/normatives";
import type { WorkCondition } from "@/domain/estimate/normativeTypes";
import type { NormColumn } from "@/domain/estimate/workConditions";
import { resolveWinterZone } from "@/domain/estimate/winterSurcharge";
import { detectPhaseHint, type EstimatePhase } from "@/domain/estimate/workKinds";
import { normalizeRegionText } from "@/domain/regions";

/**
 * Сверка начислений заказчика сверх норм с таблицами приказов Минстроя: коэффициенты условий работ
 * (421/пр, приложение 10), зимнее удорожание (325/пр), временные здания (332/пр).
 *
 * Аудит ничего не пересчитывает: у заказчика могли быть основания, которых в тексте сметы нет (проект
 * организации строительства, проект производства работ). Поэтому всё — справка со ссылкой на пункт:
 * «значение есть в приложении 10: таблица 5, п. 3, допустимо при условии, что условие названо в проекте»
 * либо «значения в таблицах нет». Сумма разницы называется в тексте, но в итог аудита не входит.
 */

const COLUMN_OF_BOOK: Readonly<Record<string, NormColumn>> = {
  GESN: "gesn",
  GESNM: "gesnm",
  GESNR: "gesnr",
  GESNP: "gesnp",
};

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

function num(value: number): string {
  return formatDecimal(value, 2);
}

/** Числа-коэффициенты в тексте: «ОЗП=1,15; ЭМ=1,25». Только от 1 до 3. */
export function coefficientValues(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(/(\d+(?:[.,]\d+))/gu)) {
    const value = Number((match[1] as string).replace(",", "."));
    if (value > 1 && value <= 3 && !values.some((item) => Math.abs(item - value) < 1e-9)) values.push(value);
  }
  return values;
}

const TABLE_ORDER: readonly number[] = [5, 6, 3, 4, 1, 2, 7, 8];

function tablesOf(conditions: readonly WorkCondition[]): string {
  const byTable = new Map<number, string[]>();
  for (const condition of conditions) byTable.set(condition.table, [...(byTable.get(condition.table) ?? []), condition.item]);
  return [...byTable.entries()]
    // Сначала таблицы капремонта (5, 6), реконструкции (3, 4), строительства (1, 2): ремонт у заказчиков чаще всего.
    .sort((a, b) => TABLE_ORDER.indexOf(a[0]) - TABLE_ORDER.indexOf(b[0]))
    .map(([table, items]) => `таблица ${String(table)}, п. ${items.join("; ")}`)
    .join("; ");
}

const PHASE_NAME: Readonly<Record<number, string>> = {
  1: "строительство",
  2: "строительство",
  3: "реконструкция",
  4: "реконструкция",
  5: "капремонт",
  6: "капремонт",
  7: "пусконаладка",
  8: "пусконаладка",
};

/**
 * Что говорит приложение 10 о коэффициентах, которые заказчик указал у позиции. Одна фраза со
 * ссылкой на таблицы и пункты; `book` — книга обоснования позиции («GESN», «GESNM», …).
 */
export function checkCustomerCoefficients(coefficients: string, book: string): string {
  const column = COLUMN_OF_BOOK[book];
  if (column === undefined) return "";
  const values = coefficientValues(coefficients);
  if (values.length === 0) return "";

  const productivity = WORK_CONDITIONS.conditions.filter(
    (condition) => condition.coefficients[column] !== null && condition.coefficients[column] !== undefined && condition.kind === "PRODUCTIVITY",
  );
  const wage = WORK_CONDITIONS.conditions.filter(
    (condition) => condition.coefficients[column] !== null && condition.coefficients[column] !== undefined && condition.kind === "WAGE",
  );
  const adjustment = WORK_CONDITIONS.adjustments.find((item) => item.id === "P58");

  const parts: string[] = [];
  for (const value of values) {
    const single = productivity.filter((condition) => Math.abs((condition.coefficients[column] as number) - value) < 1e-9);
    const paid = wage.filter((condition) => Math.abs((condition.coefficients[column] as number) - value) < 1e-9);
    const notes: string[] = [];
    if (single.length > 0) {
      notes.push(`приложение 10 к 421/пр, ${tablesOf(single)} (${[...new Set(single.map((c) => PHASE_NAME[c.table]))].join(", ")}) — допустимо, если условие названо в проекте`);
    }
    if (paid.length > 0) notes.push(`повышенная оплата труда: ${tablesOf(paid)}`);
    if (adjustment !== undefined && (Math.abs(adjustment.labour - value) < 1e-9 || Math.abs(adjustment.machines - value) < 1e-9)) {
      notes.push(
        `п. 58 Методики: ${num(adjustment.labour)} к труду и ${num(adjustment.machines)} к машинам при ремонте и реконструкции по нормам нового строительства (не к разборке и не к ГЭСН 81-02-46)`,
      );
    }
    if (notes.length === 0) {
      // Два условия одной таблицы складываются по дробным частям (п. 52).
      const sums: string[] = [];
      for (const a of productivity) {
        for (const b of productivity) {
          if (a.table !== b.table || a.id >= b.id) continue;
          const sum = 1 + (a.coefficients[column] as number) - 1 + ((b.coefficients[column] as number) - 1);
          if (Math.abs(sum - value) < 1e-6) sums.push(`таблица ${String(a.table)}: п. ${a.item} + п. ${b.item}`);
        }
      }
      if (sums.length > 0) notes.push(`сумма двух условий по п. 52 (${[...new Set(sums)].slice(0, 3).join("; ")})`);
    }
    parts.push(
      notes.length > 0
        ? `${num(value)} — ${notes.join("; ")}`
        : `${num(value)} — такого значения в приложении 10 нет и оно не получается суммой двух условий (п. 52) или коэффициентами п. 58: основание проверьте по проекту`,
    );
  }
  return `По приложению 10 к 421/пр: ${parts.join(". ")}.`;
}

/* ------------------------------ Зимнее и временные ------------------------------ */

export interface CustomerLimitedLine {
  readonly percent: number;
  readonly quote: string;
}

export interface LimitedCostsFinding {
  readonly severity: "WARNING" | "INFO";
  readonly message: string;
  /** Сумма расхождения, ₽ (плюс — у заказчика больше); null — не считалась. */
  readonly amount: number | null;
}

/** Вид объекта по названию сметы: для сверки временных зданий при капремонте. */
function repairTemporaryRow(text: string): { row: string; label: string } | null {
  const t = text.toLowerCase();
  if (/кровл|крыш/u.test(t)) return { row: "A2-2.2", label: "кровли" };
  if (/фасад/u.test(t)) return { row: "A2-2.1", label: "фасады" };
  if (/внутренн[а-я]+\s+отделк|отделочн/u.test(t)) return { row: "A2-2.3", label: "внутренняя отделка" };
  if (/школ|детск[а-я]+\s+сад|больниц|поликлиник|администрац|дом[а]?\s+культуры|библиотек|музе/u.test(t)) {
    return { row: "A2-1.2", label: "объект социально-культурного назначения в целом" };
  }
  if (/многоквартирн|жил[а-я]+\s+дом|жилого\s+дома|жилого\s+здания|общежити/u.test(t)) {
    return { row: "A2-1.1", label: "объект жилищного назначения в целом" };
  }
  return null;
}

/**
 * Сверка процентов заказчика. `text` — название сметы и документа: по нему угадывается вид работ
 * (без вида — только справка, без вывода «завышено»).
 */
export function checkCustomerLimitedCosts(input: {
  readonly winter: CustomerLimitedLine | null;
  readonly temporary: CustomerLimitedLine | null;
  readonly text: string;
  /** Сумма СМР заказчика без НДС для оценки расхождения, ₽. */
  readonly base: number;
  /** Субъект сметы (по ценовой зоне аудита): для температурной зоны. */
  readonly subject: string | null;
}): LimitedCostsFinding[] {
  const findings: LimitedCostsFinding[] = [];
  const hint = detectPhaseHint(input.text);
  const phase: EstimatePhase | null = hint?.phase ?? null;

  if (input.temporary !== null) {
    const percent = input.temporary.percent;
    if (phase === "DEMOLITION") {
      findings.push({
        severity: "INFO",
        amount: null,
        message: `Временные здания и сооружения у заказчика ${num(percent)} %: при сносе норматива в процентах нет, затраты определяются расчётом по проекту организации работ по сносу (332/пр, п. 29) — проверьте расчёт заказчика («${input.temporary.quote}»)`,
      });
    } else if (phase === "CAPITAL_REPAIR") {
      const found = repairTemporaryRow(input.text);
      const row = found === null ? null : temporaryRow(found.row);
      if (found !== null && row !== null) {
        const diff = percent - row.percent;
        const money = Math.round((diff / 100) * input.base);
        if (Math.abs(diff) < 0.05) {
          findings.push({ severity: "INFO", amount: 0, message: `Временные здания и сооружения ${num(percent)} % — совпадает с нормативом для капремонта (${found.label}): приказ 332/пр, приложение 2, п. ${row.item}` });
        } else if (diff > 0) {
          findings.push({
            severity: "INFO",
            amount: money,
            message: `Временные здания и сооружения ${num(percent)} % при нормативе ${num(row.percent)} % для капремонта (${found.label}) — завышено на ${num(diff)} п.п., около ${RUB.format(money)} ₽ без НДС (332/пр, приложение 2, п. ${row.item}); если заказчик исходит из проекта организации строительства, основание надо запросить`,
          });
        } else {
          findings.push({
            severity: "INFO",
            amount: money,
            message: `Временные здания и сооружения ${num(percent)} % при нормативе ${num(row.percent)} % для капремонта (${found.label}) — занижено (332/пр, приложение 2, п. ${row.item})`,
          });
        }
      } else {
        findings.push({
          severity: "INFO",
          amount: null,
          message: `Временные здания и сооружения ${num(percent)} %: для капремонта нормативы 332/пр (приложение 2) — от 0,2 до 1,9 % по видам работ; вид объекта по названию сметы не определён, сверка не сделана`,
        });
      }
    } else {
      findings.push({
        severity: "INFO",
        amount: null,
        message: `Временные здания и сооружения у заказчика ${num(percent)} %: вид работ по названию сметы не определён, сверка с приложениями 1 и 2 к 332/пр не сделана`,
      });
    }
  }

  if (input.winter !== null) {
    const percent = input.winter.percent;
    const kindRow = phase === "DEMOLITION" ? winterRow("A1-88") : null;
    const zone = input.subject === null ? null : resolveWinterZone(input.subject, normalizeRegionText(input.text).split(" "));
    if (kindRow !== null && zone !== null && zone.ok) {
      const base = kindRow.percent[zone.part.zone];
      if (base !== undefined) {
        const expected = Number((base * zone.part.coefficient).toFixed(4));
        const diff = percent - expected;
        const money = Math.round((diff / 100) * input.base);
        findings.push({
          severity: "INFO",
          amount: money,
          message:
            `Зимнее удорожание ${num(percent)} % при нормативе ${num(expected)} % (снос разборкой, ${zone.part.zone} температурная зона, коэффициент ${num(zone.part.coefficient)}: 325/пр, приложение 1, п. 88; приложение 4, п. ${zone.part.item}) — ` +
            (Math.abs(diff) < 0.05 ? "совпадает" : diff > 0 ? `больше на ${num(diff)} п.п.` : `меньше на ${num(-diff)} п.п.`) +
            `. Норматив среднегодовой и применяется на весь период работ (п. 11), если работы не только летом (п. 9)`,
        });
      }
    }
    if (findings.every((item) => !item.message.startsWith("Зимнее"))) {
      findings.push({
        severity: "INFO",
        amount: null,
        message: `Зимнее удорожание у заказчика ${num(percent)} %: нормативы 325/пр зависят от вида работ и температурной зоны (${WINTER.rows.length} строк приложений 1-2, коэффициенты приложения 4); вид работ или зона по смете не определены, сверка не сделана`,
      });
    }
  }
  return findings;
}
