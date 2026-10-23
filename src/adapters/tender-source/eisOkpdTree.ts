/**
 * Коды ОКПД2 → внутренние идентификаторы справочника ЕИС.
 *
 * Выдача ЕИС фильтрует по классификатору только параметрами
 * `okpd2Ids=<id>&okpd2IdsCodes=<код>&okpd2IdsWithNested=on`, где id — номер
 * позиции во внутреннем справочнике сайта. Параметр `okpd2=41`, который адаптер
 * слал раньше, ЕИС молча игнорирует: открытых закупок Бурятии было 476 и с ним,
 * и без него, а с `okpd2Ids` разделов 41–43 — 45 (проверено 24.10.2026). Поиск
 * по ОКПД2 из профиля компании, выходит, не работал ни разу.
 *
 * Номер позиции берётся из того же справочника, которым пользуется форма поиска:
 * `/epz/api/nsi/okpd2/children.html?parentId=<id>` отдаёт детей узла. Корни
 * (разделы A–U) зашиты: их номера идут подряд и не меняются, а лишний запрос на
 * каждый прогон ради них не нужен. Дальше спуск по дереву: на каждом уровне —
 * ребёнок, чей код является началом искомого. Код «41» — один запрос, «43.21» — три.
 *
 * Модуль чистый: сеть приходит снаружи функцией `getJson`, кэш — объектом.
 */

/** Позиция справочника, найденная для кода. */
export interface EisOkpd2Ref {
  code: string;
  id: number;
}

/** Разделы ОКПД2 (буква → номер узла в справочнике ЕИС), снято со страницы формы поиска. */
export const OKPD2_SECTION_IDS: Readonly<Record<string, number>> = {
  A: 8873861, B: 8873862, C: 8873863, D: 8873864, E: 8873865, F: 8873866, G: 8873867,
  H: 8873868, I: 8873869, J: 8873870, K: 8873871, L: 8873872, M: 8873873, N: 8873874,
  O: 8873875, P: 8873876, Q: 8873877, R: 8873878, S: 8873879, T: 8873880, U: 8873881,
};

/** Классы (первые две цифры) по разделам ОКПД2 ОК 034-2014. */
const SECTION_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [1, 3, "A"], [5, 9, "B"], [10, 33, "C"], [35, 35, "D"], [36, 39, "E"], [41, 43, "F"],
  [45, 47, "G"], [49, 53, "H"], [55, 56, "I"], [58, 63, "J"], [64, 66, "K"], [68, 68, "L"],
  [69, 75, "M"], [77, 82, "N"], [84, 84, "O"], [85, 85, "P"], [86, 88, "Q"], [90, 93, "R"],
  [94, 96, "S"], [97, 98, "T"], [99, 99, "U"],
];

/** Раздел (буква) по коду ОКПД2; null — код не из классификатора. */
export function okpd2Section(code: string): string | null {
  const head = Number.parseInt(code.slice(0, 2), 10);
  if (!/^\d{2}/.test(code) || !Number.isFinite(head)) return null;
  for (const [from, to, letter] of SECTION_RANGES) {
    if (head >= from && head <= to) return letter;
  }
  return null;
}

/** Код ОКПД2 в каноническом виде («41», «43.21», «43.21.10.120»); null — не код. */
export function normalizeOkpd2Code(raw: string): string | null {
  const code = raw.trim().replace(/\s+/g, "").replace(/\.+$/, "");
  if (!/^\d{2}(?:\.\d{1,2}(?:\.\d{1,2}(?:\.\d{1,3})?)?)?$/.test(code)) return null;
  return okpd2Section(code) === null ? null : code;
}

interface TreeNode {
  code?: unknown;
  key?: unknown;
}

/** Ответ справочника → пары «код — номер»; мусор отбрасывается. */
function parseChildren(raw: unknown): EisOkpd2Ref[] {
  if (!Array.isArray(raw)) return [];
  const result: EisOkpd2Ref[] = [];
  for (const node of raw as TreeNode[]) {
    if (typeof node?.code !== "string" || typeof node.key !== "number") continue;
    result.push({ code: node.code.trim(), id: node.key });
  }
  return result;
}

/** Кэш детей узла: номер узла → дети. Живёт в адаптере, на весь прогон. */
export type Okpd2ChildrenCache = Map<number, EisOkpd2Ref[]>;

/** Глубже шести уровней в ОКПД2 нет; предел страхует от зацикливания на странном ответе. */
const MAX_DEPTH = 7;

/**
 * Номер позиции справочника ЕИС для одного кода. null — кода в справочнике нет
 * (опечатка, упразднённая позиция) или справочник не ответил по делу.
 */
export async function resolveOkpd2Id(
  code: string,
  getJson: (url: string) => Promise<unknown>,
  baseUrl: string,
  cache: Okpd2ChildrenCache = new Map(),
): Promise<EisOkpd2Ref | null> {
  const normalized = normalizeOkpd2Code(code);
  if (normalized === null) return null;
  const section = okpd2Section(normalized);
  if (section === null) return null;
  let parentId = OKPD2_SECTION_IDS[section];
  if (parentId === undefined) return null;

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    let children = cache.get(parentId);
    if (children === undefined) {
      children = parseChildren(await getJson(`${baseUrl}/epz/api/nsi/okpd2/children.html?parentId=${String(parentId)}`));
      cache.set(parentId, children);
    }
    const exact = children.find((child) => child.code === normalized);
    if (exact) return exact;
    // Ребёнок, чей код — начало искомого: «43» для «43.21», «43.2» для «43.21».
    const next = children
      .filter((child) => normalized.startsWith(child.code) && child.code.length < normalized.length)
      .sort((a, b) => b.code.length - a.code.length)[0];
    if (!next) return null;
    parentId = next.id;
  }
  return null;
}

/** Номера для списка кодов: без повторов, ненайденные пропускаются. */
export async function resolveOkpd2Ids(
  codes: readonly string[],
  getJson: (url: string) => Promise<unknown>,
  baseUrl: string,
  cache: Okpd2ChildrenCache = new Map(),
): Promise<EisOkpd2Ref[]> {
  const result: EisOkpd2Ref[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const code = normalizeOkpd2Code(raw);
    if (code === null || seen.has(code)) continue;
    seen.add(code);
    const ref = await resolveOkpd2Id(code, getJson, baseUrl, cache);
    if (ref !== null) result.push(ref);
  }
  return result;
}
