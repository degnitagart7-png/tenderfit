import { normalizeText } from "@/domain/estimate/normalize";
import type { BillOfWorkItem, BillOfWorkSection } from "@/domain/estimate/types";
import { parseUnit } from "@/domain/estimate/units";

/**
 * Материал или работа: опознание строк ведомости, которые на самом деле — поставка.
 *
 * Зачем. Ведомость объёмов перечисляет материалы подстроками под работой: «10 Устройство основания под трубопроводы» и тут же «10.1
 * Песок природный … м3 24,75»; «11 Укладка стальных водопроводных труб» и «11.1 Трубы стальные электросварные … м 681,75»; «13
 * Установка задвижек» и «13.1 Задвижка клиновая … шт». Подбор нормы по наименованию принимал такую строку за работу: «Задвижка клиновая»
 * получала норму монтажа ГЭСНм 12-12-001-09 — монтаж, который уже стоит строкой 13, — а труба на 479 679 ₽ выпадала из сметы. Материал
 * считается как поставка по цене ресурса справочника (`computeResourceLine`), а не как работа.
 *
 * Как опознаётся — документированная эвристика, а не истина. Решают три признака, по порядку:
 * 1. **Глагол работы в начале наименования** («Устройство…», «Монтаж…», «Укладка…», «Окраска…», «Погрузка…»): это работа, что бы ни
 *    стояло дальше. «Песок для устройства основания» — материал, потому что глагол стоит не в начале.
 * 2. **Название изделия или материала в начале** («Трубы…», «Песок…», «Отвод…», «Задвижка…», «Штуцер…», «Кабель…», «Краска…»).
 * 3. **Подномер под работой** («11.1» под «11») и единица, обычная для поставки (шт, компл, т, кг, м).
 * Изделие без глагола — материал, если строка пронумерована как подстрока работы или единица поставочная. Изделие с «площадной» единицей
 * (м2, м3, 100 м2: «Грунтовка стен», «Плитка керамическая») без подномера — неясно: работа это или поставка. Подстрока работы, название
 * которой не из перечня изделий, — тоже неясно. Неясное решает ИИ (`normPick.ts`) по обоим наборам кандидатов — нормы и ресурсы; без ИИ
 * неясная строка считается работой, как раньше.
 *
 * Чего не делает. Не ищет ресурс (`resourceCandidates.ts`), не трогает строки с шифром из документа, цену заказчика и услуги —
 * вызывающий код отбирает их раньше (`needsNormPick`). Строки смет заказчика (`CUSTOMER_ESTIMATE`, `CONTRACT_ESTIMATE`) не
 * классифицируются: у них есть шифры, и материал в них назван ресурсом.
 *
 * Перечни ниже закрытые и ведутся руками; ошибка опознания стоит либо лишней работой (материал принят за работу — прежнее поведение),
 * либо строкой без цены с пометкой «проверьте» (работа принята за материал), но не молча неверной ценой.
 *
 * Модуль чистый.
 */

export type BillRowKind = "WORK" | "MATERIAL" | "AMBIGUOUS";

export interface BillRowClass {
  readonly kind: BillRowKind;
  /** Почему так решено: попадает в пометку позиции и в журнал. */
  readonly reason: string;
}

/**
 * Начала слов-глаголов работ (после нормализации). Слово ведомости считается глаголом работы, если начинается с одного из них.
 * Здесь и отглагольные существительные («Устройство», «Укладка»): ведомости пишут именно так.
 */
const WORK_VERB_STARTS: readonly string[] = [
  "устройств", "монтаж", "демонтаж", "демонт", "разборк", "разбор", "укладк", "установк", "прокладк", "окраск", "покраск", "огрунтовк",
  "грунтовани", "изоляц", "гидроизоляц", "теплоизоляц", "устранен", "замен", "смен", "ремонт", "очистк", "прочистк", "погрузк",
  "выгрузк", "разгрузк", "перевозк", "транспортировк", "вывоз", "перемещен", "разработк", "засыпк", "отсыпк", "планировк",
  "уплотнен", "трамбован", "бурен", "сварк", "приварк", "штукатур", "шпатлев", "оклейк", "облицовк", "кладк", "бетонирован",
  "армирован", "подготовк", "нанесен", "заделк", "герметизац", "промывк", "испытан", "пусконаладк", "наладк", "подключен", "врезк",
  "снятие", "снятия", "снос", "вскрыти", "сборк", "обустройств", "благоустройств", "посадк", "озеленен", "восстановлен",
  "выравнивани", "срезк", "рыхлен", "дезинфекц", "хлорирован", "опрессовк", "проверк", "осмотр", "обследован", "обработк", "защит",
  "заполнен", "удален", "отделк", "подгонк", "навеск", "раскладк", "поверк", "вырубк", "корчевк", "обрезк", "стяжк", "гидрофобиз",
  "антисептир", "антикоррозион", "зачистк", "шлифовк", "сверлен", "пробивк", "затирк", "подливк", "омоноличив", "торкретир",
  "инъектир", "перекладк", "перестил", "переборк", "рихтовк", "крепление", "крепления", "разделк", "отбивк", "пескоструй",
  "ограждение", "изготовлен", "прием", "приём", "доставк", "хранени", "охран", "уборк",
];

