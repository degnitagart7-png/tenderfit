import { describe, expect, it } from "vitest";

import { FACTS_LIMITS, mergeFactsBodies, parseFactsResponse, sanitizeFacts } from "@/domain/companyFacts/schema";
import { emptyFacts, factsHaveContent } from "@/domain/companyFacts/types";

const NOW = new Date("2026-10-21T12:00:00Z");

const ANSWER = {
  work_types: [{ name: "Капитальный ремонт кровли", contracts_count: 4, total_sum_rub: "48 500 000", years: [2024, 2023, 2023], largest_contract_rub: 21_000_000 }],
  contracts: [
    { subject: "Капитальный ремонт кровли школы", work_type: "капитальный ремонт кровли", customer_type: "муниципальный", customer: "Администрация города Омска", year: 2024, sum_rub: 21_000_000, law: "44-ФЗ", region: "Омская область" },
    { subject: "Ремонт фасада детского сада", customer_type: "government", customer: "ИП Петров П. П.", year: "2023", sum_rub: "9,5", law: "223 ФЗ", region: "Омская область" },
  ],
  sro: [{ kind: "Строительство", level: 2, max_contract_rub: 500_000_000, number: "СРО-С-123-01012020", valid_until: "01.01.2030" }],
  licenses: [{ kind: "Лицензия МЧС на монтаж систем пожарной безопасности", issuer: "МЧС России", number: "77-Б/00123" }],
  equipment: [{ name: "Автовышка", count: 2 }],
  staff: [{ role: "Инженер ПТО", count: 3, qualification: "НРС" }],
  prices: [{ name: "Демонтаж кровельного покрытия", unit: "м2", price_rub: 340, code: "ГЭСН 12-01-001", kind: "work", vat: "без НДС" }],
  regions: ["Омская область", "Новосибирская область"],
  notes: ["Работаем с НДС"],
};

describe("parseFactsResponse", () => {
  it("разбирает ответ модели: падежи и написания приводятся к одному виду", () => {
    const { body, droppedForPii } = parseFactsResponse(JSON.stringify(ANSWER), { now: NOW });
    expect(droppedForPii).toBe(0);
    expect(body.workTypes[0]).toMatchObject({ name: "Капитальный ремонт кровли", contractsCount: 4, totalSumRub: 48_500_000, years: [2023, 2024] });
    expect(body.contracts[0]).toMatchObject({ id: "c1", customerType: "municipal", law: "44-FZ", year: 2024, sumRub: 21_000_000 });
    expect(body.contracts[1]).toMatchObject({ id: "c2", law: "223-FZ", year: 2023, sumRub: 9.5 });
    expect(body.sro[0]).toMatchObject({ kind: "CONSTRUCTION", level: 2, maxContractRub: 500_000_000, validUntil: "2030-01-01" });
    expect(body.prices[0]).toMatchObject({ name: "Демонтаж кровельного покрытия", unit: "м2", priceRub: 340, code: "ГЭСН 12-01-001", kind: "work", vat: "without" });
    expect(factsHaveContent({ ...emptyFacts(NOW), ...body })).toBe(true);
  });

  it("заказчик-человек (ИП, гражданин) не сохраняется, а контракт остаётся", () => {
    const { body } = parseFactsResponse(JSON.stringify(ANSWER), { now: NOW });
    expect(body.contracts[1]?.customer).toBeNull();
    expect(body.contracts[1]?.subject).toBe("Ремонт фасада детского сада");
  });

  it("JSON в ограждении и с пояснением после него читается", () => {
    const { body } = parseFactsResponse(`\`\`\`json\n${JSON.stringify({ regions: ["Омская область"] })}\n\`\`\`\nГотово.`, { now: NOW });
    expect(body.regions).toEqual(["Омская область"]);
  });

  it("не объект — ошибка, пустой «успех» не маскирует сбой", () => {
    expect(() => parseFactsResponse("[]")).toThrow();
    expect(() => parseFactsResponse("не json")).toThrow();
  });

  it("битые записи отбрасываются поштучно", () => {
    const { body, droppedInvalid } = (() => {
      const result = parseFactsResponse(
        JSON.stringify({
          contracts: [{ subject: "" }, { subject: "Устройство ограждения", year: 2022, sum_rub: 1_000_000 }, "мусор", null],
          prices: [{ name: "Цемент", price_rub: 0 }, { name: "Цемент М500", unit: "т", price_rub: 7500 }],
          staff: [{ role: "Прораб", count: 0 }, { role: "Прораб", count: 2 }],
        }),
        { now: NOW },
      );
      return { body: result.body, droppedInvalid: result.droppedInvalid };
    })();
    expect(body.contracts).toHaveLength(1);
    expect(body.prices).toHaveLength(1);
    expect(body.staff).toEqual([{ role: "Прораб", count: 2, qualification: null }]);
    expect(droppedInvalid).toBe(3);
  });

  it("повторы контрактов и цен из двух документов схлопываются", () => {
    const item = { subject: "Ремонт кровли", year: 2024, sum_rub: 5_000_000 };
    const price = { name: "Кирпич", unit: "шт", price_rub: 18 };
    const { body } = parseFactsResponse(JSON.stringify({ contracts: [item, item], prices: [price, price] }), { now: NOW });
    expect(body.contracts).toHaveLength(1);
    expect(body.prices).toHaveLength(1);
  });

  it("год из будущего и из прошлого века — null", () => {
    const { body } = parseFactsResponse(JSON.stringify({ contracts: [{ subject: "А", year: 1950 }, { subject: "Б", year: 2040 }, { subject: "В", year: 2025 }] }), { now: NOW });
    expect(body.contracts.map((item) => item.year)).toEqual([null, null, 2025]);
  });

  it("потолки по спискам", () => {
    const prices = Array.from({ length: FACTS_LIMITS.prices + 50 }, (_, index) => ({ name: `Позиция ${String(index)}`, unit: "шт", price_rub: index + 1 }));
    expect(parseFactsResponse(JSON.stringify({ prices }), { now: NOW }).body.prices).toHaveLength(FACTS_LIMITS.prices);
  });
});

