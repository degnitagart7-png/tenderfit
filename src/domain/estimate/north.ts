import northJson from "./normativesData/north.json";
import { isSameRegion } from "@/domain/regionCodes";
import { matchStems, stemsOf } from "@/domain/estimate/municipalityMatch";
import type { NorthClass, NorthData, NorthEntry, NorthSubject } from "@/domain/estimate/normativeTypes";
import type { NorthZone } from "@/domain/estimate/overheadNormatives";

/**
 * Районы Крайнего Севера (РКС) и местности, приравненные к ним (МПРКС).
 *
 * Перечень — постановление Правительства РФ от 16.11.2021 N 1946 (действует с 01.01.2022), на него
 * отсылает п. 6 Методики 812/пр (накладные расходы) через статью 2 Закона РФ от 19.02.1993 N 4520-1.
 * Данные — `data/fsnb/normatives/north.json`, собранный из сохранённой выписки приложения. Постановление
 * Совмина СССР от 10.11.1967 N 1029 заменено этим перечнем и не используется.
 *
 * Для субъекта перечень двух видов: субъект целиком (Якутия, Магаданская область) либо списком
 * городских округов, муниципальных районов и округов. Муниципалитет, которого нет в списке частично
 * северного субъекта, — обычная территория: перечень исчерпывающий.
 */

export const NORTH: NorthData = northJson as unknown as NorthData;

/** Как определена северность: для подписи в расчёте и для допущений. */
export type NorthBasis =
  /** Субъект северный целиком. */
  | "SUBJECT"
  /** Совпал муниципалитет из перечня. */
  | "MUNICIPALITY"
  /** Муниципалитет не определён; все районы и города ценовой зоны относятся к одному виду. */
  | "ZONE"
  /** Субъект северный частично, муниципалитет закупки не определён: принята обычная территория. */
  | "UNDETERMINED"
  /** Субъекта нет в перечне либо регион не определён. */
  | "NONE";

export interface NorthResolution {
  readonly zone: NorthZone;
  readonly basis: NorthBasis;
  /** Что совпало: «Северо-Байкальский район», «Республика Саха (Якутия)». */
  readonly matched: string | null;
}

const ISLANDS = /^Все острова/u;

/** Запись перечня по субъекту. */
export function northSubjectOf(subject: string | null): NorthSubject | null {
  if (subject === null || subject.trim() === "") return null;
  return NORTH.subjects.find((item) => !ISLANDS.test(item.subject) && isSameRegion(subject, item.subject)) ?? null;
}

function toZone(cls: NorthClass): NorthZone {
  return cls === "RKS" ? "RKS" : "MPRKS";
}

/** Вид записи: район/округ или город. */
type UnitShape = "district" | "city" | "settlement";

function shapeOf(entry: NorthEntry): UnitShape {
  if (entry.kind === "муниципальный район" || entry.kind === "муниципальный округ") return "district";
  if (entry.kind === "городской округ" || entry.kind === "город") return "city";
  return "settlement";
}

/** Основа названия для сравнения: «Вуктыльский» и «Вуктыл» — одно место. */
function stemKey(name: string): string {
  return stemsOf(name).map((item) => item.stem).join(" ");
}

