import type { OverheadRate } from "@/domain/estimate/types";

/**
 * Нормативы накладных расходов и сметной прибыли из приказов Минстроя.
 *
 * Зачем это отдельный модуль. НР и СП считаются от фонда оплаты труда и входят
 * в стоимость СМР: на живом прогоне они дали 59,6 % всей необъяснённой
 * стоимости — не потому, что расчёт ошибался, а потому, что справочника не
 * было и каждая позиция падала на резервный процент документа. Нормативы
 * привязаны к виду работ: земляные работы механизированным способом — 92 %,
 * свайные — 117 %, и единый процент на смету не приближение, а другая цифра.
 *
 * Откуда данные. Приказ Минстроя от 21.12.2020 № 812/пр (накладные расходы) и
 * от 11.12.2020 № 774/пр (сметная прибыль), приложения «Нормативы … по видам
 * работ». Обе таблицы существуют только в PDF, поэтому разбор идёт по сетке
 * координат (`src/lib/pdf`), а этот модуль превращает строки сетки в нормативы.
 * Разбор отделён от чтения файла: сетку можно подать из теста и проверить
 * поведение на настоящих строках приказа, не таща в тест PDF на 700 КБ.
 *
 * Как норматив находит расценку. В данных ФСНБ каждая норма несёт указатели
 * `Nr` и `Sp` вида `Пр/812-001.1` и `Пр/774-001.1` — это номер пункта таблицы
 * приказа, где «001.1» соответствует пункту 1.1, а пункт без подпунктов
 * записывается как «002.0». Ключ собирается по этому правилу, и полнота
 * проверяется сверкой со всеми указателями выгрузки: их 125 у каждого приказа.
 *
 * Про зоны. У накладных расходов три значения: обычная территория, местности,
 * приравненные к районам Крайнего Севера (МПРКС), и сами районы Крайнего
 * Севера (РКС) — порядок колонок проверен по координатам, значения возрастают
 * в этом порядке. У сметной прибыли одно значение на все зоны. Выбор зоны —
 * решение вызывающего кода: объект в Якутии и объект в Воронеже считаются по
 * разным колонкам, и молча взять первую значило бы занизить смету северной
 * стройки.
 */

/** Какой из двух приказов разбирается. */
export type NormativeKind = "OVERHEAD" | "PROFIT";

/**
 * Зона по районированию Крайнего Севера.
 *
 * `TERRITORY` — обычная территория страны, `MPRKS` — местности, приравненные к
 * районам Крайнего Севера, `RKS` — районы Крайнего Севера.
 */
export type NorthZone = "TERRITORY" | "MPRKS" | "RKS";

/** Один пункт таблицы приказа. */
export interface OverheadNormative {
  /** Указатель для сверки с нормой ФСНБ, например «Пр/812-001.1». */
  readonly ref: string;
  /** Номер пункта, как он напечатан в приказе: «1.1», «2». */
  readonly item: string;
  /** Раздел таблицы: «Строительные работы», «Монтажные работы» и далее. */
  readonly section: string;
  /** Вид работ вместе с названием родительского пункта. */
  readonly workType: string;
  /** Норматив для обычной территории, % от ФОТ. */
  readonly territory: number;
  /** Норматив для МПРКС; у сметной прибыли зон нет, поэтому null. */
  readonly mprks: number | null;
  /** Норматив для РКС; у сметной прибыли зон нет, поэтому null. */
  readonly rks: number | null;
}

/** Реквизиты приказа — печатаются в смете рядом с начислением. */
export const NORMATIVE_SOURCES = {
  OVERHEAD: "Приказ Минстроя России от 21.12.2020 № 812/пр, приложение",
  PROFIT: "Приказ Минстроя России от 11.12.2020 № 774/пр, приложение",
} as const satisfies Record<NormativeKind, string>;

const REF_PREFIX = {
  OVERHEAD: "Пр/812",
  PROFIT: "Пр/774",
} as const satisfies Record<NormativeKind, string>;

/** Номер пункта: «1» или «1.1». Римские цифры — это заголовок раздела. */
const ITEM_NUMBER = /^(\d{1,3})(?:\.(\d{1,2}))?$/;
const SECTION_NUMBER = /^[IVX]+$/;

/*
  Норматив — двузначное или трёхзначное число.

  Однозначные отброшены намеренно: строка нумерации колонок «1 | 2 | 3 4 5 | 6»
  выглядит как пункт 1 с нормативами 3, 4 и 5, и без этого условия попадала бы
  в справочник первой же записью. Настоящих нормативов ниже 40 % в обоих
  приказах нет.
*/
const PERCENT = /^\d{2,3}$/;

