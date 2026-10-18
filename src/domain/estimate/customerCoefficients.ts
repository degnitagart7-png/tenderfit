import { checkCustomerCoefficients, coefficientValues } from "@/domain/estimate/customerNormatives";
import type { CustomerPosition } from "@/domain/estimate/customerLsr";
import { parseNormCodeHint } from "@/domain/estimate/normCodes";
import { EQUIPMENT_DEMOLITION, formatDecimal, OVERHEAD_MULTIPLIERS, WORK_CONDITIONS } from "@/domain/estimate/normatives";
import type { BillOfWorkItem, CustomerConditions, CustomerRateMultiplier, RejectedCustomerClaim } from "@/domain/estimate/types";
import { hasStarFactors, starFactors } from "@/domain/estimate/smetaRu";
import { classifyPosition, type NormColumn } from "@/domain/estimate/workConditions";

/**
 * Коэффициенты заказчика к позициям его ЛСР: сверка с приложением 10 к 421/пр и п. 58.
 *
 * Зачем. Заказчик применяет к позиции поправочные коэффициенты — «в помещениях эксплуатируемого объекта»
 * (ОЗП, ЭМ, ЗПМ, ТЗ × 1,2), п. 58 для ремонта по нормам нового строительства (труд × 1,15, машины × 1,25) — и
 * его цена выше нормативной на их величину. Без них наш расчёт по той же ЛСР занижен: на закупке
 * 0302300048726001118 это 29 тыс. ₽ в смете вентиляции и 5 тыс. ₽ в смете фасада. Но слепо принимать
 * коэффициент нельзя: у заказчика бывают значения, которых в приказе нет (ОЗП=0,3 при демонтаже
 * оборудования по ФЕР-методике, 0,65 при наладке по прил. 3.3), и 1,2 к материалам, которых приложение 10 не знает.
 *
 * Правило. Заказчик ссылается на пункт («421/пр_2020_прил.10_т.3_п.1.1_гр.3», «421/пр_2020_п.58_пп.б»), а
 * код проверяет ссылку по таблицам `work-conditions.json`:
 * - пункт есть в приложении 10, для книги позиции в таблице не прочерк, и значения, напечатанные в смете
 *   (ОЗП, ТЗ, ЭМ, ЗПМ, ТЗМ), равны значению таблицы, а к материалам (МАТ) коэффициента нет — подтверждено,
 *   условие применяется к позиции как у заказчика;
 * - ссылка на то же приложение через изменяющий приказ — «Приказ от 07.07.2022 № 557/пр прил.8 табл.1 п.5»: приложение 8 к 557/пр —
 *   новая редакция приложения 10 к 421/пр (таблицы и пункты те же, тексты совпадают), поэтому ссылка читается как «приложение 10,
 *   таблица 1, п. 5» и проверяется так же, плюс текст пункта в смете должен совпасть с таблицей;
 * - п. 58 — только к ГЭСН (не ГЭСНм, ГЭСНр, ГЭСНмр, ГЭСНп, не сборник 46), не к разборке (п. 59), а значения —
 *   1,15 и 1,25;
 * - разборка и демонтаж по Методике применения сметных норм 571/пр (п. 83, таблица 2 — ГЭСН, конструкции, системы и сети; п. 84,
 *   таблица 3 — ГЭСНм, оборудование): «571/пр_2022_п.83_т.2_стр.5_стб.3». Строка таблицы и значение сверяются со справочником
 *   (`equipment-demolition.json`, числа сверены по официальному PDF); к труду, машинам и машинистам — значение, к материалам — 0;
 * - разборка и демонтаж без ссылки на строку («ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7» у Smeta.RU, «ОЗП=0,7; ЭМ=0,7; ЗПМ=0,7; ТЗМ=0,7; МАТ=0» у Гранд-Сметы),
 *   когда в наименовании позиции есть «Демонтаж» или «Разборка»: если труд, машины и машинисты умножены на одно число k, материалы — на 0, ничего
 *   иного (НР, СП, прочие множители) в строке нет, а k есть в таблице 2 (позиция ГЭСН) или таблице 3 (ГЭСНм) Методики 571/пр, коэффициент применяется
 *   как по ссылке на строку; строки, где такое значение стоит, названы все (при одинаковых значениях строк значение достоверно, а какая именно строка
 *   — сказать нельзя). Другое значение, смешанные множители, не та книга — не подтверждено, как и всё прочее;
 * - всё остальное — не подтверждено: не применяется, называется находкой с суммой (текст — тот же, что
 *   в аудите, `checkCustomerCoefficients`).
 * Расчёт применяет подтверждённое теми же правилами, что и условия, выбранные человеком (`workConditions.ts`):
 * то же условие, названное дважды, второй раз не применяется, условия одной группы складываются по п. 52.
 */

