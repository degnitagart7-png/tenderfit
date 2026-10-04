import { describe, expect, it } from "vitest";
import type { NormRecord, NormResource } from "@/domain/estimate/types";
import {
  MACHINIST_HOURS_CODE,
  WORKER_HOURS_TOTAL_CODE,
  classifyResourceCode,
  machinistHoursFromMachines,
  rankFromWageCode,
  roundTo,
  toNormResource,
  unitForResourceKind,
} from "@/domain/estimate/resourceKinds";
import {
  NORM_DRAINAGE_100,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  NORM_PUSKONALADKA_GENERATOR,
  NORM_SLOPE_REINFORCEMENT,
  SEARCH_NORMS,
} from "@/test/estimateFixtures";

/**
 * Классификация ресурсов нормы.
 *
 * Ошибки здесь стоят дороже, чем в любом другом модуле расчёта: они не падают,
 * а тихо меняют сумму. Поэтому каждое правило проверено на реальном коде из
 * выгрузки ФСНБ-2022, а не на синтетическом примере.
 */
describe("classifyResourceCode", () => {
  it("отличает итоговые затраты труда рабочих от затрат труда машинистов", () => {
    expect(WORKER_HOURS_TOTAL_CODE).toBe("1");
    expect(MACHINIST_HOURS_CODE).toBe("2");
    expect(classifyResourceCode("1")).toBe("WORKER_HOURS_TOTAL");
    expect(classifyResourceCode("2")).toBe("MACHINIST_HOURS");
  });

  it("относит оба способа записи труда рабочих к оплате труда", () => {
    // «Средний разряд работы 3,8» из нормы 01-01-001-01.
    expect(classifyResourceCode("1-100-38")).toBe("LABOUR");
    // «Рабочий 4 разряда» из нормы 01-01-129-11.
    expect(classifyResourceCode("2-100-04")).toBe("LABOUR");
  });

  it("относит код звена машины к часам машинистов, а не к оплате труда", () => {
    // DriverCode бульдозера 91.01.01-035 из «ФСБЦ_Маш.xml». Оплата машиниста
    // уже внутри цены маш.-ч, поэтому второй раз начислять её нельзя.
    expect(classifyResourceCode("4-100-060")).toBe("MACHINIST_HOURS");
    expect(classifyResourceCode("4-100-093")).toBe("MACHINIST_HOURS");
  });

  it("относит труд специалистов к оплате труда, а не к нераспознанным кодам", () => {
    // Семь кодов семьи «3-*»: 6 183 строки в 2 653 работах пяти книг
    // (ГЭСНп 2 565, ГЭСНм 53, ГЭСНмр 35). Наименования взяты из выгрузки.
    expect(classifyResourceCode("3-100-01")).toBe("LABOUR"); // Техник I категории
    expect(classifyResourceCode("3-100-02")).toBe("LABOUR"); // Техник II категории
    expect(classifyResourceCode("3-200-01")).toBe("LABOUR"); // Инженер I категории
    expect(classifyResourceCode("3-200-02")).toBe("LABOUR"); // Инженер II категории
    expect(classifyResourceCode("3-200-03")).toBe("LABOUR"); // Инженер III категории
    expect(classifyResourceCode("3-300-01")).toBe("LABOUR"); // Ведущий инженер
    expect(classifyResourceCode("3-400-01")).toBe("LABOUR"); // Главный технолог
  });

  it("не выдаёт за специалиста код похожего вида", () => {
    expect(classifyResourceCode("3-100-1")).toBe("UNKNOWN");
    expect(classifyResourceCode("3-10-01")).toBe("UNKNOWN");
    expect(classifyResourceCode("33-100-01")).toBe("UNKNOWN");
    expect(classifyResourceCode("3.100.01")).toBe("UNKNOWN");
  });

  it("различает машины, материалы и нераспознанные коды", () => {
    expect(classifyResourceCode("91.01.01-035")).toBe("MACHINE");
    expect(classifyResourceCode("91.14.02-001")).toBe("MACHINE");
    expect(classifyResourceCode("01.7.12.05-0131")).toBe("MATERIAL");
    expect(classifyResourceCode("24.3.03.05")).toBe("MATERIAL");
    // ServiceResource «МАТЕРИАЛЫ (см. приложение)»: кода вида NN.* нет.
    expect(classifyResourceCode("999-9901")).toBe("UNKNOWN");
    expect(classifyResourceCode("")).toBe("UNKNOWN");
  });

  it("не спотыкается о пробелы вокруг кода", () => {
    expect(classifyResourceCode("  1  ")).toBe("WORKER_HOURS_TOTAL");
    expect(classifyResourceCode(" 91.01.01-035 ")).toBe("MACHINE");
  });
});