/**
 * Битые ячейки номера в текстовом слое приказа.
 *
 * В 812/пр у пункта 72 «Оборудование зернохранилищ и предприятий по переработке
 * зерна» в колонке номера вместо цифр стоит «ты»: текстовый слой на этой ячейке
 * испорчен, хотя сама строка с нормативами 89/90/93 и ссылкой на сборник
 * ГЭСНм 81-03-30 читается верно. Пункт стоит между 71 и 73, так что номер
 * восстанавливается однозначно.
 *
 * Список закрытый и держится ровно на одном случае. Угадывать номер по позиции
 * строки нельзя: страница, где номера поехали на два пункта, так превратилась
 * бы в тихо неверный справочник. Поэтому починка — явная, названная и
 * проверяемая: сверка со указателями ФСНБ падает, если пункт снова потерялся.
 */
const BROKEN_ITEM_CELLS: ReadonlyMap<string, string> = new Map([["ты", "72"]]);

/** Строка сетки: четыре ячейки — номер, вид работ, нормативы, сборники. */
export type NormativeGridRow = readonly string[];

/**
 * Срезает шапку страницы, оставляя только строки таблицы.
 *
 * Шапка мешает трижды. Номер страницы печатается по центру и попадает в колонку
 * нормативов, где двузначный номер неотличим от норматива: страница 18
 * выглядит как «18 %». Подписи колонок («Нормативы накладных расходов к ФОТ
 * рабочих», «Наименование сборников») лежат в тех же колонках, что названия
 * видов работ, и приклеиваются к ним. А строка нумерации колонок «1 | 2 | 3 4 5
 * | 6» выглядит как пункт 1, у которого нормативы ещё не напечатаны, — и
 * забирает себе чужие числа.
 *
 * Резать по признакам каждой из этих строк значило бы держать список подписей и
 * обновлять его при каждой правке приказа. Поэтому граница берётся одна и
 * надёжная: строка нумерации колонок есть на каждой странице приложения и
 * всегда последняя в шапке. Всё до неё — оформление, всё после — данные.
 */
export function withoutTableHeader(
  rows: readonly NormativeGridRow[],
): NormativeGridRow[] {
  const at = rows.findIndex(isColumnNumbering);
  return at < 0 ? [...rows] : rows.slice(at + 1);
}

/** Строка нумерации колонок: подряд идущие числа с единицы, и ничего больше. */
function isColumnNumbering(row: NormativeGridRow): boolean {
  const tokens = row
    .join(" ")
    .split(/\s+/)
    .filter((token) => token !== "");
  if (tokens.length < 3) return false;
  return tokens.every((token, index) => token === String(index + 1));
}

interface Cells {
  readonly number: string;
  readonly workType: string;
  readonly percents: readonly number[];
}

function cells(row: NormativeGridRow): Cells {
  const percents = (row[2] ?? "")
    .split(/\s+/)
    .filter((token) => PERCENT.test(token))
    .map((token) => Number.parseInt(token, 10));

  const raw = (row[0] ?? "").trim();
  // Починка применяется только к строке с нормативами: в пустой ячейке чинить
  // нечего, а вне таблицы те же символы могут быть обычным текстом.
  const repaired =
    percents.length > 0 ? (BROKEN_ITEM_CELLS.get(raw) ?? raw) : raw;

  return {
    number: repaired,
    workType: (row[1] ?? "").trim(),
    percents,
  };
}

/** «1.1» → «001.1», «2» → «002.0»: как указатель записан в данных ФСНБ. */
export function normativeRef(kind: NormativeKind, item: string): string {
  const match = ITEM_NUMBER.exec(item);
  if (match === null) {
    throw new Error(`Не номер пункта приказа: «${item}».`);
  }
  const major = (match[1] ?? "").padStart(3, "0");
  const minor = match[2] ?? "0";
  return `${REF_PREFIX[kind]}-${major}.${minor}`;
}

/**
 * Разбирает строки сетки приложения в нормативы.
 *
 * Строки подаются подряд, как они идут в документе: разбор опирается на
 * порядок. Шапки, колонтитулы и повторяющиеся заголовки страниц пропускаются
 * сами — строка становится нормативом только когда у неё есть и номер пункта,
 * и нормативы.
 */