const COLUMN_OF_BOOK: Readonly<Record<string, NormColumn>> = { GESN: "gesn", GESNM: "gesnm", GESNR: "gesnr", GESNP: "gesnp" };
const APPENDIX_10_REF = /прил\.?\s*10\D{0,3}(?:табл|т)\.?\s*(\d+)\D{0,3}п\.?\s*(\d+(?:\.\d+)*)/iu;
/** «Приказ от 07.07.2022 № 557/пр прил.8 табл.1 п.5»: приложение 8 к 557/пр — новая редакция приложения 10 к 421/пр. */
const APPENDIX_8_557_REF = /557\s*\/\s*пр.{0,60}?прил(?:ожени[ея])?\.?\s*8(?!\d)\D{0,3}(?:табл|т)\.?\s*(\d+)\D{0,3}п\.?\s*(\d+(?:\.\d+)*)/iu;
const P58_REF = /421\/пр\S{0,10}?п\.?\s*58(?!\d)/iu;
/** «648/пр_2022_п.145_т.3_стр.4_стб.3»: приказ, пункт, таблица, строка (методика по ФЕР; таблица 3 повторяет таблицу 3 п. 84 Методики 571/пр). */
const DEMOLITION_648_REF = /648\/пр\S{0,12}?п\.?\s*145\S{0,3}?(?:табл|т)\.?\s*(\d+)\S{0,3}?стр\.?\s*(\d+)/iu;
/** Любое упоминание Методики 571/пр: «571/пр_2022_п.83_т.2_стр.5_стб.3», «Методика 571/пр п.83 табл.2 п.5». */
const METHODIKA_571_REF = /571\s*\/\s*пр/iu;
const K_RE = /(?<![\p{L}])К\s*=\s*(\d+(?:[.,]\d+)?)/iu;
const UNAVAILABLE_REF = /(?:^|[^\p{L}])Прил\.?\s*3\.3/iu;
const FACTOR_RE = /(ОЗП|ЭМ|ЗПМ|МАТ|ТЗМ|ТЗ|ПЗ)\s*=\s*(\d+(?:[.,]\d+)?)/giu;

const PHASE_OF_TABLE: Readonly<Record<number, "CONSTRUCTION" | "RECONSTRUCTION" | "CAPITAL_REPAIR" | "COMMISSIONING">> = {
  1: "CONSTRUCTION",
  2: "CONSTRUCTION",
  3: "RECONSTRUCTION",
  4: "RECONSTRUCTION",
  5: "CAPITAL_REPAIR",
  6: "CAPITAL_REPAIR",
  7: "COMMISSIONING",
  8: "COMMISSIONING",
};

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const k = (value: number): string => formatDecimal(value, 2);

interface Factors {
  readonly labour: number | null;
  readonly machines: number | null;
  readonly materials: number | null;
  readonly all: readonly number[];
}

/** Значения, напечатанные в тексте: ОЗП и ТЗ — к труду, ЭМ, ЗПМ и ТЗМ — к машинам, МАТ — к материалам. */
export function statedFactors(text: string): Factors {
  let labour: number | null = null;
  let machines: number | null = null;
  let materials: number | null = null;
  const all: number[] = [];
  for (const match of text.matchAll(FACTOR_RE)) {
    const key = (match[1] as string).toUpperCase();
    const value = Number((match[2] as string).replace(",", "."));
    if (!Number.isFinite(value)) continue;
    all.push(value);
    if (key === "ОЗП" || key === "ТЗ") labour = value;
    else if (key === "ЭМ" || key === "ЗПМ" || key === "ТЗМ") machines = value;
    else if (key === "МАТ") materials = value;
  }
  // Поправки Smeta.RU: «ЭМ *1,25; ЗТ *1,15; ЗТм *1,25; М *0; НР *0,9». Материалы и НР/СП в `all` не идут: там только труд и машины.
  const star = starFactors(text);
  for (const value of [...star.labour, ...star.machines, ...star.machinist]) all.push(value);
  const lastLabour = star.labour[star.labour.length - 1];
  if (lastLabour !== undefined) labour = lastLabour;
  const lastMachines = star.machinist[star.machinist.length - 1] ?? star.machines[star.machines.length - 1];
  if (lastMachines !== undefined) machines = lastMachines;
  const lastMaterials = star.materials[star.materials.length - 1];
  if (lastMaterials !== undefined) materials = lastMaterials;
  return { labour, machines, materials, all };
}

interface Claim {
  readonly ref: string;
  readonly text: string;
}

/**
 * Заявления заказчика: каждое пояснение под позицией — своё, фигурные скобки — тоже. Строка без ссылки («Коэффициент
 * к заработной плате ОЗП=1,2; ТЗ=1,2») — не продолжение условия выше: программа печатает такие строки, когда
 * сметчик добавил коэффициент вручную, и он применён сверх условия (на ЛСР 02-02-08 закупки 0302300048726001118 к
 * позиции с условием «в помещениях» ×1,2 добавлено ещё ×1,2, и труд вышел ×1,44 — приложение 10 такого не знает).
 */
function claimsOf(position: CustomerPosition): Claim[] {
  const claims: Claim[] = (position.notes ?? []).map((note) => ({ ref: note.ref.trim(), text: note.text.replace(/\s+/g, " ").trim() }));
  if (position.coefficients !== null) claims.push({ ref: "{}", text: position.coefficients.replace(/\s+/g, " ").trim() });
  return claims;
}

/** Заявление говорит о коэффициенте: в тексте есть «ОЗП=…», «ЭМ=…» или это ссылка на приложение 10 (в том числе через 557/пр), п. 58, 571/пр. */
function isCoefficientClaim(claim: Claim): boolean {
  return (
    APPENDIX_10_REF.test(claim.ref) ||
    APPENDIX_8_557_REF.test(claim.ref) ||
    P58_REF.test(claim.ref) ||
    statedFactors(claim.text).all.length > 0 ||
    hasStarFactors(claim.text) ||
    claim.ref === "{}" ||
    demolitionCitation(claim) !== null ||
    isDemolitionKClaim(claim)
  );
}

/* ------------------- Разборка и демонтаж: 571/пр п. 83-84 (таблицы 2 и 3), 648/пр п. 145 ------------------- */

