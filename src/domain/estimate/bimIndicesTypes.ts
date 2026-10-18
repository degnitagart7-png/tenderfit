/**
 * Индексы пересчёта из базисного уровня цен 2001 года в текущий (метод БИМ): типы данных справочника.
 *
 * Источник — письма Минстроя России «О рекомендуемой величине индексов изменения сметной стоимости
 * строительства…» на квартал (приложения «Индексы изменения сметной стоимости по элементам прямых затрат
 * по объектам строительства, определяемых с применением федеральных и территориальных единичных расценок»
 * и смежные таблицы). Справочник собирает `scripts/fsnb/build-bim-indices.ts` из текстов писем
 * (`pdftotext -layout`), вручную JSON не правят; каждая запись несёт письмо и страницу.
 *
 * Про две строки в клетке таблицы («Индексы к ФЕР-2001/ТЕР-2001»). Верхняя строка — индекс к единичным
 * расценкам ФЕР-2001, нижняя — к ТЕР-2001 субъекта: заголовок таблицы пишет «ФЕР-2001/ТЕР-2001» именно
 * в этом порядке; нижняя строка заполнена только у субъектов, у которых утверждены собственные ТЕР-2001
 * (Белгородская область: ОТ 47,58 / 50,75), у остальных стоит «-»; таблицы «Индексы к ФЕР-2001»
 * (атомная энергетика, ВЛ ПАО «Россети», алмазодобыча, железные дороги) печатают одну строку. Явной
 * сноски об этом в тексте писем нет — вывод по заголовку и по структуре таблиц (см. `baseRowMeaning`).
 */

/** Базисная сборник расценок, к которой применяется индекс. */
export type BimBase = "FER" | "TER";

export const BIM_BASE_LABEL: Readonly<Record<BimBase, string>> = {
  FER: "ФЕР-2001",
  TER: "ТЕР-2001",
};

/** Элемент прямых затрат, к которому применён индекс. */
export type BimElement = "LABOUR" | "MATERIALS" | "MACHINES";

export const BIM_ELEMENT_LABEL: Readonly<Record<BimElement, string>> = {
  LABOUR: "оплата труда",
  MATERIALS: "материалы, изделия и конструкции",
  MACHINES: "эксплуатация машин и механизмов",
};

/** Индексы по элементам прямых затрат для одного объекта строительства, субъекта (зоны) и базы расценок. */
export interface BimElementRecord {
  /** Субъект РФ, как в справочнике ценовых зон: «Белгородская область», «город Москва». */
  readonly subject: string;
  /** Номер ценовой зоны субъекта из «(2 зона)»; null — зона в таблице не указана. */
  readonly zone: number | null;
  /** Объект строительства: «Многоквартирные жилые дома: Кирпичные», «Административные здания». */
  readonly object: string;
  readonly base: BimBase;
  /** Индекс к оплате труда (ОТ); null — в таблице прочерк. */
  readonly labour: number | null;
  /** Индекс к материалам, изделиям и конструкциям; null — прочерк. */
  readonly materials: number | null;
  /** Индекс к эксплуатации машин и механизмов (ЭМ, в том числе оплата труда машинистов); null — прочерк. */
  readonly machines: number | null;
  /** Идентификатор письма (`BimLetterInfo.id`). */
  readonly letter: string;
  /** Страница письма (как напечатана в PDF). */
  readonly page: number;
}

/** Индекс СМР в целом (к сумме прямых затрат, накладных расходов и сметной прибыли) по объекту. */
export interface BimSmrRecord {
  readonly subject: string;
  readonly zone: number | null;
  readonly object: string;
  readonly base: BimBase;
  /** «SMR» — строительно-монтажные работы; «SMR_PNR» — строительно-монтажные и пусконаладочные. */
  readonly kind: "SMR" | "SMR_PNR";
  readonly value: number;
  readonly letter: string;
  readonly page: number;
}

/** Индекс сметных цен перевозки грузов автотранспортом (к ФЕР-2001) по типу транспортного средства. */
export interface BimTransportRecord {
  readonly subject: string;
  readonly zone: number | null;
  /** «автомобили бортовые», «автомобили-самосвалы», «автомобили-панелевозы», «автобетоносмесители», «автомобили-трубоплетевозы». */
  readonly vehicle: string;
  readonly value: number;
  readonly letter: string;
  readonly page: number;
}

/** Индексы проектных и изыскательских работ: к уровню цен на дату (общие для страны). */
export interface BimDesignRecord {
  readonly kind: "DESIGN" | "SURVEY";
  /** Уровень цен: «2001-01-01», «2022-01-01» или подпись справочника («сборник 1981 г., гл. 20»). */
  readonly level: string;
  readonly value: number;
  readonly letter: string;
  readonly page: number;
}

export interface BimLetterInfo {
  /** Первые 8 знаков идентификатора файла ФГИС ЦС: короткое имя письма внутри справочника. */
  readonly id: string;
  /** Номер письма Минстроя России: «46728-ИФ/09». */
  readonly number: string;
  /** Дата письма, ISO. */
  readonly date: string;
  /** Что в письме. */
  readonly title: string;
  /** Файл текста в `data/fsnb/normatives/sources/`, если письмо сохранено. */
  readonly file: string | null;
  /** Страниц в письме (по тексту). */
  readonly pages: number;
}

export interface BimIndicesQuarter {
  readonly year: number;
  readonly quarter: 1 | 2 | 3 | 4;
}

export interface BimIndicesData {
  readonly version: 1;
  readonly quarter: BimIndicesQuarter;
  /** Что означают две строки в клетке таблицы писем и откуда этот вывод. */
  readonly baseRowMeaning: string;
  readonly letters: readonly BimLetterInfo[];
  readonly elements: readonly BimElementRecord[];
  readonly smr: readonly BimSmrRecord[];
  readonly transport: readonly BimTransportRecord[];
  readonly design: readonly BimDesignRecord[];
  /** Что не разобрано и почему: таблицы чужих отраслевых баз, несошедшиеся страницы. */
  readonly notes: readonly string[];
}

/** Сколько текстов писем и записей получилось — для паспорта сборки и проверки. */
export interface BimParseStats {
  readonly pages: number;
  readonly elementPages: number;
  readonly elements: number;
  readonly smr: number;
  readonly transport: number;
  readonly design: number;
}
