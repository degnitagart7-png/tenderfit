/**
 * Типы справочников нормативов, перенесённых из первоисточников (приказы Минстроя России,
 * постановление Правительства РФ). Сами данные лежат в `data/fsnb/normatives/*.json` и собираются
 * скриптом `scripts/fsnb/build-normatives.ts` из текстов в `data/fsnb/normatives/sources/`.
 *
 * У каждой записи есть ссылка на источник (`source`) и фрагмент исходного текста (`fragment`),
 * по которому тест сверяет число с сохранённым текстом приказа.
 */

/** Реквизиты первоисточника: что открывали, какая редакция, где лежит сохранённый текст. */
export interface NormativeSourceInfo {
  readonly id: string;
  readonly title: string;
  readonly edition: string;
  readonly url: string;
  /** Файл с сохранённым текстом, относительно `data/fsnb/normatives/sources/`. */
  readonly file: string;
  /** Что известно о правках, не вошедших в сохранённый текст. */
  readonly notes: readonly string[];
}

/* -------------------------------- Зимнее удорожание -------------------------------- */

export type TemperatureZone = "I" | "II" | "III" | "IV" | "V" | "VI" | "VII" | "VIII";

export const TEMPERATURE_ZONES: readonly TemperatureZone[] = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/** Таблица N 1 Методики 325/пр: показатели температурных зон. */
export interface TemperatureZoneInfo {
  readonly zone: TemperatureZone;
  /** Показатель средних отрицательных температур зимнего периода, как напечатан. */
  readonly meanTemperature: string;
  /** Средний удельный вес зимнего периода в году. */
  readonly winterShare: number;
  readonly fragment: string;
}

/** Строка приложения 1 или 2 к Методике 325/пр: норматив дополнительных затрат (НДЗ) по зонам, %. */
export interface WinterNormRow {
  /** «A1-88», «A2-1.1». */
  readonly id: string;
  readonly table: "A1" | "A2";
  /** Номер пункта таблицы: «88», «1.1», «85(1)». */
  readonly item: string;
  readonly section: string;
  readonly name: string;
  /** НДЗ, %. Нет ключа зоны — в таблице прочерк (норматив не установлен). */
  readonly percent: Readonly<Partial<Record<TemperatureZone, number>>>;
  /** Числа так, как они стоят в тексте приказа (для сверки). */
  readonly fragment: string;
}

/** Часть субъекта РФ из приложения 4 Методики 325/пр. */
export interface WinterZonePart {
  /** «A4-42.3». */
  readonly id: string;
  /** Номер пункта: «42.3»; у субъекта без частей — «1». */
  readonly item: string;
  readonly subject: string;
  /** Описание территории, как в приказе; пусто — субъект целиком. */
  readonly description: string;
  readonly zone: TemperatureZone;
  /** Начало и конец расчётного зимнего периода («10.10», «25.04»). */
  readonly winterStart: string;
  readonly winterEnd: string;
  /** Коэффициент к НДЗ (графа 6). */
  readonly coefficient: number;
  /** Часть — «остальная территория»: её принимают, когда муниципалитет не назван и спорных частей нет. */
  readonly rest: boolean;
  /** Территории, названные в приказе списком (улусы, города): совпадение по названию. Пусто — части заданы линией. */
  readonly units: readonly string[];
  /** Хвост строки таблицы («V 10.10 25.04 1») для сверки. */
  readonly fragment: string;
}

export interface WinterRule {
  readonly id: string;
  readonly point: string;
  /** Правило своими словами; дословный текст — в источнике по указанному пункту. */
  readonly text: string;
  /** Короткий дословный фрагмент пункта (для сверки). */
  readonly fragment: string;
}

export interface WinterData {
  readonly source: NormativeSourceInfo;
  readonly temperatureZones: readonly TemperatureZoneInfo[];
  readonly rows: readonly WinterNormRow[];
  readonly zoneParts: readonly WinterZonePart[];
  readonly rules: readonly WinterRule[];
}

/* ------------------------------ Временные здания и сооружения ------------------------------ */

/** Строка приложения 1 или 2 к Методике 332/пр: норматив затрат, % от СМР. */
export interface TemporaryNormRow {
  /** «A1-48.1», «A2-1.1». */
  readonly id: string;
  readonly table: "A1" | "A2";
  readonly item: string;
  /** Раздел таблицы приложения 1 («Раздел 3. Объекты непроизводственного назначения»); у приложения 2 пусто. */
  readonly section: string;
  readonly name: string;
  readonly percent: number;
  readonly fragment: string;
}

