import { describe, expect, it } from "vitest";

import {
  createNormSearchIndex,
  findNorms,
  normKey,
  tableRows,
  type NormSearchIndex,
} from "@/domain/estimate/matchNorms";
import { SEARCH_NORMS } from "@/test/estimateFixtures";

/**
 * Подбор норм ГЭСН под работу из ведомости объёмов работ.
 *
 * Главный сюжет этих тестов — не «находит ли поиск похожие слова», а то, что
 * подбор не может выдумать расценку. Облачный сервис возвращает готовый текст с
 * кодами, которых может не существовать: в ответе Smeta.AI на реальный запрос по
 * лоту 601801-КС ПИР СМР-2026-ДРСК-АЭС фигурировали «ГЭСН10-02-020-04» и «-05»,
 * и проверить их пользователю нечем. Здесь каждый результат — ссылка на запись,
 * которая физически лежит в нашей копии ФСНБ-2022, поэтому первое свойство,
 * которое проверяется, — замкнутость множества кандидатов.
 *
 * Второй сюжет — неоднозначность кода. Перепись пяти книг выгрузки ФГИС ЦС даёт
 * 56 242 элемента Work и 53 228 различных кодов: 2 784 кода встречаются больше
 * одного раза. «01-01-001-01» означает экскаватор-драглайн в ГЭСН, токарный
 * станок в ГЭСНм, синхронный генератор в ГЭСНп и замок двери шахты лифта в
 * ГЭСНмр. Все четыре записи есть в фикстурах, потому что это не краевой случай,
 * а первая же строка первой же таблицы.
 */

const INDEX: NormSearchIndex = createNormSearchIndex(SEARCH_NORMS);

/** Идентификатор результата: книга и код, без наименований. */
function identity(match: { norm: { baseType: string; code: string } }): string {
  return `${match.norm.baseType} ${match.norm.code}`;
}

/** Все результаты одним списком «книга код». */
function identities(
  matches: readonly { norm: { baseType: string; code: string } }[],
): string[] {
  return matches.map(identity);
}

describe("createNormSearchIndex", () => {
  it("хранит норму по паре «книга + код», а не по коду", () => {
    // Двенадцать записей, из них четыре делят код 01-01-001-01.
    expect(SEARCH_NORMS).toHaveLength(12);
    expect(INDEX.size).toBe(12);
    expect(INDEX.byKey.size).toBe(12);
    expect(INDEX.byCode.size).toBe(9);
  });

  it("не теряет ни одной из четырёх норм с кодом 01-01-001-01", () => {
    const books = (INDEX.byCode.get("01-01-001-01") ?? []).map((norm) => norm.baseType);
    expect([...books].sort()).toEqual(["ГЭСН", "ГЭСНм", "ГЭСНмр", "ГЭСНп"]);
  });

  it("разделяет таблицы разных книг", () => {
    // Таблица 01-01-001 есть и в ГЭСН (три строки), и в ГЭСНм (одна строка).
    expect(INDEX.byTable.get(normKey("ГЭСН", "01-01-001"))).toHaveLength(3);
    expect(INDEX.byTable.get(normKey("ГЭСНм", "01-01-001"))).toHaveLength(1);
  });

  it("собирает ключ без пробелов и с нормализацией кода", () => {
    expect(normKey(" ГЭСН ", "ГЭСН 01-01-001-01")).toBe("ГЭСН|01-01-001-01");
    expect(INDEX.byKey.get("ГЭСН|01-01-001-01")?.fullName).toContain("драглайн");
  });
});