describe("защита от личного в ответе модели", () => {
  it("запись с ФИО в предмете выбрасывается целиком", () => {
    const { body, droppedForPii } = parseFactsResponse(
      JSON.stringify({
        contracts: [
          { subject: "Ремонт дома по заказу Иванова Ивана Ивановича", year: 2024, sum_rub: 2_000_000 },
          { subject: "Ремонт кровли школы", year: 2024, sum_rub: 3_000_000 },
        ],
      }),
      { now: NOW },
    );
    expect(body.contracts).toHaveLength(1);
    expect(body.contracts[0]?.subject).toBe("Ремонт кровли школы");
    expect(droppedForPii).toBe(1);
  });

  it("телефон и почта в названиях выбрасывают запись, в необязательном поле — только поле", () => {
    const { body } = parseFactsResponse(
      JSON.stringify({
        licenses: [{ kind: "Лицензия МЧС", issuer: "МЧС, тел. +7 913 123-45-67", number: "77-Б" }],
        equipment: [{ name: "Кран, звонить 8 913 111-22-33", count: 1 }],
        staff: [{ role: "Инженер ivan@mail.ru", count: 1 }],
        notes: ["Контакт: ivan@mail.ru", "Работаем по всей Сибири"],
      }),
      { now: NOW },
    );
    expect(body.licenses).toHaveLength(1);
    expect(body.licenses[0]?.issuer).toBeNull();
    expect(body.equipment).toHaveLength(0);
    expect(body.staff).toHaveLength(0);
    expect(body.notes).toEqual(["Работаем по всей Сибири"]);
  });

  it("название компании из анкеты не считается личным (keep)", () => {
    const options = { scrub: { keep: ["ИП Иванов Иван Иванович"], companyInn: "550312345678" }, now: NOW };
    const { body } = parseFactsResponse(JSON.stringify({ notes: ["Исполнитель ИП Иванов Иван Иванович, ИНН 550312345678"] }), options);
    expect(body.notes).toHaveLength(1);
  });
});

describe("sanitizeFacts: факты из анкеты не доверяются", () => {
  it("чужие или повреждённые факты проходят ту же проверку и теряют личное", () => {
    const stored = {
      version: 1,
      extractedAt: "2026-10-01T00:00:00.000Z",
      sourceDocuments: ["Реестр.pdf"],
      scrubStats: { fio: 5, phone: 2, nonsense: 9 },
      contracts: [
        { id: "c1", subject: "Ремонт кровли", workType: null, customerType: "municipal", customer: null, year: 2024, sumRub: 3_000_000, law: "44-FZ", region: null },
        { id: "c2", subject: "Работы у Сидорова С. С., тел. 8 913 000-11-22", year: 2023, sumRub: 100_000 },
      ],
      staff: [{ role: "Прораб", count: 2, qualification: null }],
    };
    const result = sanitizeFacts(stored, { now: NOW });
    expect(result).not.toBeNull();
    expect(result?.facts.contracts).toHaveLength(1);
    expect(result?.droppedForPii).toBe(1);
    expect(result?.facts.scrubStats).toMatchObject({ fio: 5, phone: 2 });
    expect(result?.facts.sourceDocuments).toEqual(["Реестр.pdf"]);
  });

  it("не объект — null", () => {
    expect(sanitizeFacts(null)).toBeNull();
    expect(sanitizeFacts("факты")).toBeNull();
    expect(sanitizeFacts([])).toBeNull();
  });
});

describe("mergeFactsBodies", () => {
  it("виды работ с одним названием: берётся большее, а не сумма; повторы контрактов — один", () => {
    const a = parseFactsResponse(
      JSON.stringify({
        work_types: [{ name: "Ремонт кровли", contracts_count: 3, total_sum_rub: 10_000_000, years: [2023] }],
        contracts: [{ subject: "Ремонт кровли школы", year: 2023, sum_rub: 4_000_000 }],
        sro: [{ kind: "CONSTRUCTION", level: 2 }],
      }),
      { now: NOW },
    ).body;
    const b = parseFactsResponse(
      JSON.stringify({
        work_types: [{ name: "ремонт кровли", contracts_count: 5, total_sum_rub: 9_000_000, years: [2024], largest_contract_rub: 4_000_000 }],
        contracts: [{ subject: "Ремонт кровли школы", year: 2023, sum_rub: 4_000_000 }, { subject: "Ремонт крыши гаража", year: 2024, sum_rub: 1_000_000 }],
        sro: [{ kind: "CONSTRUCTION", level: 2 }],
      }),
      { now: NOW },
    ).body;
    const merged = mergeFactsBodies([a, b]);
    expect(merged.workTypes).toHaveLength(1);
    expect(merged.workTypes[0]).toMatchObject({ contractsCount: 5, totalSumRub: 10_000_000, years: [2023, 2024], largestContractRub: 4_000_000 });
    expect(merged.contracts).toHaveLength(2);
    expect(merged.contracts.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(merged.sro).toHaveLength(1);
  });
});