function sameUnitName(a: string, b: string): boolean {
  const x = stemKey(a);
  const y = stemKey(b);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Вид северности муниципалитета субъекта по названию (без типа): «Баунтовский эвенкийский» и
 * «Северобайкальск». Названия сравниваются по основе, тип записи не важен: в справочнике ФГИС ЦС
 * один и тот же район стоит как «р-н. Вуктыльский», а в перечне — как «Вуктыл».
 *
 * Район вне списка частично северного субъекта — обычная территория (список исчерпывающий). Город вне
 * списка — null: это может быть город внутри северного района (Дудинка в Таймырском районе), и сказать,
 * что он обычный, нельзя.
 */
export function northClassOfUnit(subject: string, shape: "district" | "city", name: string): NorthZone | null {
  const north = northSubjectOf(subject);
  if (north === null) return "TERRITORY";
  if (north.whole !== null) return toZone(north.whole);
  for (const [entries, cls] of [
    [north.rks, "RKS"],
    [north.mprks, "MPRKS"],
  ] as const) {
    for (const entry of entries) {
      if (sameUnitName(entry.name, name)) return toZone(cls);
    }
  }
  return shape === "district" ? "TERRITORY" : null;
}

const CITY_PREFIX = /^(?:г|город[а-я]*|гор)$/u;
const SETTLEMENT_PREFIX = /^(?:п|пгт|рп|с|д|дер|село|села|поселок|поселке|пос|ст|станица)$/u;

/** Рядом с названием стоит слово, которое делает совпадение осмысленным («района», «г.»). */
function contextOk(shape: UnitShape, words: readonly string[], start: number, end: number): boolean {
  const prev = words[start - 1] ?? "";
  const next = words[end + 1] ?? "";
  const next2 = words[end + 2] ?? "";
  switch (shape) {
    case "district":
      return (
        next.startsWith("район") || next.startsWith("округ") || (next === "р" && next2 === "н") || next === "мр" || prev.startsWith("район") || prev.startsWith("округ")
      );
    case "city":
      return CITY_PREFIX.test(prev) || next.startsWith("городск") || next === "го";
    case "settlement":
      return SETTLEMENT_PREFIX.test(prev) || next.startsWith("поселен") || prev.startsWith("поселен");
  }
}

/**
 * Запись перечня, названная в тексте закупки. Берётся самое длинное совпадение; название района без
 * слова «район» рядом не засчитывается («ул. Советская» — не Советский район ХМАО).
 */
export function resolveNorthByText(subject: string, words: readonly string[]): NorthResolution | null {
  const north = northSubjectOf(subject);
  if (north === null || north.whole !== null || words.length === 0) return null;
  let best: { zone: NorthZone; label: string; length: number } | null = null;
  for (const [entries, cls] of [
    [north.rks, "RKS"],
    [north.mprks, "MPRKS"],
  ] as const) {
    for (const entry of entries) {
      const name = entry.name.replace(/\s+(?:Красноармейского|Тере-Хольского)\s.*$/u, "");
      const stems = stemsOf(name);
      const letters = stems.reduce((sum, item) => sum + item.stem.length, 0);
      const shape = shapeOf(entry);
      // Короткие названия («Зея», «Инта») без «г.» рядом дают ложные совпадения со словами.
      if (letters < 4 && shape !== "city") continue;
      const found = matchStems(stems, words);
      if (found === null) continue;
      if (!contextOk(shape, words, found.start, found.end)) continue;
      if (best === null || found.length > best.length) {
        best = { zone: toZone(cls), label: labelOf(entry), length: found.length };
      }
    }
  }
  return best === null ? null : { zone: best.zone, basis: "MUNICIPALITY", matched: best.label };
}

function labelOf(entry: NorthEntry): string {
  switch (entry.kind) {
    case "муниципальный район":
      return `${entry.name} район`;
    case "муниципальный округ":
      return `${entry.name} округ`;
    case "городской округ":
    case "город":
      return `г. ${entry.name}`;
    default:
      return entry.name;
  }
}

/**
 * Северность по субъекту и тексту закупки, без ценовых зон: Якутия — РКС целиком; Иркутская
 * область — по названному району; название не найдено — обычная территория с пометкой.
 */
export function resolveNorth(subject: string | null, words: readonly string[]): NorthResolution {
  const north = northSubjectOf(subject);
  if (north === null || subject === null) return { zone: "TERRITORY", basis: "NONE", matched: null };
  if (north.whole !== null) return { zone: toZone(north.whole), basis: "SUBJECT", matched: north.subject };
  const byText = resolveNorthByText(subject, words);
  if (byText !== null) return byText;
  return { zone: "TERRITORY", basis: "UNDETERMINED", matched: null };
}

/** Подпись основания для сметы: «весь субъект», «по муниципалитету: …». */
export function describeNorthBasis(resolution: NorthResolution): string {
  switch (resolution.basis) {
    case "SUBJECT":
      return `весь субъект в перечне (${resolution.matched ?? ""})`.replace(" ()", "");
    case "MUNICIPALITY":
      return `по муниципалитету: ${resolution.matched ?? ""}`;
    case "ZONE":
      return "все районы и города ценовой зоны одного вида";
    case "UNDETERMINED":
      return "субъект северный частично, муниципалитет закупки не определён";
    case "NONE":
      return "субъекта нет в перечне";
  }
}