function isWorkVerb(word: string): boolean {
  return WORK_VERB_STARTS.some((start) => word.startsWith(start));
}

/**
 * Названия материалов и изделий поставки — именительный корень; слово принимается, если оно равно корню или корень + падежное окончание
 * («трубы», «труб», «песка», «кабелей»). Склейки вроде «проводка» или «плитка» с корнем «провод» и «плит» не совпадают: для них свой корень.
 * Здесь те, что в ведомости почти всегда — поставка: трубы, фасонина, арматура, метизы, кабель, листовой и профильный прокат, сыпучие и
 * лакокрасочные материалы.
 */
const PRODUCT_ROOTS: readonly string[] = [
  "труб", "песок", "песк", "отвод", "тройник", "переход", "заглушк", "фланец", "фланц", "задвижк", "кран", "клапан", "вентил",
  "затвор", "штуцер", "муфт", "хомут", "болт", "гайк", "шайб", "винт", "саморез", "гвозд", "анкер", "кабел", "провод", "шнур",
  "плит", "плитк", "лист", "профил", "швеллер", "уголок", "уголк", "арматур", "сетк", "краск", "грунтовк", "эмал", "лак",
  "шпатлевк", "смес", "бетон", "раствор", "щебен", "щебн", "гравий", "гравия", "цемент", "извест", "гипс", "клей", "мастик",
  "герметик", "кирпич", "брус", "доск", "бревн", "фанер", "обои", "обоев", "линолеум", "ламинат", "рубероид", "пленк", "геотекстил",
  "мембран", "стекл", "сталь", "стали", "проволок", "скоб", "гофр", "шпилек", "шпильк", "прокат",
];

/**
 * Изделия, которые в ведомости бывают и поставкой, и работой по установке без глагола («Двери — шт», «Светильники — шт», «Колонны — шт»,
 * «Блоки оконные», «Люки»). Подномер под работой делает их материалом; без подномера единица поставки не решает — это неясно, и решает ИИ.
 */
const INSTALLED_ROOTS: readonly string[] = [
  "двер", "окн", "светильник", "ламп", "выключател", "розетк", "щит", "шкаф", "счетчик", "насос", "радиатор", "котел", "котл", "бак",
  "емкост", "люк", "кольц", "колонн", "балк", "ригел", "перемычк", "лестниц", "ступен", "поручн", "решетк", "решётк", "лоток", "лотк",
  "короб", "колодец", "колодц", "отлив", "планк", "блок", "изделие", "изделия", "изделий", "материал", "зеркал", "стойк",
  "кронштейн", "опор", "полотн", "паркет",
];

/** Названия, у которых за корнем идёт продолжение слова: «асфальтобетон», «минераловатные», «утеплитель». */
const PRODUCT_PREFIXES: readonly string[] = ["асфальт", "пенопласт", "минват", "минераловат", "утеплител", "пиломатериал", "железобетон", "пеноплекс", "пенополистирол"];

const CASE_ENDING = "(?:[аеиоуыьюя]|ам|ами|ах|ов|ев|ей|ом|ем|ой|ою|ью|ии|ия|ию)?";
const PRODUCT_PATTERN = new RegExp(`^(?:${PRODUCT_ROOTS.join("|")})${CASE_ENDING}$`, "u");
const INSTALLED_PATTERN = new RegExp(`^(?:${INSTALLED_ROOTS.join("|")})${CASE_ENDING}$`, "u");

/** Название материала поставки. */
function isProductNoun(word: string): boolean {
  return PRODUCT_PATTERN.test(word) || PRODUCT_PREFIXES.some((prefix) => word.startsWith(prefix));
}

/** Название изделия, которое бывает и поставкой, и установкой. */
function isInstalledNoun(word: string): boolean {
  return INSTALLED_PATTERN.test(word);
}

/** Единицы, в которых работу и материал не спутать с площадью и объёмом: штуки, комплекты, масса, длина. */
const SUPPLY_UNITS: ReadonlySet<string> = new Set(["шт", "компл", "т", "кг", "м", "км"]);