describe("rankFromWageCode", () => {
  it("читает средний разряд из кода с префиксом 1 как десятые доли", () => {
    // Перепись пяти книг норм: 54 кода «1-100-*» от разряда 1,0 до 8,0.
    expect(rankFromWageCode("1-100-10")).toBe(1);
    expect(rankFromWageCode("1-100-38")).toBe(3.8);
    expect(rankFromWageCode("1-100-73")).toBe(7.3);
    expect(rankFromWageCode("1-100-80")).toBe(8);
  });

  it("читает разряд из кода с префиксом 2 как целое число", () => {
    // Перепись: коды «2-100-01» … «2-100-07», 14 334 строки, наименования
    // «Рабочий 1 разряда» … «Рабочий 7 разряда». Делить на десять здесь нельзя:
    // «2-100-04» — это разряд 4, а не 0,4. Ошибка увела бы ставку ниже первого
    // разряда шкалы и занизила оплату труда примерно на 29 %.
    expect(rankFromWageCode("2-100-01")).toBe(1);
    expect(rankFromWageCode("2-100-02")).toBe(2);
    expect(rankFromWageCode("2-100-04")).toBe(4);
    expect(rankFromWageCode("2-100-07")).toBe(7);
  });

  it("читает разряд машиниста из кода с префиксом 4 как десятые доли", () => {
    // «4-100-060» соответствует MachinistCategory="6.0", «4-100-093» — "9.3".
    expect(rankFromWageCode("4-100-060")).toBe(6);
    expect(rankFromWageCode("4-100-093")).toBe(9.3);
  });

  it("возвращает null для кодов, которые не про оплату труда", () => {
    expect(rankFromWageCode("1")).toBeNull();
    expect(rankFromWageCode("2")).toBeNull();
    expect(rankFromWageCode("91.01.01-035")).toBeNull();
    expect(rankFromWageCode("01.7.12.05-0131")).toBeNull();
  });

  it("не приписывает разряд специалисту: должность и разряд — разные вещи", () => {
    // Тарифная шкала зоны построена по разрядам. Приписать «Инженеру I
    // категории» разряд значило бы начислить ставку, которой нет ни в одном
    // источнике выгрузки, — и в книге ГЭСНп на неё легла бы почти вся стоимость.
    expect(rankFromWageCode("3-100-01")).toBeNull();
    expect(rankFromWageCode("3-200-01")).toBeNull();
    expect(rankFromWageCode("3-400-01")).toBeNull();
  });
});

describe("фикстуры норм согласованы с классификатором", () => {
  // Фикстуры задают `kind` каждого ресурса руками, а боевой код получает его из
  // `classifyResourceCode`. Пока они совпадают, расхождение не видно: тесты
  // проходят на фикстурах, а смета по реальным данным считается иначе. Семья
  // кодов «3-*» ровно так и провалилась один раз — в фикстуре стоял LABOUR,
  // классификатор возвращал UNKNOWN.
  const FIXTURE_NORMS: readonly NormRecord[] = [
    NORM_DRAGLINE_15,
    NORM_MANUAL_GRADING,
    NORM_DRAINAGE_100,
    NORM_SLOPE_REINFORCEMENT,
    NORM_PUSKONALADKA_GENERATOR,
    ...SEARCH_NORMS,
  ];

  it("каждый ресурс фикстур отнесён к тому же виду, что даст классификатор", () => {
    const mismatches = FIXTURE_NORMS.flatMap((norm) =>
      norm.resources
        .filter((resource) => resource.kind !== classifyResourceCode(resource.code))
        .map(
          (resource) =>
            `${norm.baseType} ${norm.code}, ресурс ${resource.code}: в фикстуре ${resource.kind}, классификатор даёт ${classifyResourceCode(resource.code)}`,
        ),
    );

    expect(mismatches).toEqual([]);
  });

  it("фикстуры покрывают четыре книги из пяти: ГЭСНр остаётся непокрытой", () => {
    const books = [...new Set(FIXTURE_NORMS.map((norm) => norm.baseType))].sort();

    expect(books).toEqual(["ГЭСН", "ГЭСНм", "ГЭСНмр", "ГЭСНп"]);
  });

  it("труд специалистов присутствует в фикстурах, а не только в переписи", () => {
    const specialists = FIXTURE_NORMS.flatMap((norm) =>
      norm.resources.filter((resource) => resource.code.startsWith("3-")),
    );

    expect(specialists.length).toBeGreaterThan(0);
    expect(specialists.every((resource) => resource.kind === "LABOUR")).toBe(true);
  });
});