/** Таблица, которую даёт пункт Методики 571/пр: п. 83 — таблица 2 (ГЭСН), п. 84 — таблица 3 (ГЭСНм). */
const TABLE_OF_POINT_571: Readonly<Record<number, number>> = { 83: 2, 84: 3 };
const DEMOLITION_WORDS_RE = /демонтаж|разборк/iu;

interface DemolitionCitation {
  /** Приказ, на который сослался заказчик. */
  readonly order: "571/пр" | "648/пр";
  readonly point: number | null;
  readonly table: number | null;
  readonly row: number | null;
}

/**
 * Ссылка заказчика на коэффициент разборки и демонтажа: «571/пр_2022_п.83_т.2_стр.5_ стб.3», «Методика 571/пр п.83 табл.2 п.5»,
 * «648/пр_2022_п.145_т.3_стр.4_стб.3». null — в заявлении такой ссылки нет. Пункт, таблица или строка, которых в тексте нет, — null:
 * строку коэффициента тогда определить нельзя, и заявление не подтверждается.
 */
function demolitionCitation(claim: Claim): DemolitionCitation | null {
  const fer = DEMOLITION_648_REF.exec(claim.ref);
  if (fer !== null) return { order: "648/пр", point: 145, table: Number(fer[1]), row: Number(fer[2]) };
  const haystack = claim.ref === "{}" || claim.ref === "" ? claim.text : `${claim.ref} ${claim.text}`;
  const found = METHODIKA_571_REF.exec(haystack);
  if (found === null) return null;
  const tail = haystack.slice(found.index + found[0].length);
  const pointMatch = /(?<![\p{L}\d])п(?:ункт)?\.?\s*(8[2-8])(?!\d)/iu.exec(tail);
  const tableMatch = /(?<![\p{L}])(?:табл(?:ица)?|т)\.?\s*(\d)(?!\d)/iu.exec(tail);
  const point = pointMatch === null ? null : Number(pointMatch[1]);
  const table = tableMatch !== null ? Number(tableMatch[1]) : point === null ? null : (TABLE_OF_POINT_571[point] ?? null);
  const rowMatch =
    /стр(?:ок[аи])?\.?\s*(\d+)/iu.exec(tail) ??
    (tableMatch === null ? null : /(?<![\p{L}\d])п\.?\s*(\d+)/iu.exec(tail.slice(tableMatch.index + tableMatch[0].length)));
  return { order: "571/пр", point, table, row: rowMatch === null ? null : Number(rowMatch[1]) };
}

/** «Прил. … демонтаж … К=0,6» без ссылки на приказ: коэффициент разборки назван, а откуда он, неизвестно. */
function isDemolitionKClaim(claim: Claim): boolean {
  return K_RE.test(claim.text) && DEMOLITION_WORDS_RE.test(`${claim.ref} ${claim.text}`);
}

/** Строка справочника по ссылке заказчика: на 571/пр — основная запись, на 648/пр п. 145 — запись-алиас той же строки таблицы 3. */
function demolitionEntry(citation: DemolitionCitation, table: number, row: number): (typeof EQUIPMENT_DEMOLITION.equipmentDemolition)[number] | undefined {
  return EQUIPMENT_DEMOLITION.equipmentDemolition.find((candidate) =>
    citation.order === "571/пр"
      ? candidate.table === table && candidate.row === row
      : (candidate.aliases ?? []).some((alias) => alias.order === citation.order && alias.table === table && alias.row === row),
  );
}

/* ---- Разборка и демонтаж без ссылки на строку: коэффициент опознаётся по значению (571/пр п. 83–84, таблицы 2 и 3) ---- */

/** Что стоит в строке поправок: множители к труду, машинам, машинистам, материалам и прочее. Обе записи: «ЗТ *0,7» (Smeta.RU) и «ОЗП=0,7» (Гранд-Смета). */
interface FactorGroups {
  readonly labour: readonly number[];
  readonly machines: readonly number[];
  readonly machinist: readonly number[];
  readonly materials: readonly number[];
  /** Всё прочее: НР и СП (множители к нормативам начислений), «ПЗ=…». Поправка на разборку этого не содержит. */
  readonly other: number;
}

function factorGroups(text: string): FactorGroups {
  const star = starFactors(text);
  const labour = [...star.labour];
  const machines = [...star.machines];
  const machinist = [...star.machinist];
  const materials = [...star.materials];
  let other = star.accruals.length;
  for (const match of text.matchAll(FACTOR_RE)) {
    const key = (match[1] as string).toUpperCase();
    const value = Number((match[2] as string).replace(",", "."));
    if (!Number.isFinite(value)) continue;
    if (key === "ОЗП" || key === "ТЗ") labour.push(value);
    else if (key === "ЭМ") machines.push(value);
    else if (key === "ЗПМ" || key === "ТЗМ") machinist.push(value);
    else if (key === "МАТ") materials.push(value);
    else other += 1;
  }
  return { labour, machines, machinist, materials, other };
}

type DemolitionEntry = (typeof EQUIPMENT_DEMOLITION.equipmentDemolition)[number];

/**
 * Узнаётся ли в заявлении без ссылки поправка на разборку: труд, машины и машинисты — одно значение k, материалы — 0, больше ничего.
 * null — заявление не такое (другие значения, смешанные множители, нет материалов *0, нет машинистов: полная поправка Методики 571/пр называет все
 * четыре составляющие); решает общий путь «не подтверждено».
 */