/** Первые слова наименования: без номера позиции и знаков. */
function leadingWords(name: string, count: number): string[] {
  const words = normalizeText(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  // «4.1 Трубы…» из PDF: номер позиции в начале слова-числа не слово.
  while (words.length > 0 && /^\d+$/.test(words[0] as string)) words.shift();
  return words.slice(0, count);
}

/** Начало наименования для пояснений: полное в пометку не нужно. */
function shortName(name: string): string {
  const flat = name.replace(/\s+/gu, " ").trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 60).replace(/[\s,;:.]+$/u, "")}…`;
}

/** Номер родителя: «11.1» → «11», «2.3.4» → «2.3»; у номера без точки родителя нет. */
export function parentPositionNumber(position: string | null | undefined): string | null {
  if (position === null || position === undefined) return null;
  const match = /^(\d{1,3}(?:\.\d{1,3})*)\.\d{1,3}$/.exec(position.trim());
  return match === null ? null : (match[1] as string);
}

/** Контекст строки: известный родитель (работа, под которой пронумерована подстрока). */
export interface ParentRow {
  readonly workName: string;
  readonly positionNumber: string | null;
  /** Родитель уже опознан как материал: подстрока материала — не подстрока работы. */
  readonly kind?: BillRowKind;
}

/**
 * Работа или материал по наименованию, единице и номеру позиции.
 *
 * @param parent строка, под которой стоит подстрока («11» для «11.1»); null — родителя в ведомости нет
 */
export function classifyBillRow(
  row: Pick<BillOfWorkItem, "workName" | "quantityUnit"> & { readonly positionNumber?: string | null },
  parent: ParentRow | null,
): BillRowClass {
  const words = leadingWords(row.workName, 3);
  if (words.length === 0) return { kind: "WORK", reason: "наименование пустое" };

  const first = words[0] as string;
  if (isWorkVerb(first)) return { kind: "WORK", reason: `наименование начинается со слова работы «${first}»` };
  // «Обратная засыпка», «Ручная разборка»: прилагательное и слово работы; но «Стальные трубы» — изделие (глагола нет).
  const second = words[1];
  if (second !== undefined && !isProductNoun(first) && !isInstalledNoun(first) && isWorkVerb(second)) {
    return { kind: "WORK", reason: `наименование содержит слово работы «${second}»` };
  }

  const noun = words.find((word) => isProductNoun(word));
  const installed = noun === undefined ? words.find((word) => isInstalledNoun(word)) : undefined;
  const dotted = parentPositionNumber(row.positionNumber) !== null;
  const underWork = dotted && parent !== null && parent.kind !== "MATERIAL";
  const unit = parseUnit(row.quantityUnit)?.unit ?? null;
  const supplyUnit = unit !== null && SUPPLY_UNITS.has(unit);

  if (noun !== undefined) {
    if (dotted) {
      const under = parent === null ? "" : ` под строкой «${parent.positionNumber ?? ""} ${shortName(parent.workName)}»`;
      return { kind: "MATERIAL", reason: `подстрока ${row.positionNumber ?? ""}${under}, название изделия «${noun}», глагола работы нет` };
    }
    if (supplyUnit) {
      return { kind: "MATERIAL", reason: `название изделия «${noun}», глагола работы нет, единица «${unit ?? ""}» обычна для поставки` };
    }
    return { kind: "AMBIGUOUS", reason: `название изделия «${noun}» без глагола работы, но единица «${row.quantityUnit}» бывает и у работы` };
  }

  if (installed !== undefined) {
    if (dotted) {
      return { kind: "MATERIAL", reason: `подстрока ${row.positionNumber ?? ""}${parent === null ? "" : ` под строкой «${parent.positionNumber ?? ""} ${shortName(parent.workName)}»`}, название изделия «${installed}», глагола работы нет` };
    }
    return { kind: "AMBIGUOUS", reason: `изделие «${installed}» без глагола работы: в ведомости это бывает и поставка, и установка` };
  }

  if (underWork) {
    return { kind: "AMBIGUOUS", reason: `подстрока ${row.positionNumber ?? ""} под работой «${shortName(parent?.workName ?? "")}», наименование не из перечня изделий и без глагола работы` };
  }
  return { kind: "WORK", reason: "название работы без признаков поставки" };
}

/** Уровни, строки которых не классифицируются: у смет заказчика есть шифры, материал в них назван ресурсом. */
const UNCLASSIFIED_LEVELS: ReadonlySet<string> = new Set(["CUSTOMER_ESTIMATE", "CONTRACT_ESTIMATE"]);

/**
 * Опознание всех позиций ведомости: идентификатор позиции → вид. Родитель подстроки — ближайшая выше строка раздела с номером родителя
 * («11» для «11.1»): нумерация в документе начинается заново в каждой таблице, и ближайшая выше строка — та самая.
 */
export function classifyBill(sections: readonly BillOfWorkSection[]): Map<string, BillRowClass> {
  const result = new Map<string, BillRowClass>();
  for (const section of sections) {
    const kinds = new Map<string, BillRowKind>();
    section.items.forEach((item, index) => {
      if (item.sourceLevel !== undefined && UNCLASSIFIED_LEVELS.has(item.sourceLevel)) {
        result.set(item.id, { kind: "WORK", reason: "строка сметы заказчика: у неё свой шифр" });
        return;
      }
      const parentNumber = parentPositionNumber(item.positionNumber);
      let parent: ParentRow | null = null;
      if (parentNumber !== null) {
        for (let back = index - 1; back >= 0; back -= 1) {
          const candidate = section.items[back] as BillOfWorkItem;
          if (candidate.positionNumber === parentNumber) {
            parent = { workName: candidate.workName, positionNumber: candidate.positionNumber ?? null, kind: kinds.get(candidate.id) ?? "WORK" };
            break;
          }
        }
      }
      const verdict = classifyBillRow(item, parent);
      kinds.set(item.id, verdict.kind);
      result.set(item.id, verdict);
    });
  }
  return result;
}
