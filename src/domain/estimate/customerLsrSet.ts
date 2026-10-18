import type { CustomerNormBase } from "@/domain/estimate/customerEstimate";
import type { CustomerLsr } from "@/domain/estimate/customerLsr";

/**
 * Набор локальных смет заказчика: одна и та же смета из разных документов берётся один раз.
 *
 * Зачем. Заказчик кладёт ЛСР в документацию дважды: в «Описании объекта закупки» и в
 * «Обосновании НМЦК». На закупке 0302300048726001118 шесть смет лежат в двух архивах, и
 * смета, собранная из обеих копий, получилась бы вдвое больше заказчика. Копию узнаёт код,
 * по трём признакам сразу: номер сметы, наименование и итог («ВСЕГО по смете»). Сходится всё
 * — это одна смета, и берётся одна копия.
 *
 * Чего код не делает. Две сметы с одним номером, но разными итогами — не копии: заказчики
 * нумеруют сметы по-своему, а в архиве бывает и старая редакция рядом с новой. Выбрасывать
 * из них одну значит потерять деньги молча, поэтому берутся обе, с пометкой «номер повторяется».
 *
 * Какая копия берётся. Все копии одной сметы читаются одним разбором, и цифры у них одни;
 * отличается только документ. Берётся тот, где смета лежит как часть задания, а не как
 * приложение к расчёту цены: «Описание объекта закупки» важнее «Обоснования НМЦК»
 * (`documentRank`). Равные по весу — первый в порядке документов.
 */

/** Допуск сравнения итогов: копейка и одна миллионная итога — разница округления разных программ. */
const TOTAL_TOLERANCE = 0.01;