function demolitionPattern(claim: Claim): number | null {
  const groups = factorGroups(claim.text);
  if (groups.other > 0) return null;
  if (groups.labour.length === 0 || groups.machines.length === 0 || groups.machinist.length === 0 || groups.materials.length === 0) return null;
  if (!groups.materials.every((value) => near(value, 0))) return null;
  const k = groups.labour[0] as number;
  if (!(k > 0) || ![...groups.labour, ...groups.machines, ...groups.machinist].every((value) => near(value, k))) return null;
  return k;
}

/** Строки таблиц Методики 571/пр, в которых стоит значение k для книги позиции: таблица 2 — ГЭСН, таблица 3 — ГЭСНм. */
function demolitionRowsByValue(book: string, k: number): { rows: DemolitionEntry[]; ofBook: DemolitionEntry[] } {
  const ofBook = EQUIPMENT_DEMOLITION.equipmentDemolition.filter((entry) => entry.books.includes(book));
  return { rows: ofBook.filter((entry) => near(entry.labour, k)), ofBook };
}

const rowsWord = (rows: readonly DemolitionEntry[]): string =>
  rows.length === 1 ? `строка ${String(rows[0]?.row)}` : `строки ${rows.map((entry) => String(entry.row)).join(" и ")}`;

const demolitionWhat = (scope: "CONSTRUCTION" | "EQUIPMENT"): string =>
  scope === "EQUIPMENT" ? "демонтаж оборудования" : "разборка и демонтаж конструкций, систем и сетей";

const normalizeWords = (text: string): string =>
  text
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Совпадает ли текст пункта в смете заказчика («Производство работ осуществляется в стесненных условиях … ОЗП=1,15; …») с текстом
 * пункта таблицы. null — в пояснении текста пункта нет, сверять нечего. Многоточие в смете — пропуск: каждая часть должна быть в тексте пункта.
 */
function conditionTextMatches(claimText: string, conditionText: string): boolean | null {
  const first = claimText.search(/(?:ОЗП|ЭМ|ЗПМ|МАТ|ТЗМ|ТЗ|ПЗ)\s*=/iu);
  const head = first < 0 ? claimText : claimText.slice(0, first);
  const parts = head
    .split(/…|\.{3}/u)
    .map(normalizeWords)
    .filter((part) => part.length >= 10);
  if (parts.length === 0) return null;
  const target = normalizeWords(conditionText);
  return parts.every((part) => target.includes(part));
}

function directLabourMachines(position: CustomerPosition): number {
  const groups = position.groupTotals;
  return (groups.labour ?? 0) + (groups.machines ?? 0) + (groups.machinistLabour ?? 0);
}

function rejectedClaim(position: CustomerPosition, claim: Claim, reason: string, kValue: number | null = null): RejectedCustomerClaim {
  const factors = statedFactors(claim.text);
  const values = factors.all.length > 0 ? factors.all : kValue !== null ? [kValue] : coefficientValues(claim.text);
  const first = values[0];
  const base = directLabourMachines(position);
  const amount = first !== undefined && first > 0 && base > 0 ? Math.round(base * (1 - 1 / first) * 100) / 100 : null;
  // Что приложение 10 говорит о самом значении — только когда ссылка на пункт отсутствует или чужая: иначе справка о
  // «допустимом» значении сбивала бы с толку рядом с причиной отказа.
  const check = /^(?:ссылк)/u.test(reason) ? checkCustomerCoefficients(claim.text, bookKey(position)) : "";
  return {
    text: claim.text.length > 200 ? `${claim.text.slice(0, 197)}…` : claim.text,
    reason: check === "" ? reason : `${reason}. ${check}`,
    amount,
    labour: factors.labour ?? kValue,
    machines: factors.machines ?? kValue,
  };
}

function bookKey(position: CustomerPosition): string {
  return position.book;
}