describe("unitForResourceKind", () => {  it("задаёт часы для труда и машин и оставляет материалы без единицы", () => {
    expect(unitForResourceKind("LABOUR")).toBe("чел.-ч");
    expect(unitForResourceKind("WORKER_HOURS_TOTAL")).toBe("чел.-ч");
    expect(unitForResourceKind("MACHINIST_HOURS")).toBe("чел.-ч");
    expect(unitForResourceKind("MACHINE")).toBe("маш.-ч");
    expect(unitForResourceKind("MATERIAL")).toBe("");
    expect(unitForResourceKind("UNKNOWN")).toBe("");
  });
});

describe("toNormResource", () => {
  it("подставляет единицу по виду ресурса, а не по каталогу", () => {
    const labour = toNormResource({
      code: "1-100-38",
      name: "Средний разряд работы 3,8",
      quantity: 1.54,
      unit: "м3",
    });
    expect(labour.unit).toBe("чел.-ч");
    expect(labour.kind).toBe("LABOUR");
  });

  it("сохраняет единицу материала из выгрузки", () => {
    const geotextile = toNormResource({
      code: "01.7.12.05-0131",
      name: "Геополотно нетканое полипропиленовое",
      quantity: 2140,
      unit: "м2",
    });
    expect(geotextile.unit).toBe("м2");
    expect(geotextile.kind).toBe("MATERIAL");
  });

  it("несёт пометку «по проекту» вместо потерянного нуля", () => {
    // AbstractResource «24.3.03.05» из нормы 01-01-129-11: Quantity="П".
    const coupling = toNormResource({
      code: "24.3.03.05",
      name: "Муфта полиэтиленовая для труб дренажных",
      quantity: 0,
      unit: "шт",
      quantityNote: "П",
      projectSpecific: true,
      technologyGroup: "34.04.013",
    });
    expect(coupling.quantityNote).toBe("П");
    expect(coupling.projectSpecific).toBe(true);
    expect(coupling.technologyGroup).toBe("34.04.013");
  });

  it("приводит пустые необязательные поля к null, а не к пустой строке", () => {
    const resource = toNormResource({
      code: " 91.01.01-035 ",
      name: "  Бульдозеры, мощность 79 кВт (108 л.с.)  ",
      quantity: 1.6,
    });
    expect(resource.code).toBe("91.01.01-035");
    expect(resource.name).toBe("Бульдозеры, мощность 79 кВт (108 л.с.)");
    expect(resource.unit).toBe("маш.-ч");
    expect(resource.quantityNote).toBeNull();
    expect(resource.projectSpecific).toBe(false);
    expect(resource.technologyGroup).toBeNull();
  });
});

describe("machinistHoursFromMachines", () => {
  /** Состав звена из «ФСБЦ_Маш.xml»: численность машинистов на маш.-ч. */
  const crewByCode = new Map<string, number>([
    ["91.01.01-035", 1],
    ["91.01.05-128", 3],
    ["91.01.01-034", 1],
    ["91.05.05-015", 1],
    ["91.08.09-024", 0],
    ["91.14.02-001", 1],
  ]);

  it("воспроизводит служебный код «2» нормы с драглайном", () => {
    // 1,6 × 1,00 + 1,6 × 3,00 = 6,4 — ровно то, что записано в коде «2».
    expect(machinistHoursFromMachines(NORM_DRAGLINE_15.resources, crewByCode)).toBe(6.4);
  });

  it("воспроизводит служебный код «2» нормы дренажа", () => {
    // 1,30 × 1 + 0,26 × 1 + 5,40 × 0 + 0,18 × 1 = 1,74.
    expect(machinistHoursFromMachines(NORM_DRAINAGE_100.resources, crewByCode)).toBe(1.74);
  });

  it("возвращает null, если ни одна машина нормы не найдена в справочнике", () => {
    const unknown: NormResource[] = [
      toNormResource({ code: "91.99.99-999", name: "Неизвестная машина", quantity: 1 }),
    ];
    expect(machinistHoursFromMachines(unknown, crewByCode)).toBeNull();
  });

  it("игнорирует материалы и труд рабочих", () => {
    const onlyMaterials = NORM_DRAINAGE_100.resources.filter((r) => r.kind === "MATERIAL");
    expect(machinistHoursFromMachines(onlyMaterials, crewByCode)).toBeNull();
  });
});

describe("roundTo", () => {
  it("округляет до нужного числа знаков", () => {
    expect(roundTo(686.075, 2)).toBe(686.08);
    expect(roundTo(1.19000036, 4)).toBe(1.19);
    expect(roundTo(203.11, 3)).toBe(203.11);
  });

  it("не пропускает NaN и бесконечность в смету", () => {
    expect(roundTo(Number.NaN, 2)).toBe(0);
    expect(roundTo(Number.POSITIVE_INFINITY, 2)).toBe(0);
  });
});