/** Номер сметы для сравнения: регистр, пробелы и «/» вместо «-» («02-02-05/13» и «02-02-05-13» — один номер). */
export function normalizeLsrNumber(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    .toUpperCase()
    .replace(/Ё/g, "Е")
    .replace(/[\s ]+/g, "")
    .replace(/[/\\_.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? null : cleaned;
}

/** Наименование для сравнения: без регистра и пунктуации; пустое — null. */
function normalizeTitle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * Итог сметы без НДС. У программ два порядка: у Гранд-Сметы «ВСЕГО по смете» чаще уже с НДС (итог = Σ разделов + НДС), у Smeta.RU и в части выгрузок
 * Гранд-Сметы «ВСЕГО по смете» — без НДС, а «НДС 22 %» и «Всего с НДС» стоят ниже. Вычитать НДС из итога без НДС нельзя: Smeta.RU 32616439079 при
 * «ВСЕГО по смете» 1 336 208,99 и НДС 293 965,98 давала бы 1 042 243 ₽ вместо 1 336 209 ₽ — расхождение с нашим расчётом на ровном месте.
 * Какой порядок — решает сумма НДС: она равна итогу × ставка / (100 + ставка), если итог с НДС, и итогу × ставка / 100, если без. Суммы НДС нет —
 * решает сумма разделов (итог равен ей — НДС не включён); нет и её — НДС считается включённым, как у большинства выгрузок. Ставка выведена, если суммы НДС в тексте нет.
 */
export function lsrTotalExVat(lsr: CustomerLsr): number | null {
  if (lsr.total === null) return null;
  const round = (value: number): number => Math.round(value * 100) / 100;
  const nearAmount = (left: number, right: number): boolean => Math.abs(left - right) <= Math.max(1, Math.abs(right) * 0.001);
  const percent = lsr.vatPercent;
  if (lsr.vatAmount !== null && lsr.vatAmount > 0) {
    if (percent !== null && percent > 0) {
      // Сумма НДС совпала с НДС на итог без НДС — итог НДС не содержит; на итог с НДС — содержит.
      const included = (lsr.total * percent) / (100 + percent);
      const excluded = (lsr.total * percent) / 100;
      if (!nearAmount(lsr.vatAmount, included) && nearAmount(lsr.vatAmount, excluded)) return lsr.total;
    }
    if (lsr.vatAmount < lsr.total) return round(lsr.total - lsr.vatAmount);
  }
  if (percent !== null && percent > 0) {
    if (lsr.sectionsTotal > 0 && nearAmount(lsr.total, lsr.sectionsTotal)) return lsr.total;
    return round(lsr.total / (1 + percent / 100));
  }
  return lsr.total;
}

/** Документ, который читать в первую очередь: смета как часть задания, а не как приложение к расчёту цены. */
export function documentRank(name: string): number {
  const folded = name.toLowerCase().replace(/ё/g, "е");
  if (/нмцк|обоснован|расч[её]т\s+цен|начальн\p{L}*\s+\(?максимальн/u.test(folded)) return 2;
  if (/описани\p{L}*\s+объект|техническ\p{L}*\s+задан|(?<![\p{L}\d])тз(?![\p{L}\d])|сметн\p{L}*\s+документац|локальн|лср/u.test(folded)) return 0;
  return 1;
}

export interface LsrEntry {
  /** Идентификатор внутри набора: «02-02-07», у повторяющегося номера «02-02-07#2». */
  readonly key: string;
  /** Номер сметы, как он напечатан в документе; null — номера нет. */
  readonly number: string | null;
  readonly title: string | null;
  /** Название раздела нашей сметы и строки сравнения: «ЛСР 02-02-07. Ремонтные работы …». */
  readonly sectionTitle: string;
  /** Выбранная копия: по ней строится ведомость. */
  readonly estimate: CustomerLsr;
  /** Документ, из которого взята смета. */
  readonly documentName: string;
  /** Все документы, где найдена эта смета (включая выбранный), без повторов, в порядке чтения. */
  readonly documents: readonly string[];
  /** Итог сметы заказчика с НДС («ВСЕГО по смете»). */
  readonly totalWithVat: number | null;
  /** Итог без НДС: с ним сравнивается наш расчёт. */
  readonly totalExVat: number | null;
  /** Номер повторяется у другой сметы с другим итогом — обе берутся. */
  readonly sharedNumber: boolean;
  /** Позиций верхнего уровня и подпозиций (поставки, оборудование). */
  readonly positions: number;
  readonly subPositions: number;
  /** База норм сметы, если она не ФСНБ-2022 (ТСН-2001 Москвы). Нет поля — база не чужая. */
  readonly base?: CustomerNormBase;
}

export interface LsrSet {
  readonly entries: readonly LsrEntry[];
  /** Пометки для пользователя: «найдена в 2 документах, взята из …», «номер повторяется». */
  readonly notes: readonly string[];
}

/** Название сметы одной строкой: «02-02-07. Ремонтные работы по внутренним инженерным сетям». */
function nameOf(number: string | null, title: string | null, sheet: string | null): string {
  if (title !== null && title !== "") return title.length > 160 ? `${title.slice(0, 157)}…` : title;
  if (sheet !== null) {
    // Лист называется «02-02-08  Ремонтные работы по в» — номер уже назван отдельно.
    const rest = number === null ? sheet : sheet.replace(number, "").replace(/^[\s.\-–—]+/, "");
    if (rest.trim() !== "") return rest.trim();
  }
  return "";
}

/** Заголовок раздела нашей сметы для ЛСР заказчика. Одна и та же функция строит и сравнение. */
export function lsrSectionTitle(number: string | null, title: string | null, sheet: string | null, ordinal: number): string {
  const name = nameOf(number, title, sheet);
  const label = number === null ? `ЛСР № ${String(ordinal)}` : `ЛСР ${number}`;
  return name === "" ? label : `${label}. ${name}`;
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `«${name}»`).join(", ");
}

function sameTotal(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= Math.max(TOTAL_TOLERANCE, Math.abs(left) * 1e-6);
}

/**
 * Одна ли это смета: номер, наименование и итог. Наименование сравнивается мягко — у копии
 * из обрезанного листа его может не быть или оно короче — а номер и итог обязаны совпасть.
 * Сметы без номера отличают итог и наименование.
 */
function sameEstimate(left: CustomerLsr, right: CustomerLsr): boolean {
  const leftNumber = normalizeLsrNumber(left.estimateNumber);
  const rightNumber = normalizeLsrNumber(right.estimateNumber);
  if (leftNumber !== rightNumber) return false;
  if (!sameTotal(left.total, right.total)) return false;

  const leftTitle = normalizeTitle(left.title);
  const rightTitle = normalizeTitle(right.title);
  if (leftTitle !== null && rightTitle !== null && leftTitle !== rightTitle) {
    const shorter = leftTitle.length <= rightTitle.length ? leftTitle : rightTitle;
    const longer = leftTitle.length <= rightTitle.length ? rightTitle : leftTitle;
    if (!longer.startsWith(shorter)) return false;
  }
  // Без номера и без наименования итога мало: берём ещё и число позиций.
  if (leftNumber === null && leftTitle === null && rightTitle === null) {
    return left.positions.length === right.positions.length;
  }
  return true;
}

/** Набор смет без повторов: см. шапку файла. */
export function buildLsrSet(estimates: readonly CustomerLsr[]): LsrSet {
  interface Group {
    readonly members: CustomerLsr[];
  }
  const groups: Group[] = [];
  for (const estimate of estimates) {
    const group = groups.find((candidate) => sameEstimate(candidate.members[0] as CustomerLsr, estimate));
    if (group === undefined) groups.push({ members: [estimate] });
    else group.members.push(estimate);
  }

  const numberCount = new Map<string, number>();
  for (const group of groups) {
    const number = normalizeLsrNumber((group.members[0] as CustomerLsr).estimateNumber);
    if (number !== null) numberCount.set(number, (numberCount.get(number) ?? 0) + 1);
  }

  const entries: LsrEntry[] = [];
  const notes: string[] = [];
  const seenNumber = new Map<string, number>();

  for (const [index, group] of groups.entries()) {
    // Самая весомая копия по документу; при равенстве — первая встреченная.
    let picked = group.members[0] as CustomerLsr;
    for (const member of group.members) {
      if (documentRank(member.documentName) < documentRank(picked.documentName)) picked = member;
    }

    const documents: string[] = [];
    for (const member of group.members) if (!documents.includes(member.documentName)) documents.push(member.documentName);

    const number = picked.estimateNumber ?? null;
    const normalized = normalizeLsrNumber(number);
    const ordinalOfNumber = normalized === null ? 0 : (seenNumber.get(normalized) ?? 0) + 1;
    if (normalized !== null) seenNumber.set(normalized, ordinalOfNumber);
    const shared = normalized !== null && (numberCount.get(normalized) ?? 0) > 1;

    const title = picked.title ?? null;
    const base = lsrSectionTitle(number, title, picked.estimateName, index + 1);
    // Два раздела с одним названием слиплись бы в сравнении: у второго появляется пометка варианта.
    const sectionTitle = shared && ordinalOfNumber > 1 ? `${base} (вариант ${String(ordinalOfNumber)})` : base;
    const label = number === null ? `ЛСР № ${String(index + 1)}` : `ЛСР ${number}`;

    entries.push({
      key: normalized === null ? `#${String(index + 1)}` : ordinalOfNumber > 1 ? `${normalized}#${String(ordinalOfNumber)}` : normalized,
      number,
      title,
      sectionTitle,
      estimate: picked,
      documentName: picked.documentName,
      documents,
      totalWithVat: picked.total,
      totalExVat: lsrTotalExVat(picked),
      sharedNumber: shared,
      positions: picked.positions.length,
      subPositions: picked.subPositions?.length ?? 0,
      ...(picked.base === undefined ? {} : { base: picked.base }),
    });

    if (documents.length > 1) {
      notes.push(
        `${label} найдена в ${String(documents.length)} документах (${quoted(documents)}), взята из ${quoted([picked.documentName])}`,
      );
    }
    if (shared) {
      const total = picked.total === null ? "итог не определён" : `итог ${String(Math.round(picked.total * 100) / 100).replace(".", ",")} ₽`;
      notes.push(`${label}: номер повторяется у другой сметы с другим итогом — взяты обе, эта: ${total}`);
    }
  }

  return { entries, notes };
}

/** Сведения о смете для отчёта и экрана: то же, что `LsrEntry`, без самой разобранной сметы. */
export interface LsrSourceInfo {
  readonly key: string;
  readonly number: string | null;
  readonly title: string | null;
  readonly sectionTitle: string;
  readonly documentName: string;
  readonly documents: readonly string[];
  readonly totalWithVat: number | null;
  readonly totalExVat: number | null;
  readonly sharedNumber: boolean;
  readonly positions: number;
  readonly subPositions: number;
  readonly base?: CustomerNormBase;
}

export function lsrSourceInfo(entry: LsrEntry): LsrSourceInfo {
  return {
    key: entry.key,
    number: entry.number,
    title: entry.title,
    sectionTitle: entry.sectionTitle,
    documentName: entry.documentName,
    documents: entry.documents,
    totalWithVat: entry.totalWithVat,
    totalExVat: entry.totalExVat,
    sharedNumber: entry.sharedNumber,
    positions: entry.positions,
    subPositions: entry.subPositions,
    ...(entry.base === undefined ? {} : { base: entry.base }),
  };
}
