import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNormSearchIndex, normKey } from "@/domain/estimate/matchNorms";
import {
  actionOf,
  candidateOf,
  collectNormCandidates,
  MAX_CANDIDATES,
  objectGroupsOf,
  queryVariants,
  SUMMARY_CHARS,
} from "@/domain/estimate/normCandidates";
import { CANDIDATE_NORMS, CUSTOMER_NORM_KEYS } from "@/domain/estimate/normCandidates.fixtures";
import { deriveUnitDivisor } from "@/domain/estimate/units";

/**
 * Сборщик кандидатов «ИИ-сметчика».
 *
 * Главное свойство: для каждой позиции, на которой подбор по словам ошибался (ведомость закупки 0134300025826000377, ремонт фасада),
 * в списке кандидатов лежит норма, выбранная заказчиком. Модель выбирает только из списка, поэтому норма, которой в нём нет, потеряна
 * навсегда. Корпус — выдержка из настоящей базы (`normCandidates.fixtures.ts`); тот же замер на полной базе — в последнем тесте.
 */

const INDEX = createNormSearchIndex(CANDIDATE_NORMS);

/** Единица каждой позиции ведомости. */
const UNIT_OF: Readonly<Record<string, string>> = {
  "Монтаж стыковочной планки профлиста": "м",
};

function candidatesFor(workName: string, extra: { section?: string | null; units?: string[] } = {}) {
  return collectNormCandidates(INDEX, { workName, units: extra.units ?? [UNIT_OF[workName] ?? "м2"], section: extra.section ?? null });
}

describe("кандидаты на роль нормы: шесть позиций ведомости фасада", () => {
  for (const [workName, key] of Object.entries(CUSTOMER_NORM_KEYS)) {
    it(`«${workName}» — среди кандидатов есть норма заказчика ${key}`, () => {
      const keys = candidatesFor(workName).map((candidate) => candidate.key);
      expect(keys).toContain(key);
    });
  }

  it("у «Монтаж утеплителя (2 слоя 150+50 мм)» рядом с нужной строкой — соседние строки её таблицы (толщина)", () => {
    const rows = candidatesFor("Монтаж утеплителя (2 слоя 150+50 мм)")
      .filter((candidate) => candidate.tableCode === "26-01-035")
      .map((candidate) => candidate.code);
    expect(rows).toContain("26-01-035-02");
    // В таблице две строки (100 и 150 мм): модель видит обе и выбирает по толщине.
    expect(rows).toContain("26-01-035-01");
  });

  it("глухая ведомость без слов нормы: «Демонтаж профлиста» находит ГЭСНр 63-03-007 через «металлический сайдинг», а не бурильные установки", () => {
    const candidates = candidatesFor("Демонтаж профлиста");
    expect(candidates.map((candidate) => candidate.tableCode)).toContain("63-03-007");
    // Приманка общего поиска по слову «демонтаж» — установка горизонтального бурения — в выдачу не попала.
    expect(candidates.some((candidate) => candidate.tableCode === "04-01-080")).toBe(false);
  });

  it("«Утеплитель» в разделе «Демонтажные работы» ищется как разборка: действие берётся из заголовка раздела", () => {
    const withSection = candidatesFor("Утеплитель", { section: "Раздел 1. Демонтажные работы" });
    expect(withSection.map((candidate) => candidate.key)).toContain("ГЭСНр|66-01-024-02");
    // Первая таблица — разборка (ГЭСНр), а не устройство наружной теплоизоляции, как у «Утеплитель» без раздела.
    expect(withSection[0]?.book).toBe("ГЭСНр");
    expect(candidatesFor("Утеплитель")[0]?.book).toBe("ГЭСН");
  });
});

describe("состав списка", () => {
  const names = Object.keys(CUSTOMER_NORM_KEYS);

  it("не больше MAX_CANDIDATES строк, и каждая — запись из индекса (придумать шифр нельзя)", () => {
    for (const workName of names) {
      const candidates = candidatesFor(workName);
      expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(INDEX.byKey.has(candidate.key)).toBe(true);
        expect(candidate.key).toBe(normKey(candidate.book, candidate.code));
      }
    }
  });

  it("строки одной таблицы идут подряд: промпт печатает название таблицы один раз", () => {
    for (const workName of names) {
      const seen = new Set<string>();
      let previous = "";
      for (const candidate of candidatesFor(workName)) {
        const table = `${candidate.book}|${candidate.tableCode}`;
        if (table !== previous) {
          expect(seen.has(table)).toBe(false);
          seen.add(table);
          previous = table;
        }
      }
    }
  });

  it("единица нормы переводится из единицы позиции: норма в «м3» для работы в «м2» не предлагается", () => {
    for (const workName of ["Демонтаж утеплителя", "Монтаж утеплителя (2 слоя 150+50 мм)"]) {
      for (const candidate of candidatesFor(workName)) {
        expect(deriveUnitDivisor("м2", candidate.unit)).not.toBeNull();
      }
    }
    // Изоляция в «м3» (26-01-009, 26-01-011) в корпусе есть, но для позиции в «м3» она подходит.
    const cubic = candidatesFor("Монтаж утеплителя", { units: ["м3"] }).map((candidate) => candidate.tableCode);
    expect(cubic).toContain("26-01-011");
  });

  it("позиция в единице, которой нет ни у одной нормы корпуса, остаётся без кандидатов", () => {
    expect(candidatesFor("Демонтаж профлиста", { units: ["км"] })).toEqual([]);
  });

  it("пустое наименование — пустой список", () => {
    expect(candidatesFor("   ")).toEqual([]);
  });

  it("результат не зависит от повторного вызова", () => {
    const first = candidatesFor("Демонтаж оконных откосов").map((candidate) => candidate.key);
    const second = candidatesFor("Демонтаж оконных откосов").map((candidate) => candidate.key);
    expect(second).toEqual(first);
  });
});