export interface TemporaryData {
  readonly source: NormativeSourceInfo;
  readonly rows: readonly TemporaryNormRow[];
  readonly rules: readonly WinterRule[];
}

/* ------------------------------ Районы Крайнего Севера ------------------------------ */

export type NorthClass = "RKS" | "MPRKS";

export interface NorthEntry {
  /** «городской округ», «муниципальный район», «муниципальный округ», «город», «городское поселение», «сельское поселение», «территория». */
  readonly kind: string;
  /** Название как в перечне: «Северобайкальск», «Баунтовский эвенкийский». */
  readonly name: string;
  /** Оговорка («за исключением поселка Муртыгит»). */
  readonly note: string | null;
}

export interface NorthSubject {
  /** Название субъекта как в перечне. */
  readonly subject: string;
  /** Весь субъект относится к классу (иначе — только записи `entries`). */
  readonly whole: NorthClass | null;
  readonly rks: readonly NorthEntry[];
  readonly mprks: readonly NorthEntry[];
  readonly source: string;
  readonly fragment: string;
}

export interface NorthData {
  readonly source: NormativeSourceInfo;
  readonly subjects: readonly NorthSubject[];
}

/* ------------------------------ Условия производства работ ------------------------------ */

/** Составляющие сметной нормы, к которым применяется коэффициент (421/пр, п. 52, 53). */
export type WorkConditionComponent = "LABOUR_HOURS" | "MACHINE_HOURS" | "MACHINIST_HOURS" | "LABOUR_PAY" | "MACHINIST_PAY";

export type WorkPhase = "CONSTRUCTION" | "RECONSTRUCTION" | "CAPITAL_REPAIR" | "COMMISSIONING" | "HERITAGE";

/** Таблицы 1, 3, 5, 7 — снижение производительности труда; 2, 4, 6, 8 — повышенный размер оплаты труда. */
export type WorkConditionKind = "PRODUCTIVITY" | "WAGE";

/** К какой части работ относится условие. */
export type WorkConditionScope = "ALL" | "ROOF" | "PUBLIC_AREA";

export interface WorkCondition {
  /** «T5-8». */
  readonly id: string;
  readonly table: number;
  /** Пункт таблицы: «8», «9.1». */
  readonly item: string;
  readonly phase: WorkPhase;
  readonly kind: WorkConditionKind;
  /** Условие производства работ, дословно. */
  readonly text: string;
  /**
   * Коэффициенты по видам норм: gesn — ГЭСН (кроме 81-02-46), gesnm — ГЭСНм, gesnr — ГЭСНр и ГЭСН 81-02-46,
   * gesnp — ГЭСНп (таблицы 7, 8). null — в таблице прочерк (условие к таким нормам не применяется).
   */
  readonly coefficients: Readonly<Partial<Record<"gesn" | "gesnm" | "gesnr" | "gesnp", number | null>>>;
  readonly appliesTo: readonly WorkConditionComponent[];
  readonly scope: WorkConditionScope;
  /** Условия одной группы взаимно исключают друг друга (подпункты одного пункта). */
  readonly exclusiveGroup: string | null;
  /** Коэффициент не распространяется на работы в помещениях (п. 52 Методики). */
  readonly notForInterior: boolean;
  /** Условие в короткой подписи для интерфейса. */
  readonly label: string;
  /** Входит в короткий список частых условий. */
  readonly frequent: boolean;
  /** Выражения (RegExp, флаги iu) для подсказки по тексту документации. */
  readonly hints: readonly string[];
  /** «Приложение 10 к 421/пр, таблица 5, п. 8». */
  readonly source: string;
  /** Дословный фрагмент текста условия (для сверки; допускает вставки чисел таблицы). */
  readonly textFragment: string;
  /** Строка коэффициентов как в тексте. */
  readonly valueFragment: string;
}

export interface WorkConditionTable {
  readonly number: number;
  readonly phase: WorkPhase;
  readonly kind: WorkConditionKind;
  readonly title: string;
}

/**
 * Множители к нормативам накладных расходов и сметной прибыли (812/пр п. 25 и 27, 774/пр п. 16).
 * `textVerified: false` — текст пункта в сохранённых источниках отсутствует, значение принято по сметам заказчиков.
 */