export function parseNormativeGrid(
  rows: readonly NormativeGridRow[],
  kind: NormativeKind,
): OverheadNormative[] {
  const parsed = rows.map(cells);

  /*
    Название вида работ в приказе разорвано по строкам, а номер пункта стоит
    по центру этих строк — то есть между обрывками названия. Поэтому сначала
    находятся строки с номерами, а обрывки названия прикрепляются к ближайшей
    из них по расстоянию в строках. Собрать название одной склейкой подряд
    нельзя: «с применением средств» стоит выше номера 1.3, а «гидромеханизации»
    ниже, и однонаправленный разбор потеряет половину.
  */
  const numbered: number[] = [];
  for (const [index, row] of parsed.entries()) {
    if (ITEM_NUMBER.test(row.number)) numbered.push(index);
  }

  const fragments = new Map<number, { index: number; text: string }[]>();
  for (const [index, row] of parsed.entries()) {
    if (row.workType === "") continue;
    if (ITEM_NUMBER.test(row.number) || SECTION_NUMBER.test(row.number)) {
      continue;
    }
    if (row.percents.length > 0) continue;

    let nearest: number | null = null;
    for (const candidate of numbered) {
      if (
        nearest === null ||
        Math.abs(candidate - index) < Math.abs(nearest - index)
      ) {
        nearest = candidate;
      }
    }
    if (nearest === null) continue;
    const list = fragments.get(nearest) ?? [];
    list.push({ index, text: row.workType });
    fragments.set(nearest, list);
  }

  /*
    Тот же разрыв бывает и с самими нормативами, причём в двух видах.

    Первый: у пункта 104 «Капитальный ремонт и модернизация оборудования
    лифтов» числа напечатаны выше строки с номером, и без этого прохода пункт
    терялся целиком — а вместе с ним все расценки капремонта лифтов уезжали на
    резервный процент.

    Второй: у того же пункта 104 нормативов два — 89/90/93 и 74/75/78, — а
    напечатанный номер один: различаются они колонкой сборников («за
    исключением отделов 5 и 6» против самих этих отделов). В данных ФСНБ такой
    пункт разложен на указатели 104.1 и 104.2, поэтому несколько наборов чисел
    у одного номера нумеруются по порядку появления.

    Ограничение по расстоянию обязательно. Без него осиротевшие числа цеплялись
    к пункту через пол-документа: так пункт 100, у которого есть напечатанные
    подпункты 100.1 и 100.2, получал ещё и собственный норматив из чужой
    страницы.
  */
  const MAX_ROW_DISTANCE = 5;
  const attachedPercents = new Map<number, readonly number[][]>();
  for (const [index, row] of parsed.entries()) {
    if (row.percents.length === 0) continue;
    if (ITEM_NUMBER.test(row.number) || SECTION_NUMBER.test(row.number))
      continue;

    let nearest: number | null = null;
    for (const candidate of numbered) {
      if ((parsed[candidate]?.percents.length ?? 0) > 0) continue;
      const distance = Math.abs(candidate - index);
      if (distance > MAX_ROW_DISTANCE) continue;
      if (nearest === null || distance < Math.abs(nearest - index)) {
        nearest = candidate;
      }
    }
    if (nearest === null) continue;
    attachedPercents.set(nearest, [
      ...(attachedPercents.get(nearest) ?? []),
      [...row.percents],
    ]);
  }

  const nameOf = (index: number): string => {
    const own = parsed[index];
    const parts = [...(fragments.get(index) ?? [])];
    if (own !== undefined && own.workType !== "") {
      parts.push({ index, text: own.workType });
    }
    return parts
      .sort((left, right) => left.index - right.index)
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const out: OverheadNormative[] = [];
  let section = "";
  const parentNames = new Map<string, string>();

  for (const [index, row] of parsed.entries()) {
    if (SECTION_NUMBER.test(row.number) && row.workType !== "") {
      section = row.workType;
      continue;
    }

    const match = ITEM_NUMBER.exec(row.number);
    if (match === null) continue;

    const major = match[1] ?? "";
    const minor = match[2];
    const name = nameOf(index);

    // Пункт без подпунктов — ещё и заголовок для своих подпунктов.
    if (minor === undefined) parentNames.set(major, name);

    const sets =
      row.percents.length > 0
        ? [row.percents]
        : (attachedPercents.get(index) ?? []);
    if (sets.length === 0) continue;

    const parent = minor === undefined ? "" : (parentNames.get(major) ?? "");
    const workType = [parent, name].filter((part) => part !== "").join(" ");

    for (const [order, percents] of sets.entries()) {
      const [first, second, third] = percents;
      if (first === undefined) continue;

      // Один набор — номер как напечатан; несколько — подпункты по порядку.
      const item =
        sets.length === 1 ? row.number : `${major}.${String(order + 1)}`;

      out.push({
        ref: normativeRef(kind, item),
        item,
        section,
        workType,
        territory: first,
        mprks: kind === "OVERHEAD" ? (second ?? null) : null,
        rks: kind === "OVERHEAD" ? (third ?? null) : null,
      });
    }
  }

  return out;
}

/**
 * Собирает карту для ценовой книги расчёта.
 *
 * Зона выбирает колонку накладных расходов. Если норматив зоны в приказе не
 * напечатан, берётся значение обычной территории: пропуск встречается у
 * пунктов, где северных нормативов нет вовсе, и подставлять туда ноль значило
 * бы обнулить начисление.
 */
export function buildOverheadRateMap(
  normatives: readonly OverheadNormative[],
  kind: NormativeKind,
  zone: NorthZone = "TERRITORY",
): ReadonlyMap<string, OverheadRate> {
  const map = new Map<string, OverheadRate>();

  for (const item of normatives) {
    const percent =
      zone === "RKS"
        ? (item.rks ?? item.territory)
        : zone === "MPRKS"
          ? (item.mprks ?? item.territory)
          : item.territory;

    map.set(item.ref, {
      ref: item.ref,
      percent,
      workType: item.workType,
      source: `${NORMATIVE_SOURCES[kind]}, пункт ${item.item}`,
    });
  }

  return map;
}

/*
  Указатели НР и СП у норм сборника 10 «Оборудование связи» (ГЭСНм 81-03-10).

  В выгрузке ФСНБ-2022 у всех 1 605 норм этого сборника стоит один и тот же указатель «Пр/812-052.0» и «Пр/774-052.0». Пункт 52 приказов
  812/пр и 774/пр — «Устройство средств посадки самолетов и систем управления воздушным движением на аэродромах» (96 % и 48 %), а оборудование связи
  — пункт 51 (за исключением пункта 52), разбитый по отделам сборника:
    51.1 прокладка и монтаж сетей связи — отделы 1–3, отдел 6 разделы 2, 3, 4, 5, отделы 8, 9, 10 (90 % и 46 %);
    51.2 радиотелевизионное и электронное оборудование — отделы 4 и 5 (95 % и 53 %);
    51.4 сигнализация, централизация, блокировка и связь на железных дорогах — отдел 7 (94 % и 45 %).
  Заказчик в ЛСР закупки 0302300048726001118 берёт именно эти пункты (Пр/812-051.1-1 для 10-01-053-01, 051.2 для 10-04-101-05), и по тексту
  812/пр прав он: расценка кабеля «10-01-053-01» — отдел 1, а не аэродромные системы. Отдел 6 в пункты 51.1 и 51.3 входит по разделам, которые по
  коду таблицы не определить, поэтому он остаётся с указателем выгрузки.
*/
const COMMS_POINTER_BY_DEPARTMENT: ReadonlyMap<string, string> = new Map([
  ["01", "051.1"],
  ["02", "051.1"],
  ["03", "051.1"],
  ["04", "051.2"],
  ["05", "051.2"],
  ["07", "051.4"],
  ["08", "051.1"],
  ["09", "051.1"],
  ["10", "051.1"],
]);

/** Указатели нормы после исправления пункта 51/52 для сборника 10; остальные нормы — как в выгрузке. */
export function correctedRatePointers(norm: {
  readonly baseType: string;
  readonly tableCode: string;
  readonly overheadRef: string | null;
  readonly profitRef: string | null;
}): { readonly overheadRef: string | null; readonly profitRef: string | null } {
  if (norm.baseType !== "ГЭСНм" || norm.overheadRef !== "Пр/812-052.0") return { overheadRef: norm.overheadRef, profitRef: norm.profitRef };
  const match = /^10-(\d{2})-/u.exec(norm.tableCode);
  const pointer = match === null ? undefined : COMMS_POINTER_BY_DEPARTMENT.get(match[1] as string);
  if (pointer === undefined) return { overheadRef: norm.overheadRef, profitRef: norm.profitRef };
  return {
    overheadRef: `Пр/812-${pointer}`,
    profitRef: norm.profitRef === "Пр/774-052.0" ? `Пр/774-${pointer}` : norm.profitRef,
  };
}