describe("описание кандидата для промпта", () => {
  it("состав работ — первые ~200 знаков, у таблицы без состава — пусто", () => {
    const sidingRow = INDEX.byKey.get("ГЭСНр|63-03-007-02");
    expect(sidingRow).toBeDefined();
    const candidate = candidateOf(sidingRow!);
    expect(candidate.summary).toContain("Демонтаж негодного облицовочного материала");
    expect(candidate.summary.length).toBeLessThanOrEqual(SUMMARY_CHARS + 1);
    expect(candidate.tableName).toBe("Замена облицовки наружных стен из металлического сайдинга без замены каркаса площадью в одном месте");
    expect(candidate.rowName).toBe("от 1 м2 до 5 м2");
    expect(candidate.collection).toContain("Стекольные, обойные и облицовочные работы");

    const longContent = { ...sidingRow!, content: ["Очень длинный состав работ. ".repeat(40)] };
    expect(candidateOf(longContent).summary.length).toBeLessThanOrEqual(SUMMARY_CHARS + 1);
    expect(candidateOf({ ...sidingRow!, content: [] }).summary).toBe("");
  });

  it("таблица из одной строки: название — всё наименование, окончание строки пустое", () => {
    const single = INDEX.byKey.get("ГЭСН|26-01-066-01");
    expect(single).toBeDefined();
    const candidate = candidateOf(single!);
    expect(candidate.tableName).toBe("Устройство ветро-гидрозащиты вентилируемого фасада, с лесов");
    expect(candidate.rowName).toBe("");
  });

  it("длинное окончание строки обрезается, шифр остаётся целым", () => {
    const long = INDEX.byKey.get("ГЭСН|15-01-070-01");
    expect(long).toBeDefined();
    const candidate = candidateOf(long!);
    expect(candidate.rowName.length).toBeLessThanOrEqual(141);
    expect(candidate.key).toBe("ГЭСН|15-01-070-01");
  });
});

describe("справочник синонимов", () => {
  it("действие узнаётся по началу слова: «демонтажа», «Снятие», «Монтаж»", () => {
    expect(actionOf("Демонтаж профлиста")?.kind).toBe("DISMANTLE");
    expect(actionOf("работы по демонтажа обшивки")?.kind).toBe("DISMANTLE");
    expect(actionOf("Снятие ветрозащитной мембраны")?.kind).toBe("DISMANTLE");
    expect(actionOf("Монтаж утеплителя")?.kind).toBe("INSTALL");
    expect(actionOf("Замена окон")?.kind).toBe("REPLACE");
    expect(actionOf("Утеплитель")).toBeNull();
  });

  it("предмет «профлист» называется в ФСНБ «металлический сайдинг», «планка» — «нащельники»", () => {
    expect(objectGroupsOf("Демонтаж профлиста").map((group) => group.id)).toContain("profiled-sheet");
    const queries = queryVariants("Монтаж стыковочной планки профлиста").map((query) => query.text);
    expect(queries.some((query) => query.includes("нащельники"))).toBe(true);
    expect(queries.some((query) => query.includes("металлического сайдинга"))).toBe(true);
  });

  it("«Демонтаж» ищется и как «разборка», и как «снятие»; исходное наименование — первый запрос с полным весом", () => {
    const queries = queryVariants("Демонтаж профлиста");
    expect(queries[0]).toMatchObject({ text: "Демонтаж профлиста", weight: 1, dismantle: true });
    const texts = queries.map((query) => query.text);
    expect(texts).toContain("разборка профлиста");
    expect(texts).toContain("снятие профлиста");
  });

  it("скобки и числа в наименовании не мешают одному из запросов: «(2 слоя 150+50 мм)» отбрасывается", () => {
    const texts = queryVariants("Монтаж утеплителя (2 слоя 150+50 мм)").map((query) => query.text);
    expect(texts).toContain("Монтаж утеплителя");
  });

  it("число запросов ограничено: каждый — проход по индексу", () => {
    const many = queryVariants("Демонтаж профлиста утеплителя мембраны откосов планки облицовки окон водостока");
    expect(many.length).toBeLessThanOrEqual(22);
  });
});

/*
  Тот же замер на полной базе. Каталог норм занимает 185 МБ и собирается на машине разработчика и на сервере воркера, но не в CI,
  поэтому тест пропускается, когда его нет (как проверка паспорта базы в `estimateBaseRepository.test.ts`).
*/
const NORMS_FILE = path.join(process.cwd(), "data", "fsnb", "index", "norms.jsonl");
const built = existsSync(NORMS_FILE);

describe("полная база ФСНБ-2022", () => {
  it.skipIf(!built)(
    "для шести позиций ведомости фасада среди кандидатов есть норма заказчика",
    async () => {
      const { loadNormSearchIndex } = await import("@/repositories/estimateBaseRepository");
      const index = await loadNormSearchIndex();
      for (const [workName, key] of Object.entries(CUSTOMER_NORM_KEYS)) {
        const candidates = collectNormCandidates(index, { workName, units: [UNIT_OF[workName] ?? "м2"], section: null });
        expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
        expect(candidates.map((candidate) => candidate.key), workName).toContain(key);
      }
    },
    120_000,
  );
});
