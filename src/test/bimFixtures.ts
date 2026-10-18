import type { OverheadRate } from "@/domain/estimate/types";
import type { FerRate, FerResourcePrice } from "@/lib/fsnb/ferXml";
import { createFerBase, type FerBase } from "@/repositories/bimRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { makeParameters } from "@/test/estimateFixtures";

/**
 * Данные тестов базисно-индексного метода: малая выгрузка ФЕР-2020 из трёх расценок и одного материала, нормативы НР и СП и
 * ведомость на этих расценках. Цифры подобраны так, чтобы стоимость считалась в уме.
 *
 * Письма Минстроя — настоящие, встроенные в проект (III кв. 2026): Белгородская область, «Многоквартирные жилые дома: Кирпичные»,
 * ФЕР: ОТ 47,58, ЭМ 15,15, материалы 9,58; «Прочие объекты» в письме — другие числа, поэтому подмена объекта видна в итоге.
 */

export const EARTH: FerRate = {
  code: "01-01-001-01",
  book: "ФЕР",
  table: "01-01-001",
  name: "Разработка грунта экскаваторами драглайн",
  endName: "",
  unit: "1000 м3",
  collectionCode: "01",
  collectionName: "Земляные работы",
  cost: 6200,
  wage: 1000,
  machines: 5000,
  machinistWage: 500,
  materials: 200,
  labourHours: 100,
  machinistHours: 50,
  overheadRef: "812/пр-001.1",
  profitRef: "774/пр-001.1",
  unaccounted: [],
  correction: null,
};

export const BRICK: FerRate = {
  ...EARTH,
  code: "08-02-001-01",
  table: "08-02-001",
  name: "Кладка стен кирпичных наружных простых",
  unit: "м3",
  collectionCode: "08",
  collectionName: "Конструкции из кирпича и блоков",
  cost: 1500,
  wage: 300,
  machines: 100,
  machinistWage: 20,
  materials: 1100,
  overheadRef: "812/пр-008.1",
  profitRef: "774/пр-008.1",
  // Материал вне цены расценки («по проекту»): его стоимости в строке нет, и это должно быть сказано.
  unaccounted: [{ code: "08.1.02.11-0001", name: "Кирпич керамический", unit: "1000 шт", quantity: null }],
};

/** Соседняя по таблице расценка той же единицы: на неё человек меняет подобранную. */
export const BRICK_COMPLEX: FerRate = {
  ...BRICK,
  code: "08-02-002-01",
  table: "08-02-002",
  name: "Кладка стен кирпичных наружных сложных",
  wage: 400,
  machines: 150,
  machinistWage: 30,
  materials: 1200,
  cost: 1750,
};

/** Монтаж: книга ФЕРм, указатель НР которого в справочнике нормативов отсутствует — резерв документа с пометкой. */
export const MOUNT: FerRate = {
  ...EARTH,
  code: "08-02-001-01",
  book: "ФЕРм",
  table: "08-02-001",
  name: "Монтаж стальных конструкций",
  unit: "т",
  collectionCode: "08",
  collectionName: "Монтаж",
  cost: 800,
  wage: 200,
  machines: 400,
  machinistWage: 40,
  materials: 200,
  overheadRef: "812/пр-999.9",
  profitRef: "774/пр-999.9",
};

export const MATERIAL: FerResourcePrice = {
  code: "18.1.02.01-0085",
  name: "Клапан запорный",
  unit: "шт",
  cost: 100,
} as FerResourcePrice;

export function makeFerBase(): FerBase {
  return createFerBase([EARTH, BRICK, BRICK_COMPLEX, MOUNT], [MATERIAL]);
}

export const OVERHEAD_RATES: ReadonlyMap<string, OverheadRate> = new Map<string, OverheadRate>([
  ["Пр/812-001.1", { ref: "Пр/812-001.1", percent: 100, workType: "Земляные работы", source: "812/пр" }],
  ["Пр/774-001.1", { ref: "Пр/774-001.1", percent: 50, workType: "Земляные работы", source: "774/пр" }],
  ["Пр/812-008.1", { ref: "Пр/812-008.1", percent: 120, workType: "Кирпичные работы", source: "812/пр" }],
  ["Пр/774-008.1", { ref: "Пр/774-008.1", percent: 60, workType: "Кирпичные работы", source: "774/пр" }],
]);

export const BIM_DOC_TEXT = [
  "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
  "1 | Разработка грунта экскаваторами драглайн | 1000 м3 | 2 | ФЕР 01-01-001-01",
  "2 | Кладка стен кирпичных наружных простых | м3 | 10 | ФЕР 08-02-001-01",
  "3 | Монтаж стальных конструкций | т | 5 | ФЕРм 08-02-001-01",
  "4 | Клапан запорный | шт | 4 | ФССЦ-18.1.02.01-0085",
].join("\n");

const ROWS = [
  { workName: "Разработка грунта экскаваторами драглайн", quantity: "2", unit: "1000 м3", justification: "ФЕР 01-01-001-01", evidenceQuote: "1 | Разработка грунта экскаваторами драглайн | 1000 м3 | 2 | ФЕР 01-01-001-01" },
  { workName: "Кладка стен кирпичных наружных простых", quantity: "10", unit: "м3", justification: "ФЕР 08-02-001-01", evidenceQuote: "2 | Кладка стен кирпичных наружных простых | м3 | 10 | ФЕР 08-02-001-01" },
  { workName: "Монтаж стальных конструкций", quantity: "5", unit: "т", justification: "ФЕРм 08-02-001-01", evidenceQuote: "3 | Монтаж стальных конструкций | т | 5 | ФЕРм 08-02-001-01" },
  { workName: "Клапан запорный", quantity: "4", unit: "шт", justification: "ФССЦ-18.1.02.01-0085", evidenceQuote: "4 | Клапан запорный | шт | 4 | ФССЦ-18.1.02.01-0085" },
];

export const bimCalls = { count: 0 };

export const bimFetcher: BillRowsFetcher = async () => {
  bimCalls.count += 1;
  return { rows: ROWS, hasBill: true, tokens: 100, malformed: 0, truncated: false };
};

export const BIM_PARAMETERS = makeParameters();
