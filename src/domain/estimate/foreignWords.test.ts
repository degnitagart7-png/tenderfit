import { describe, expect, it } from "vitest";

import {
  createNormSearchIndex,
  findNorms,
  foreignWords,
  hasForeignSignal,
  reviewVerdict,
  trustedByName,
} from "@/domain/estimate/matchNorms";
import { makeSearchNorm } from "@/test/estimateFixtures";

/*
  Второй сигнал «проверьте»: в норме есть значимые слова, которых нет в работе. Наименования норм —
  настоящие, из ФСНБ-2022 (названия сборников тоже: «Конструкции из кирпича и блоков» делает
  покрытие слова «кирпича» полным, хотя в самой норме речь о бутовом камне).
*/

const norm = (
  code: string,
  fullName: string,
  unit: string,
  collectionCode: string,
  collectionName: string,
) =>
  makeSearchNorm({
    code,
    fullName,
    endName: fullName,
    unit,
    collectionCode,
    collectionName,
    baseType: "ГЭСН",
  });

const FORMWORK = norm("06-16-001-01", "Монтаж и демонтаж: крупнощитовой опалубки стен", "10 м2", "06", "Бетонные и железобетонные конструкции монолитные");
const FORMWORK_2 = norm("06-16-003-01", "Монтаж и демонтаж блочной опалубки стен", "10 м2", "06", "Бетонные и железобетонные конструкции монолитные");
const DISASSEMBLY = norm("46-04-001-04", "Разборка: кирпичных стен", "м3", "46", "Работы при реконструкции зданий и сооружений");
const RUBBLE_WALLS = norm(
  "08-01-001-04",
  "Кладка стен из бутового камня без облицовки с применением мастики горячей: при высоте этажа до 4 м",
  "м3",
  "08",
  "Конструкции из кирпича и блоков",
);
const BRICK_WALLS = norm("08-02-001-01", "Кладка стен кирпичных наружных: простых при высоте этажа до 4 м", "м3", "08", "Конструкции из кирпича и блоков");
const ALUMINIUM = norm(
  "09-02-016-01",
  "Монтаж металлоконструкций из алюминиевых сплавов для РВС 30000 м3 понтона поплавкового",
  "т",
  "09",
  "Строительные металлические конструкции",
);
const STEEL = norm("09-07-030-06", "Монтаж металлоконструкций площадок обслуживания оборудования", "т", "09", "Строительные металлические конструкции");
const STEEL_FRAME = norm("09-01-002-01", "Монтаж элементов каркасов одноэтажных зданий из стальных сварных профилей", "т", "09", "Строительные металлические конструкции");
const WINDOWS_ALUMINIUM = norm("09-04-009-04", "Монтаж оконных блоков: из алюминиевых многокамерных профилей с герметичными стеклопакетами", "100 м2", "09", "Строительные металлические конструкции");
const WINDOWS_REMOVAL = norm("56-01-001-01", "Демонтаж оконных коробок: в каменных стенах с отбивкой штукатурки в откосах", "100 шт", "56", "Ремонт");
const CONCRETE_PREP = norm("06-01-001-01", "Устройство бетонной подготовки", "100 м3", "06", "Бетонные и железобетонные конструкции монолитные");

const index = createNormSearchIndex([
  FORMWORK,
  FORMWORK_2,
  DISASSEMBLY,
  RUBBLE_WALLS,
  ALUMINIUM,
  STEEL,
  STEEL_FRAME,
  WINDOWS_ALUMINIUM,
  WINDOWS_REMOVAL,
  CONCRETE_PREP,
]);

/** Первая норма подбора и вердикт по ней — то, что видит человек в таблице. */
function pick(workName: string) {
  const top = findNorms(index, { workName, limit: 1 })[0];
  if (top === undefined) throw new Error(`для «${workName}» ничего не подобрано`);
  return { top, verdict: reviewVerdict(index, workName, top), foreign: foreignWords(index, workName, top.norm) };
}