describe("findNorms по явному коду", () => {
  it("возвращает все книги, когда код задан без книги", () => {
    const matches = findNorms(INDEX, { workName: "", normCode: "01-01-001-01" });

    expect(matches).toHaveLength(4);
    expect(identities(matches)).toContain("ГЭСН 01-01-001-01");
    expect(identities(matches)).toContain("ГЭСНм 01-01-001-01");
    expect(identities(matches)).toContain("ГЭСНп 01-01-001-01");
    expect(identities(matches)).toContain("ГЭСНмр 01-01-001-01");
  });

  it("говорит в объяснении, что код неоднозначен", () => {
    const matches = findNorms(INDEX, { workName: "", normCode: "01-01-001-01" });
    const first = matches[0];

    expect(first).toBeDefined();
    expect(first?.reasons.join(" ")).toContain("есть в нескольких книгах");
    expect(first?.reasons.join(" ")).toContain("Книга не указана");
  });

  it("книга сужает ответ до одной нормы", () => {
    const matches = findNorms(INDEX, {
      workName: "",
      normCode: "01-01-001-01",
      normBaseType: "ГЭСНм",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.norm.fullName).toContain("Станок в собранном виде");
  });

  it("разные книги по одному коду дают разные работы", () => {
    const earthworks = findNorms(INDEX, {
      workName: "",
      normCode: "01-01-001-01",
      normBaseType: "ГЭСН",
    });
    const elevator = findNorms(INDEX, {
      workName: "",
      normCode: "01-01-001-01",
      normBaseType: "ГЭСНмр",
    });

    expect(earthworks[0]?.norm.fullName).toContain("драглайн");
    expect(elevator[0]?.norm.fullName).toContain("Замена замка распашной двери шахты лифта");
  });

  it("принимает код с префиксом книги и пробелами", () => {
    const matches = findNorms(INDEX, {
      workName: "",
      normCode: "ГЭСН 01-01-001-07",
      normBaseType: "ГЭСН",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.norm.endName).toBe("10 м3, группа грунтов 1");
  });

  it("для несуществующего кода показывает строки той же таблицы нужной книги", () => {
    const matches = findNorms(INDEX, {
      workName: "",
      normCode: "01-01-001-99",
      normBaseType: "ГЭСН",
    });

    expect(matches).toHaveLength(3);
    expect(matches.every((match) => match.norm.baseType === "ГЭСН")).toBe(true);
    expect(identities(matches)).not.toContain("ГЭСНм 01-01-001-01");
    expect(matches[0]?.reasons.join(" ")).toContain("в книге ГЭСН не найден");
  });

  it("без книги показывает соседние строки всех книг и не повторяет запрошенный код", () => {
    const matches = findNorms(INDEX, { workName: "", normCode: "01-01-001-99" });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((match) => match.norm.code !== "01-01-001-99")).toBe(true);
    expect(new Set(matches.map((match) => match.norm.baseType)).size).toBeGreaterThan(1);
  });

  it("для кода неизвестной таблицы возвращает пустой список", () => {
    expect(findNorms(INDEX, { workName: "", normCode: "99-99-999-01" })).toEqual([]);
  });

  it("явный код важнее текста: наименование не добавляет кандидатов", () => {
    const matches = findNorms(INDEX, {
      workName: "Разработка грунта экскаватором драглайн 15 м3, группа грунтов 1",
      normCode: "06-01-001-13",
      normBaseType: "ГЭСН",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.norm.code).toBe("06-01-001-13");
  });
});

describe("findNorms по наименованию", () => {
  it("не возвращает норм, которых нет в индексе", () => {
    const queries = [
      "Разработка грунта экскаватором драглайн 15 м3, группа грунтов 1",
      "Разборка скального грунта бетоноломом",
      "Устройство фундаментов-столбов бетонных",
      "Устройство из бутового камня фундаментов ленточных",
      "Монтаж станка токарного массой 1,5 т",
      "Испытание синхронного генератора до 1 кВ",
      "Работа, которой в справочнике не существует вовсе",
      "",
      "   ",
    ];

    for (const workName of queries) {
      for (const match of findNorms(INDEX, { workName })) {
        expect(SEARCH_NORMS.some((norm) => norm === match.norm)).toBe(true);
        expect(INDEX.byKey.get(normKey(match.norm.baseType, match.norm.code))).toBe(match.norm);
      }
    }
  });

  it("под разработку грунта драглайном первой даёт земляные работы, а не станок", () => {
    const matches = findNorms(INDEX, {
      workName: "Разработка грунта экскаватором драглайн 15 м3, группа грунтов 1",
    });

    expect(matches.length).toBeGreaterThan(0);
    expect(identity(matches[0]!)).toBe("ГЭСН 01-01-001-01");
  });

  it("различает «разработка» и «разборка» грунта", () => {
    const demolition = findNorms(INDEX, { workName: "Разборка скального грунта бетоноломом" });

    expect(demolition.length).toBeGreaterThan(0);
    expect(demolition[0]?.norm.code).toBe("01-02-072-01");
    // Объяснение печатает словарную форму целиком: основа «разбор» была бы
    // прочитана сметчиком как опечатка программы.
    expect(demolition[0]?.reasons).toContain("Совпал вид работ: разборка");
  });

  it("разработка грунта не оказывается разборкой", () => {
    const excavation = findNorms(INDEX, {
      workName: "Разработка грунта экскаватором драглайн 15 м3, группа грунтов 1",
    });

    expect(excavation[0]?.norm.code).not.toBe("01-02-072-01");
    expect(excavation[0]?.reasons).toContain("Совпал вид работ: разработка");
  });

  it("дословное совпадение наименования отмечено в объяснении", () => {
    const matches = findNorms(INDEX, {
      workName: "Разборка скального грунта бетоноломом (гидроклиньями)",
    });

    expect(matches[0]?.reasons.join(" ")).toContain("дословно");
  });

  it("фильтр по сборнику оставляет только его нормы", () => {
    const concrete = findNorms(INDEX, {
      workName: "Устройство фундаментов-столбов бетонных",
      collectionCode: "06",
    });
    const brick = findNorms(INDEX, {
      workName: "Устройство из бутового камня фундаментов ленточных",
      collectionCode: "08",
    });

    expect(concrete.length).toBeGreaterThan(0);
    expect(concrete.every((match) => match.norm.collectionCode === "06")).toBe(true);
    expect(brick.length).toBeGreaterThan(0);
    expect(brick.every((match) => match.norm.collectionCode === "08")).toBe(true);
  });

  it("чужой сборник отсекает всё", () => {
    expect(
      findNorms(INDEX, {
        workName: "Устройство фундаментов-столбов бетонных",
        collectionCode: "47",
      }),
    ).toEqual([]);
  });

  it("книга сужает и текстовый поиск, а не только разбор кода", () => {
    const workName = "Разработка грунта в отвал экскаваторами драглайн";
    const unrestricted = findNorms(INDEX, { workName });
    const gesn = findNorms(INDEX, { workName, normBaseType: "ГЭСН" });

    expect(unrestricted.length).toBeGreaterThan(0);
    expect(identities(gesn)).toEqual(
      identities(unrestricted.filter((match) => match.norm.baseType === "ГЭСН")),
    );
    expect(findNorms(INDEX, { workName, normBaseType: "ГЭСНм" })).toEqual([]);
  });

  it("книга в запросе принимается в любом регистре", () => {
    const workName = "Разработка грунта в отвал экскаваторами драглайн";

    expect(identities(findNorms(INDEX, { workName, normBaseType: "гэсн" }))).toEqual(
      identities(findNorms(INDEX, { workName, normBaseType: "ГЭСН" })),
    );
  });

  it("«ГЭСНм» не проглатывает «ГЭСНмр»: книги различаются, а не начинаются одинаково", () => {
    const workName = "Замена замка распашной двери шахты лифта";
    const repair = findNorms(INDEX, { workName, normBaseType: "ГЭСНмр" });

    expect(identities(repair)).toEqual(["ГЭСНмр 01-01-001-01"]);
    expect(findNorms(INDEX, { workName, normBaseType: "ГЭСНм" })).toEqual([]);
  });

  it("уважает limit", () => {
    const matches = findNorms(INDEX, { workName: "Разработка грунта", limit: 2 });

    expect(matches.length).toBeLessThanOrEqual(2);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("пустое наименование и набор служебных слов не дают результатов", () => {
    expect(findNorms(INDEX, { workName: "" })).toEqual([]);
    expect(findNorms(INDEX, { workName: "   " })).toEqual([]);
    expect(findNorms(INDEX, { workName: "работы и для норма таблица" })).toEqual([]);
  });

  it("каждый результат объяснён по-русски и называет книгу", () => {
    const matches = findNorms(INDEX, {
      workName: "Разработка грунта экскаватором драглайн 15 м3, группа грунтов 1",
    });

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.reasons.length).toBeGreaterThan(0);
      for (const reason of match.reasons) {
        expect(reason.trim().length).toBeGreaterThan(0);
        expect(/[а-яА-Я]/.test(reason)).toBe(true);
      }
      expect(match.reasons.join(" ")).toContain(`книга ${match.norm.baseType}`);
      expect(match.score).toBeGreaterThan(0);
    }
  });

  it("порядок выдачи не зависит от порядка загрузки норм", () => {
    const reversed = createNormSearchIndex([...SEARCH_NORMS].reverse());
    const workName = "Разработка грунта в отвал экскаваторами драглайн";

    expect(identities(findNorms(reversed, { workName }))).toEqual(
      identities(findNorms(INDEX, { workName })),
    );
  });

  it("повторный запрос даёт тот же порядок", () => {
    const request = { workName: "Устройство закрытого дренажа из полиэтиленовых труб" };

    expect(identities(findNorms(INDEX, request))).toEqual(identities(findNorms(INDEX, request)));
  });

  it("результаты идут по убыванию счёта", () => {
    const matches = findNorms(INDEX, { workName: "Разработка грунта", limit: 20 });

    for (let index = 1; index < matches.length; index += 1) {
      expect(matches[index - 1]!.score).toBeGreaterThanOrEqual(matches[index]!.score);
    }
  });
});

describe("tableRows", () => {
  it("по коду строки возвращает всю таблицу нужной книги", () => {
    const rows = tableRows(INDEX, "01-01-001-02", "ГЭСН");

    expect(rows).toHaveLength(3);
    expect(rows.every((norm) => norm.baseType === "ГЭСН")).toBe(true);
  });

  it("без книги возвращает строки всех книг и сортирует их", () => {
    const rows = tableRows(INDEX, "01-01-001");

    // Таблица 01-01-001 есть в четырёх книгах: три строки в ГЭСН и по одной
    // в ГЭСНм, ГЭСНп и ГЭСНмр. Смешать их в один список — значит показать
    // сметчику шесть строк с одинаковым номером и разными работами.
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((norm) => norm.baseType)).size).toBe(4);
    const sorted = [...rows].sort((a, b) =>
      a.baseType.localeCompare(b.baseType, "ru") || a.code.localeCompare(b.code, "ru"),
    );
    expect(rows).toEqual(sorted);
  });

  it("для неизвестной таблицы возвращает пустой список", () => {
    expect(tableRows(INDEX, "99-99-999", "ГЭСН")).toEqual([]);
  });
});