/** Код сборника из шифра: «15-01-050-04» → «15». */
function collectionOf(position: CustomerPosition): string {
  const hint = parseNormCodeHint(position.rawJustification);
  return hint === null ? "" : hint.code.slice(0, 2);
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

/* --------------------- Множители заказчика к НР и СП (812/пр п. 25, 774/пр п. 16) --------------------- */

const ORDER_POINT_REF = /(812|774)\/пр[^п]{0,30}?п\.?\s*(\d+)/iu;
/** Smeta.RU называет приказ указателем норматива: «Пр/812-009.0-1; п.25» — 812/пр, пункт 25. */
const ORDER_POINT_REF_SMETA_RU = /Пр\/(812|774)-[\d.]+(?:-\d+)?[;,\s]*п\.?\s*(\d+)/iu;

const pointNumber = (point: string): string => /(\d+)/u.exec(point)?.[1] ?? "";

interface RateClaims {
  readonly overhead: CustomerRateMultiplier | null;
  readonly profit: CustomerRateMultiplier | null;
  readonly rejected: RejectedCustomerClaim[];
}

/**
 * Множители заказчика к нормативам НР и СП: графа 6 строки норматива («% 89 0,9 80,1») со ссылкой «Приказ № 812/пр п.25».
 * Подтверждается, если пункт в `overhead-multipliers.json` даёт такой множитель к такому нормативу, значение совпало, и это тот
 * случай, на который пункт рассчитан: ремонт по ГЭСН с п. 58 (`p58Confirmed` — п. 58 у позиции подтверждён). Условия, которые по
 * смете не проверить (особо опасные объекты, п. 27; производственные объекты и сети, п. 26), расчёт проверяет сам по нашей норме
 * (`rateMultipliers.ts`) или называет в пояснении.
 */
function evaluateRateClaims(position: CustomerPosition, p58Confirmed: boolean): RateClaims {
  const rejected: RejectedCustomerClaim[] = [];
  const out: { overhead: CustomerRateMultiplier | null; profit: CustomerRateMultiplier | null } = { overhead: null, profit: null };
  const kinds = [
    { rate: position.overhead, normative: "OVERHEAD" as const, name: "НР", key: "overhead" as const },
    { rate: position.profit, normative: "PROFIT" as const, name: "СП", key: "profit" as const },
  ];
  for (const { rate, normative, name, key } of kinds) {
    const factor = rate?.coefficient ?? null;
    if (rate === null || factor === null || near(factor, 1) || !(factor > 0)) continue;
    const reject = (reason: string, id: string | null = null): void => {
      const amount = rate.amount === null ? null : Math.round(rate.amount * (1 - 1 / factor) * 100) / 100;
      rejected.push({
        text: `множитель ${k(factor)} к нормативу ${name} (${rate.rawRef.replace(/\s+/g, " ").trim().slice(0, 90)})`,
        reason: id === null ? reason : `${reason} [${id}]`,
        amount,
        labour: null,
        machines: null,
        overheadMultiplier: key === "overhead" ? factor : null,
        profitMultiplier: key === "profit" ? factor : null,
      });
    };

    const ref = ORDER_POINT_REF.exec(rate.rawRef) ?? ORDER_POINT_REF_SMETA_RU.exec(rate.rawRef);
    if (ref === null) {
      reject(`ссылки на приказ и пункт (812/пр, 774/пр) у множителя ${k(factor)} к ${name} в смете нет`);
      continue;
    }
    const order = `${ref[1] as string}/пр`;
    const point = ref[2] as string;
    const ofPoint = OVERHEAD_MULTIPLIERS.multipliers.filter((item) => item.order === order && pointNumber(item.point) === point);
    const forNormative = ofPoint.filter((item) => item.normative === normative);
    if (ofPoint.length === 0) {
      reject(`в ${order} п. ${point} множителей к нормативам накладных расходов и сметной прибыли нет`);
      continue;
    }
    if (forNormative.length === 0) {
      reject(`${order} п. ${point} даёт множитель к нормативу ${normative === "OVERHEAD" ? "сметной прибыли" : "накладных расходов"}, а в смете он стоит у ${name}`);
      continue;
    }
    const match = forNormative.find((item) => near(item.value, factor));
    if (match === undefined) {
      reject(`в смете ${k(factor)}, а ${order} ${(forNormative[0] as { point: string }).point} даёт ${forNormative.map((item) => k(item.value)).join(" или ")}`);
      continue;
    }
    if (match.requires === "SPECIAL_OBJECT") {
      reject(`${order} ${match.point}: множитель ${k(factor)} — только для особо опасных и технически сложных объектов; по смете это не проверить`);
      continue;
    }
    if (!p58Confirmed) {
      reject(`${order} ${match.point} применим вместе с пп. «б» п. 58 Методики 421/пр (ремонт по ГЭСН, аналогичным новому строительству); у позиции п. 58 не подтверждён`);
      continue;
    }
    out[key] = { id: match.id, value: match.value, label: `${order} ${match.point} (${k(match.value)})` };
  }
  return { ...out, rejected };
}

/**
 * Коэффициенты заказчика позиции, сверенные с приложением 10. null — заказчик к позиции коэффициентов не
 * применял (или позиция не расценка: оборудование и материалы по ТЦ и ФСБЦ идут по цене, а не по норме).
 */
export function evaluateCustomerConditions(position: CustomerPosition): CustomerConditions | null {
  const column = COLUMN_OF_BOOK[position.book];
  if (position.book !== "GESN" && position.book !== "GESNM" && position.book !== "GESNR" && position.book !== "GESNP" && position.book !== "GESNMR") {
    return null;
  }
  const claims = claimsOf(position).filter(isCoefficientClaim);

  let special: NonNullable<CustomerConditions["special"]> | undefined;
  const ids: string[] = [];
  /** Значения условий, подтверждённых выше: строка без ссылки с тем же значением — повтор, а не новое основание. */
  const confirmedValues: number[] = [];
  let p58 = false;
  let phase: "CONSTRUCTION" | "RECONSTRUCTION" | "CAPITAL_REPAIR" | null = null;
  const rejected: RejectedCustomerClaim[] = [];
  const labels: string[] = [];

  for (const claim of claims) {
    const factors = statedFactors(claim.text);
    const nativeAppendix = APPENDIX_10_REF.exec(claim.ref);
    // Через изменяющий приказ: «557/пр прил.8 табл.1 п.5» — та же таблица и тот же пункт приложения 10 (новая редакция).
    const amended = nativeAppendix === null ? APPENDIX_8_557_REF.exec(claim.ref) : null;
    const appendix = nativeAppendix ?? amended;

    if (appendix !== null) {
      const table = Number(appendix[1]);
      const item = appendix[2] as string;
      const where = amended === null ? "в приложении 10" : "в приложении 8 к 557/пр (новая редакция приложения 10 к 421/пр)";
      const condition = WORK_CONDITIONS.conditions.find((candidate) => candidate.table === table && candidate.item === item);
      if (condition === undefined) {
        rejected.push(rejectedClaim(position, claim, `${where} нет таблицы ${String(table)}, п. ${item}`));
        continue;
      }
      if (column === undefined) {
        rejected.push(rejectedClaim(position, claim, `для норм этой книги коэффициентов приложения 10 нет`));
        continue;
      }
      const value = condition.coefficients[column];
      if (value === null || value === undefined) {
        rejected.push(rejectedClaim(position, claim, `в таблице ${String(table)}, п. ${item} для норм этой книги стоит прочерк`));
        continue;
      }
      const stated = [factors.labour, factors.machines].filter((item): item is number => item !== null);
      const wrong = stated.find((item) => !near(item, value));
      if (wrong !== undefined) {
        rejected.push(rejectedClaim(position, claim, `в смете ${k(wrong)}, а таблица ${String(table)}, п. ${item} даёт ${k(value)}`));
        continue;
      }
      if (factors.materials !== null && !near(factors.materials, 1)) {
        rejected.push(rejectedClaim(position, claim, `к материалам (МАТ=${k(factors.materials)}) приложение 10 коэффициентов не применяет: только к труду рабочих, машинам и труду машинистов`));
        continue;
      }
      // Ссылка через 557/пр косвенная: пункт проверяется ещё и по тексту — условие в смете должно быть тем, что в таблице.
      if (amended !== null && conditionTextMatches(claim.text, condition.text) === false) {
        rejected.push(rejectedClaim(position, claim, `текст пункта в смете не совпадает с таблицей ${String(table)}, п. ${item} приложения 10 к 421/пр (ссылка «557/пр прил.8» читается как приложение 10)`));
        continue;
      }
      const tablePhase = PHASE_OF_TABLE[table];
      if (tablePhase === undefined) {
        rejected.push(rejectedClaim(position, claim, `таблица ${String(table)} не читается`));
        continue;
      }
      ids.push(condition.id);
      confirmedValues.push(value);
      if (tablePhase !== "COMMISSIONING" && phase === null) phase = tablePhase;
      labels.push(
        `приложение 10 к 421/пр, таблица ${String(table)}, п. ${item} (К = ${k(value)})${amended === null ? "" : "; ссылка заказчика на 557/пр прил. 8 — новая редакция приложения 10"}`,
      );
      continue;
    }

    const citation = demolitionCitation(claim);
    if (citation !== null) {
      const { table, row, point } = citation;
      const entry = table === null || row === null ? undefined : demolitionEntry(citation, table, row);
      const cited = citation.order === "571/пр" ? "Методике 571/пр (п. 83, таблица 2; п. 84, таблица 3)" : "648/пр п. 145";
      const kStated = K_RE.exec(claim.text);
      const kValue = kStated === null ? null : Number((kStated[1] as string).replace(",", "."));
      if (table === null || row === null) {
        rejected.push(rejectedClaim(position, claim, `в ссылке на ${citation.order} нет таблицы и строки: строку коэффициента на разборку и демонтаж определить нельзя`, kValue));
      } else if (citation.order === "571/пр" && point !== null && TABLE_OF_POINT_571[point] !== table) {
        rejected.push(rejectedClaim(position, claim, `в Методике 571/пр коэффициенты дают только п. 83 (таблица 2) и п. 84 (таблица 3): ссылка на п. ${String(point)}, таблицу ${String(table)} не сходится`, kValue));
      } else if (entry === undefined) {
        rejected.push(rejectedClaim(position, claim, `в ${cited} нет таблицы ${String(table)}, строки ${String(row)}`, kValue));
      } else if (!entry.books.includes(position.book)) {
        rejected.push(
          rejectedClaim(
            position,
            claim,
            entry.scope === "EQUIPMENT"
              ? `${entry.order} ${entry.point} — коэффициенты на демонтаж оборудования к нормам монтажа ГЭСНм; у позиции другая книга`
              : `${entry.order} ${entry.point} — коэффициенты на разборку и демонтаж конструкций, систем и сетей к нормам ГЭСН на устройство, установку; у позиции другая книга`,
            kValue,
          ),
        );
      } else if (
        [factors.labour, factors.machines, kValue].some((value) => value !== null && !near(value, entry.labour)) ||
        (factors.materials !== null && !near(factors.materials, entry.materials))
      ) {
        rejected.push(
          rejectedClaim(
            position,
            claim,
            `значения в смете не совпадают со строкой ${String(row)} таблицы ${String(table)} (${entry.order} ${entry.point}: труд, машины и машинисты ${k(entry.labour)}, материалы не учитываются)`,
            kValue,
          ),
        );
      } else if (special !== undefined) {
        rejected.push(rejectedClaim(position, claim, "коэффициент на разборку и демонтаж у позиции уже подтверждён выше: второй раз не применяется", kValue));
      } else {
        const alias = (entry.aliases ?? []).find((candidate) => candidate.order === citation.order);
        special = {
          id: entry.id,
          labour: entry.labour,
          machines: entry.machines,
          materials: entry.materials,
          valueVerified: entry.valueVerified,
          label:
            `${entry.order} ${entry.point} (${demolitionWhat(entry.scope)}: труд, машины и машинисты × ${k(entry.labour)}, материалы не учитываются)` +
            (alias === undefined ? "" : `; заказчик сослался на ${alias.order} ${alias.point} — та же строка таблицы`),
        };
        labels.push(special.label);
      }
      continue;
    }

    // «Прил. … демонтаж … К=0,6» без ссылки на приказ: коэффициент не подтверждён ни одной строкой, находка с суммой.
    if (isDemolitionKClaim(claim) && factors.all.length === 0) {
      const kValue = Number((K_RE.exec(claim.text)?.[1] as string).replace(",", "."));
      const rows = EQUIPMENT_DEMOLITION.equipmentDemolition.filter((candidate) => near(candidate.labour, kValue));
      rejected.push(
        rejectedClaim(
          position,
          claim,
          rows.length > 0
            ? `ссылки на Методику 571/пр (п. 83 табл. 2, п. 84 табл. 3) с таблицей и строкой в смете нет; значение ${k(kValue)} есть в ${rows.map((entry) => `${entry.point}`).join("; ")} — без ссылки на строку не применяется`
            : `ссылки на Методику 571/пр в смете нет, и значения ${k(kValue)} нет в таблицах 2 и 3 (п. 83, 84)`,
          kValue,
        ),
      );
      continue;
    }

    if (UNAVAILABLE_REF.test(claim.ref) && isCoefficientClaim(claim)) {
      const unavailable = EQUIPMENT_DEMOLITION.unavailable.find((item) => UNAVAILABLE_REF.test(item.ref));
      rejected.push(rejectedClaim(position, claim, unavailable?.reason ?? "первоисточник недоступен — проверьте вручную"));
      continue;
    }

    if (P58_REF.test(claim.ref)) {
      const adjustment = WORK_CONDITIONS.adjustments.find((candidate) => candidate.id === "P58");
      const kind = classifyPosition(`${position.name}`, collectionOf(position));
      const values = coefficientValues(claim.text);
      if (adjustment === undefined) {
        rejected.push(rejectedClaim(position, claim, "п. 58 в таблицах нормативов не заведён"));
      } else if (position.book !== "GESN" || collectionOf(position) === "46") {
        rejected.push(rejectedClaim(position, claim, "п. 59 Методики: коэффициенты п. 58 не применяются к ГЭСНм, ГЭСНр, ГЭСНмр, ГЭСНп и сборнику 46"));
      } else if (kind.demolition) {
        rejected.push(rejectedClaim(position, claim, "п. 59 Методики: коэффициенты п. 58 не применяются к нормам на разборку (демонтаж)"));
      } else if (values.some((value) => !near(value, adjustment.labour) && !near(value, adjustment.machines))) {
        rejected.push(rejectedClaim(position, claim, `в смете не ${k(adjustment.labour)} и ${k(adjustment.machines)}, как в п. 58`));
      } else {
        p58 = true;
        phase ??= "CAPITAL_REPAIR";
        labels.push(`п. 58 Методики 421/пр (${k(adjustment.labour)} к труду, ${k(adjustment.machines)} к машинам)`);
      }
      continue;
    }

    if (!isCoefficientClaim(claim)) continue;

    // Разборка и демонтаж без ссылки на строку («ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7»): значение сверяется с таблицей книги позиции.
    const demolitionK = claim.ref === "" || claim.ref === "{}" ? demolitionPattern(claim) : null;
    if (demolitionK !== null && DEMOLITION_WORDS_RE.test(position.name)) {
      const { rows, ofBook } = demolitionRowsByValue(position.book, demolitionK);
      const first = rows[0];
      if (ofBook.length === 0) {
        rejected.push(
          rejectedClaim(
            position,
            claim,
            `коэффициент на разборку и демонтаж ${k(demolitionK)} без ссылки на строку; Методика 571/пр (п. 83 — ГЭСН, п. 84 — ГЭСНм) к нормам другой книги такие коэффициенты не даёт`,
            demolitionK,
          ),
        );
      } else if (first === undefined) {
        const table = (ofBook[0] as DemolitionEntry).table;
        rejected.push(
          rejectedClaim(
            position,
            claim,
            `коэффициент на разборку и демонтаж ${k(demolitionK)} без ссылки на строку; в таблице ${String(table)} Методики 571/пр (${(ofBook[0] as DemolitionEntry).point.split(",")[0] as string}) такого значения нет: ${ofBook.map((entry) => k(entry.labour)).join("; ")}`,
            demolitionK,
          ),
        );
      } else if (special !== undefined) {
        rejected.push(rejectedClaim(position, claim, "коэффициент на разборку и демонтаж у позиции уже подтверждён выше: второй раз не применяется", demolitionK));
      } else {
        const point = first.point.split(",")[0] as string;
        special = {
          id: rows.map((entry) => entry.id).join("+"),
          labour: first.labour,
          machines: first.machines,
          materials: first.materials,
          valueVerified: rows.every((entry) => entry.valueVerified),
          label:
            `${first.order} ${point}, таблица ${String(first.table)}, ${rowsWord(rows)} (${demolitionWhat(first.scope)}: труд, машины и машинисты × ${k(first.labour)}, материалы не учитываются; ` +
            `${rows.map((entry) => `«${entry.title}»`).join("; ")}); ссылки на строку в смете нет — коэффициент опознан по значению` +
            (rows.length > 1 ? ` (${String(rows.length)} строки таблицы дают одно значение, какая именно — по смете сказать нельзя, значение от этого не меняется)` : ""),
        };
        labels.push(special.label);
      }
      continue;
    }

    const repeat =
      claim.ref === "" &&
      confirmedValues.length > 0 &&
      factors.all.length > 0 &&
      factors.all.every((value) => confirmedValues.some((confirmedValue) => near(value, confirmedValue)));
    rejected.push(
      rejectedClaim(
        position,
        claim,
        repeat
          ? "строка без ссылки повторяет значение условия, подтверждённого выше: заказчик применил коэффициент второй раз, а приложение 10 (п. 52) одинаковые условия не перемножает"
          : claim.ref === "{}" || claim.ref === ""
            ? "ссылки на пункт приложения 10 к 421/пр или п. 58 в смете нет"
            : `ссылка «${claim.ref}» не относится к приложению 10 к 421/пр и п. 58`,
      ),
    );
  }

  const rates = evaluateRateClaims(position, p58);
  rejected.push(...rates.rejected);
  for (const multiplier of [rates.overhead, rates.profit]) if (multiplier !== null) labels.push(`${multiplier.label} к нормативу ${multiplier.id.startsWith("NR") ? "НР" : "СП"}`);

  const confirmed =
    ids.length === 0 && !p58
      ? null
      : { conditionIds: [...new Set(ids)].sort(), p58, phase: phase ?? ("CAPITAL_REPAIR" as const) };
  if (confirmed === null && special === undefined && rates.overhead === null && rates.profit === null && rejected.length === 0) return null;
  return {
    confirmed,
    rejected,
    ...(rates.overhead === null && rates.profit === null ? {} : { rates: { overhead: rates.overhead, profit: rates.profit } }),
    ...(special === undefined ? {} : { special }),
    label: labels.length === 0 ? "" : `как у заказчика: ${labels.join("; ")}`,
    enabled: true,
    forceUnconfirmed: false,
  };
}

/** У позиции есть подтверждённые коэффициенты условий работ или множители к НР и СП. */
export function hasConfirmedConditions(conditions: CustomerConditions | undefined): boolean {
  return (
    conditions !== undefined &&
    (conditions.confirmed !== null || conditions.special !== undefined || conditions.rates?.overhead != null || conditions.rates?.profit != null)
  );
}

/** Позиции ведомости с коэффициентами заказчика: сколько подтверждено, сколько отклонено и на какую сумму. */
export interface CustomerConditionsSummary {
  readonly positions: number;
  readonly confirmed: number;
  readonly rejected: number;
  /** Сумма неподтверждённых коэффициентов заказчика в его прямых затратах, ₽ (модуль). */
  readonly rejectedAmount: number;
  /** Позиций, у которых подтверждённые коэффициенты не применяются (снято переключателем или правкой). */
  readonly disabled: number;
  readonly notes: readonly string[];
}

export function summarizeCustomerConditions(items: readonly BillOfWorkItem[], title = ""): CustomerConditionsSummary {
  const withClaims = items.filter((item) => item.customerConditions !== undefined);
  const confirmed = withClaims.filter((item) => hasConfirmedConditions(item.customerConditions));
  const rejected = withClaims.filter((item) => (item.customerConditions?.rejected ?? []).length > 0);
  const disabled = confirmed.filter((item) => item.customerConditions?.enabled === false);
  const rejectedAmount = rejected.reduce(
    (sum, item) => sum + (item.customerConditions?.rejected ?? []).reduce((inner, claim) => inner + Math.abs(claim.amount ?? 0), 0),
    0,
  );
  const prefix = title === "" ? "" : `${title}: `;
  const notes: string[] = [];
  if (confirmed.length > 0) {
    const labels = [...new Set(confirmed.map((item) => item.customerConditions?.label ?? "").filter((label) => label !== ""))];
    const active = confirmed.length - disabled.length;
    notes.push(
      active > 0
        ? `${prefix}коэффициенты заказчика применены к ${String(active)} из ${String(items.filter((item) => item.unaccountedOf === undefined).length)} позиций — ${labels.join(" | ")}`
        : `${prefix}коэффициенты заказчика подтверждены приложением 10 у ${String(confirmed.length)} позиций, но применение отключено`,
    );
  }
  for (const item of rejected.slice(0, 6)) {
    for (const claim of item.customerConditions?.rejected ?? []) {
      const amount = claim.amount === null ? "" : `, в его прямых затратах ${claim.amount < 0 ? "−" : "+"}${RUB.format(Math.abs(claim.amount))} ₽`;
      notes.push(
        `${prefix}коэффициент заказчика не подтверждается приложением 10 (в расчёт не включён): поз. ${item.positionNumber ?? ""} «${item.workName.slice(0, 60)}» — ${claim.text.slice(0, 120)}; ${claim.reason.split(". По приложению")[0] as string}${amount}`,
      );
    }
  }
  const unverifiedValue = withClaims.filter((item) => item.customerConditions?.special?.valueVerified === false && item.customerConditions.enabled !== false);
  if (unverifiedValue.length > 0) {
    notes.push(`${prefix}коэффициент на разборку и демонтаж (${String(unverifiedValue.length)} позиций): значение принято по смете заказчика — цифры таблицы в сохранённом тексте приказа не сверены, подтверждены только строка таблицы и порядок применения`);
  }
  // Множитель СП по п. 16 774/пр принят по ссылкам смет заказчика: текста приказа в источниках нет — об этом сказано.
  const unverified = withClaims.filter((item) => {
    const profit = item.customerConditions?.rates?.profit;
    return profit != null && item.customerConditions?.enabled !== false && OVERHEAD_MULTIPLIERS.multipliers.some((entry) => entry.id === profit.id && !entry.textVerified);
  });
  if (unverified.length > 0) {
    notes.push(`${prefix}множитель к сметной прибыли (774/пр п. 16, ${String(unverified.length)} позиций) принят по ссылкам сметы заказчика: текст приказа 774/пр в источниках отсутствует и со сверкой не сопоставлен`);
  }
  if (rejected.length > 6) notes.push(`${prefix}и ещё ${String(rejected.length - 6)} позиций с неподтверждёнными коэффициентами заказчика`);
  return {
    positions: withClaims.length,
    confirmed: confirmed.length,
    rejected: rejected.length,
    rejectedAmount: Math.round(rejectedAmount * 100) / 100,
    disabled: disabled.length,
    notes,
  };
}