describe("«проверьте»: в норме есть слова, которых нет в работе", () => {
  it("опалубка: «Демонтаж наружных стен» → «Монтаж и демонтаж … опалубки стен»", () => {
    const { top, verdict } = pick("Демонтаж наружных стен");

    expect(top.norm.code).toBe("06-16-001-01");
    expect(verdict.review).toBe(true);
    expect(verdict.reason).toBe("в норме есть «опалубки», в работе — нет");
  });

  it("кирпич: «Кладка стен из кирпича» → «Кладка стен из бутового камня» (покрытие полное из-за названия сборника)", () => {
    const { top, verdict } = pick("Кладка стен из кирпича");

    expect(top.norm.code).toBe("08-01-001-04");
    expect(top.coverage).toBe(1);
    expect(verdict.review).toBe(true);
    expect(verdict.reason).toMatch(/в норме есть «бутового»(?:, «камня»)?, в работе — нет/u);
  });

  it("алюминий: «Монтаж металлоконструкций» → «… из алюминиевых сплавов …»", () => {
    const { top, verdict } = pick("Монтаж металлоконструкций");

    expect(top.norm.code).toBe("09-02-016-01");
    expect(top.coverage).toBe(1);
    expect(verdict.review).toBe(true);
    expect(verdict.reason).toContain("«алюминиевых»");
  });

  it("ПВХ вместо алюминия: другой материал в норме тоже «чужой»", () => {
    const { verdict } = pick("Монтаж оконных блоков из ПВХ профилей");
    expect(verdict.review).toBe(true);
    expect(verdict.reason).toContain("«алюминиевых»");
  });

  it("сигнал только подсвечивает: подбор не отменён, доверие к нему прежнее", () => {
    const { top } = pick("Демонтаж наружных стен");
    expect(trustedByName(top)).toBe(true);
    expect(findNorms(index, { workName: "Демонтаж наружных стен", limit: 1 })[0]?.norm.code).toBe("06-16-001-01");
  });
});

describe("верные подборы не подсвечиваются", () => {
  it("точное совпадение работы и нормы", () => {
    expect(pick("Разборка кирпичных стен").verdict.review).toBe(false);
    expect(pick("Устройство бетонной подготовки").verdict).toEqual({ review: false, reason: null });
  });

  it("материал назван в работе: «кирпичных» в работе и в норме — чужого нет", () => {
    const verdict = reviewVerdict(index, "Кладка стен кирпичных наружных", { norm: BRICK_WALLS, coverage: 1, strictCoverage: 1 });
    expect(verdict.review).toBe(false);
  });

  it("«металлических» в работе и «стальных» в норме — один металл, не чужой материал", () => {
    const foreign = foreignWords(index, "Монтаж металлических каркасов зданий", STEEL_FRAME);
    expect(hasForeignSignal(foreign)).toBe(false);
  });

  it("слова-уточнения варианта («с отбивкой штукатурки в откосах») не считаются чужим предметом", () => {
    const foreign = foreignWords(index, "Демонтаж оконных коробок", WINDOWS_REMOVAL);
    expect(hasForeignSignal(foreign)).toBe(false);
  });

  it("общие слова сметной лексики («монтаж», «стен», «наружных») чужими не бывают", () => {
    const foreign = foreignWords(index, "Кладка наружных стен", RUBBLE_WALLS);
    expect(foreign.words.map((item) => item.word)).not.toContain("наружных");
    expect(foreign.words.map((item) => item.word)).not.toContain("кладка");
  });

  it("стальная норма для «Монтаж металлоконструкций» не подсвечивается, если подобрана она", () => {
    const verdict = reviewVerdict(index, "Монтаж металлоконструкций площадок", { norm: STEEL, coverage: 1, strictCoverage: 1 });
    expect(verdict.review).toBe(false);
  });
});

describe("устройство признака", () => {
  it("вес слова — IDF по базе: редкое слово весит больше частого", () => {
    const foreign = foreignWords(index, "Работа", ALUMINIUM);
    const weights = new Map(foreign.words.map((item) => [item.word, item.weight]));
    expect(weights.get("понтона")).toBeGreaterThan(0);
    expect(foreign.foreignWeight).toBeGreaterThan(foreign.sharedWeight);
  });

  it("слабое покрытие по-прежнему подсвечивается своей причиной", () => {
    const verdict = reviewVerdict(index, "Разборка кирпичных стен и вывоз строительного мусора", {
      norm: DISASSEMBLY,
      coverage: 0.4,
      strictCoverage: 0.4,
    });
    expect(verdict).toEqual({ review: true, reason: "в норме нашлась лишь часть слов работы" });
  });
});