export interface OverheadMultiplier {
  readonly id: string;
  readonly normative: "OVERHEAD" | "PROFIT";
  readonly sourceId: string;
  /** «812/пр», «774/пр»: так заказчик называет приказ в обосновании позиции. */
  readonly order: string;
  readonly point: string;
  readonly value: number;
  /** «P58» — применим вместе с п. 58 Методики 421/пр; «SPECIAL_OBJECT» — только для особо опасных и технически сложных объектов. */
  readonly requires: "P58" | "SPECIAL_OBJECT";
  readonly applicability: string;
  readonly fragment: string | null;
  readonly textVerified: boolean;
}

/** Случай, когда множитель не применяется (п. 26 812/пр). */
export interface OverheadMultiplierExclusion {
  readonly id: string;
  readonly multiplierIds: readonly string[];
  readonly point: string;
  readonly text: string;
  readonly fragment: string;
  /** Коды сборников ГЭСН, на которые исключение распространяется. */
  readonly collections: readonly string[];
  /** Проверяется ли исключение по данным позиции (иначе — только напоминание о том, что проверить по объекту). */
  readonly checkable: boolean;
}

/**
 * Другая запись той же строки таблицы: как на неё ссылаются заказчики («648/пр_2022_п.145_т.3_стр.4» — таблица 3 п. 145 методики по ФЕР
 * повторяет таблицу 3 п. 84 Методики 571/пр). Значение берётся из основной записи; подпись строки сверена по тексту приказа-алиаса.
 */
export interface EquipmentDemolitionAlias {
  readonly sourceId: string;
  readonly order: string;
  readonly point: string;
  readonly table: number;
  readonly row: number;
  /** Фрагменты подписи строки, дословно лежащие в сохранённом тексте приказа-алиаса. */
  readonly fragments: readonly string[];
}

/**
 * Коэффициенты на разборку и демонтаж (Методика применения сметных норм 571/пр): таблица 2 п. 83 — строительные конструкции, системы и
 * сети (нормы ГЭСН), таблица 3 п. 84 — оборудование (нормы ГЭСНм). К труду рабочих, времени машин и труду машинистов; материалы не
 * учитываются.
 */
export interface EquipmentDemolition {
  readonly id: string;
  readonly sourceId: string;
  readonly order: string;
  readonly point: string;
  readonly table: number;
  readonly row: number;
  /** Что разбирается: строительные конструкции, системы и сети (таблица 2) или оборудование (таблица 3). */
  readonly scope: "CONSTRUCTION" | "EQUIPMENT";
  readonly books: readonly string[];
  readonly title: string;
  readonly labour: number;
  readonly machines: number;
  readonly materials: number;
  readonly applicability: string;
  readonly fragments: readonly string[];
  /** Ссылки на ту же строку по другим приказам (648/пр п. 145 для таблицы 3); нет поля или пусто — только основная. */
  readonly aliases?: readonly EquipmentDemolitionAlias[];
  /** Значение коэффициента сверено с текстом приказа; false — числа таблицы в сохранённом тексте не читаются. */
  readonly valueVerified: boolean;
  /** Подпись строки и порядок применения сверены с текстом. */
  readonly textVerified: boolean;
}

export interface EquipmentDemolitionData {
  readonly sources: readonly NormativeSourceInfo[];
  readonly equipmentDemolition: readonly EquipmentDemolition[];
  readonly unavailable: readonly { readonly ref: string; readonly reason: string }[];
}

export interface OverheadMultipliersData {
  readonly sources: readonly NormativeSourceInfo[];
  readonly multipliers: readonly OverheadMultiplier[];
  readonly exclusions: readonly OverheadMultiplierExclusion[];
  readonly notFound: readonly string[];
}

export interface WorkConditionsData {
  readonly source: NormativeSourceInfo;
  readonly tables: readonly WorkConditionTable[];
  readonly conditions: readonly WorkCondition[];
  /** Правила применения и сочетания (п. 52-61 Методики). */
  readonly rules: readonly WinterRule[];
  /** Дополнительные коэффициенты вне приложения 10 (п. 58 Методики). */
  readonly adjustments: readonly WorkAdjustment[];
  /** Что просили, но в приложении 10 нет. */
  readonly notInAppendix: readonly string[];
}

/** Коэффициенты п. 58 Методики 421/пр: ремонт/реконструкция по нормам нового строительства. */
export interface WorkAdjustment {
  readonly id: string;
  readonly point: string;
  readonly label: string;
  readonly labour: number;
  readonly machines: number;
  readonly text: string;
  readonly fragment: string;
}
