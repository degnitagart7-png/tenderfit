import type { CustomerBim } from "@/domain/estimate/customerBim";
import type { DocumentText } from "@/domain/estimate/customerEstimate";
import type { EstimateDocument, EstimateMethod, EstimateMethodBasis } from "@/domain/estimate/types";

/**
 * Каким методом считает заказчик: ресурсно-индексным (ФСНБ-2022, форма 421/пр) или базисно-индексным (расценки
 * ФЕР/ТЕР-2001 с индексами Минстроя). От этого зависит, как считать нашу смету, чтобы её можно было сравнить с его.
 *
 * Сигналы, от сильного к слабому:
 *  1. смета заказчика, которую разобрал `parseCustomerBim`: расценки ФЕР/ТЕР и (или) индексы — это БИМ, и ничего иного.
 *     Исключение: разобрана и ресурсно-индексная ЛСР формы 421/пр (`rimLsrCount`) — признаки противоречат друг другу, и берётся
 *     ресурсно-индексный (БИМ-смета при этом может оказаться нормативным приложением);
 *  2. в шапке сметы («Составлен базисно-индексным / ресурсно-индексным методом») — явное слово шапки важнее любых слов в тексте;
 *  3. в тексте документации (задание, контракт, пояснительная записка) названо «базисно-индексный метод» или
 *     «ресурсно-индексный метод»; названы оба — берётся тот, что назван чаще, при равенстве — метод не определён.
 *     Разобрана ресурсная ЛСР 421/пр — слова вне шапки метод не меняют: смета заказчика называет метод сама;
 *  4. в тексте стоят шифры расценок ФЕР/ТЕР («ФЕР 01-01-001-01», «ТЕР-2001») без слов о ресурсном методе.
 *
 * Ничего не сказано — метод не определён (`method: null`), и считается ресурсно-индексный, как раньше. Определять метод
 * по наименованию работ или региону нельзя: смета на ФЕР и смета на ГЭСН по виду работ неотличимы.
 */

export interface MethodDetection {
  /** Метод заказчика; null — документация о нём молчит. */
  readonly method: EstimateMethod | null;
  /** База расценок заказчика при БИМ: ФЕР или ТЕР региона (по преобладанию шифров). */
  readonly customerBase: "FER" | "TER";
  /** Что именно сказало о методе: одной фразой, для карточки и отчёта. */
  readonly note: string;
}

/** Окончательный выбор: пользователь, заказчик или умолчание. */
export interface MethodChoice {
  readonly method: EstimateMethod;
  readonly basis: EstimateMethodBasis;
  readonly note: string;
  readonly customerBase: "FER" | "TER";
}

/** Тексты бывают в мегабайты; признаки метода стоят в тексте не глубже этого. */
const MAX_TEXT = 2_000_000;

const BIM_WORDS = /базисно[\s-]*индексн/giu;
const RIM_WORDS = /ресурсно[\s-]*индексн/giu;
/** Фраза шапки ЛСР: «Составлен базисно-индексным методом»; в CSV слова разнесены по ячейкам: «Составлен ,ресурсно-индексным,методом». */
const HEADER_BIM = /Составлен[а-яё()]*[\s,;:"]*базисно[\s-]*индексн[а-яё]*[\s,;:"]*метод/giu;
const HEADER_RIM = /Составлен[а-яё()]*[\s,;:"]*ресурсно[\s-]*индексн[а-яё]*[\s,;:"]*метод/giu;
/** Шифр расценки: «ФЕР 01-01-001-01», «ФЕРм12-12-001-13», «ТЕР-2001», «ТЕР 06-01-001-01». */
const FER_CODE = /(?<![\p{L}\d])ФЕР(?:мр|м|р|п)?[\s-]*(?:\d{2}-\d{2}-\d{3}-\d{2}|2001|2020)(?!\d)/giu;
const TER_CODE = /(?<![\p{L}\d])ТЕР(?:мр|м|р|п)?[\s-]*(?:\d{2}-\d{2}-\d{3}-\d{2}|2001)(?!\d)/giu;
const TER_WORDS = /территориальн[а-я]+\s+единичн[а-я]+\s+расценк|территориальн[а-я]+\s+сметн[а-я]+\s+нормативн/giu;

function count(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  let found = 0;
  while (pattern.exec(text) !== null) {
    found += 1;
    if (found > 1000) break;
  }
  pattern.lastIndex = 0;
  return found;
}

function baseOfEstimates(estimates: readonly CustomerBim[]): "FER" | "TER" {
  let fer = 0;
  let ter = 0;
  for (const estimate of estimates) {
    for (const position of estimate.positions) {
      if (position.family === "FER") fer += 1;
      else if (position.family === "TER") ter += 1;
    }
  }
  return ter > fer ? "TER" : "FER";
}

export interface MethodContext {
  /** Сколько ресурсно-индексных ЛСР формы 421/пр разобрал `parseCustomerLsr`. */
  readonly rimLsrCount?: number;
}

/** Документ — обоснование НМЦК (по имени или заголовку в начале текста). */
export function isNmckJustification(document: { readonly name: string; readonly text: string }): boolean {
  if (/обосновани|нмц[кд]?|начальн\S*\s+\(?максимальн/iu.test(document.name)) return true;
  return /обосновани\S*\s+(?:начальной|нмц)/iu.test(document.text.slice(0, 3000));
}

export function detectCustomerMethod(
  documents: readonly DocumentText[],
  bimEstimates: readonly CustomerBim[] = [],
  context: MethodContext = {},
): MethodDetection {
  const rimLsrCount = context.rimLsrCount ?? 0;
  if (bimEstimates.length > 0 && rimLsrCount === 0) {
    const base = baseOfEstimates(bimEstimates);
    const first = bimEstimates[0] as CustomerBim;
    const name = first.estimateName ?? first.number ?? first.documentName;
    return {
      method: "BASE_INDEX",
      customerBase: base,
      note: `смета заказчика «${name}» составлена на расценках ${base === "TER" ? "ТЕР-2001 региона" : "ФЕР-2001"} с индексами`,
    };
  }

  let bimWords = 0;
  let rimWords = 0;
  let bimHeader = 0;
  let rimHeader = 0;
  let fer = 0;
  let ter = 0;
  let terWords = 0;
  for (const document of documents) {
    const text = document.text.length > MAX_TEXT ? document.text.slice(0, MAX_TEXT) : document.text;
    /*
      Обоснование НМЦК описывает, как заказчик считал начальную цену, и часто расходится с самой сметой: в закупке
      0134600008526000372 обоснование говорит «по ТЕР … базисно-индексным методом», а приложенная ЛСР составлена
      ресурсно-индексным. На слепой проверке (смета скрыта) это одно упоминание увело расчёт в БИМ. Слова метода в обосновании
      НМЦК не считаются; требование в ТЗ или договоре («смета составляется базисно-индексным методом») — считается.
    */
    const nmck = isNmckJustification(document);
    if (!nmck) {
      bimWords += count(BIM_WORDS, text);
      rimWords += count(RIM_WORDS, text);
    }
    bimHeader += count(HEADER_BIM, text);
    rimHeader += count(HEADER_RIM, text);
    fer += count(FER_CODE, text);
    ter += count(TER_CODE, text);
    terWords += count(TER_WORDS, text);
  }
  const customerBase: "FER" | "TER" = bimEstimates.length > 0 ? baseOfEstimates(bimEstimates) : ter + terWords > fer ? "TER" : "FER";

  // Разобрана ресурсная ЛСР 421/пр: БИМ-признаки (шифры ФЕР в тексте, слова в договоре) с ней спорят, и верх берёт ресурсный метод.
  if (rimLsrCount > 0 && bimHeader <= rimHeader) {
    return { method: "RESOURCE_INDEX", customerBase, note: "смета заказчика составлена ресурсно-индексным методом (форма 421/пр, шифры ГЭСН/ФСБЦ)" };
  }
  // Явный метод шапки сметы важнее любых слов в тексте.
  if (bimHeader !== rimHeader) {
    return bimHeader > rimHeader
      ? { method: "BASE_INDEX", customerBase, note: "в шапке сметы заказчика назван базисно-индексный метод" }
      : { method: "RESOURCE_INDEX", customerBase, note: "в шапке сметы заказчика назван ресурсно-индексный метод" };
  }

  if (bimWords > 0 && bimWords >= rimWords) {
    return { method: "BASE_INDEX", customerBase, note: "в документации назван базисно-индексный метод" };
  }
  if (rimWords > 0) {
    return { method: "RESOURCE_INDEX", customerBase, note: "в документации назван ресурсно-индексный метод" };
  }
  // Шифры ФЕР/ТЕР у строк ведомости — сам заказчик считает по базе 2001 года: это признак метода, в отличие от слов в тексте.
  if (fer + ter > 0) {
    return { method: "BASE_INDEX", customerBase, note: `в документации названы расценки ${ter > fer ? "ТЕР" : "ФЕР"}-2001` };
  }
  return { method: null, customerBase, note: "документация о методе заказчика не говорит" };
}

/**
 * Какой метод считать. Выбор пользователя («как у заказчика» = не выбирал) важнее всего; без него — метод заказчика;
 * молчит заказчик — ресурсно-индексный, как до появления БИМ.
 */
export function chooseMethod(selected: EstimateMethod | null | undefined, detection: MethodDetection): MethodChoice {
  if (selected === "RESOURCE_INDEX" || selected === "BASE_INDEX") {
    return { method: selected, basis: "USER", note: "метод выбран вручную", customerBase: detection.customerBase };
  }
  if (detection.method !== null) {
    return { method: detection.method, basis: "CUSTOMER", note: detection.note, customerBase: detection.customerBase };
  }
  return { method: "RESOURCE_INDEX", basis: "DEFAULT", note: detection.note, customerBase: detection.customerBase };
}

export const METHOD_LABEL: Readonly<Record<EstimateMethod, string>> = {
  RESOURCE_INDEX: "ресурсно-индексный",
  BASE_INDEX: "базисно-индексный (ФЕР-2001 × индексы)",
};

/** Оговорка про ТЕР региона дословно: её же ждёт и смета-образец, и пользователь. */
export function terAsFerNote(subject: string | null): string {
  return `ТЕР ${subject ?? "региона"} недоступны в открытых данных — посчитано по ФЕР с индексами к ФЕР; возможна разница`;
}

const BASIS_TEXT: Readonly<Record<EstimateMethodBasis, string>> = {
  USER: "выбран вручную",
  CUSTOMER: "как у заказчика",
  DEFAULT: "по умолчанию",
};

const fmtIndex = (value: number): string => value.toFixed(2).replace(".", ",");

/**
 * Метод расчёта словами для экрана и Word: заголовок «Метод: …» и строки о том, чем считали. Одни и те же слова в обоих местах.
 * У сметы без сведений о методе (старые расчёты) — ресурсно-индексный без пояснений.
 */
export function describeEstimateMethod(document: Pick<EstimateDocument, "method" | "bim">): { readonly title: string; readonly lines: readonly string[] } {
  const label = METHOD_LABEL[document.method];
  const bim = document.bim;
  if (document.method !== "BASE_INDEX" || bim === undefined) {
    return { title: `Метод: ${label}`, lines: [] };
  }
  const where = `${bim.subject ?? "субъект не определён"}${bim.zone === null ? "" : `, ${String(bim.zone)} зона`}`;
  const lines = [
    `Расценки ФЕР-2020 в уровне цен 01.01.2000 × индексы Минстроя на ${bim.quarter} для ${where}, «${bim.object}»${bim.objectDetected ? "" : " (объект строительства определить однозначно не удалось)"}: ` +
      `ОЗП ${fmtIndex(bim.indexLabour)}, ЭМ ${fmtIndex(bim.indexMachines)}, материалы ${fmtIndex(bim.indexMaterials)}; ${bim.letter}`,
    "НР и СП — по приказам 812/пр и 774/пр от фонда оплаты труда в текущих ценах; ССР считается поверх сметы.",
  ];
  if (bim.customerBase === "TER") lines.push(terAsFerNote(bim.subject));
  return { title: `Метод: ${label} — ${BASIS_TEXT[bim.basis]}${bim.basis === "CUSTOMER" ? ` (${bim.basisNote})` : ""}`, lines };
}
