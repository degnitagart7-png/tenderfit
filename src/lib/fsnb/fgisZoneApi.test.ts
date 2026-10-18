import { describe, expect, it } from "vitest";

import {
  MAX_REGISTRY_PAGES,
  assertPayload,
  collectRegistryPages,
  wagesPageUrl,
  parseApiPeriods,
  parseApiZones,
  periodsUrl,
  pickPeriod,
  selectPricedZones,
  selectSubjectZones,
  serviceFileUrls,
  zoneFileUrls,
  zonesUrl,
} from "@/lib/fsnb/fgisZoneApi";

/** Фрагмент настоящего ответа /api/PriceZone: у Бурятии запись субъекта (193) и зоны 232–239. */
const ZONES = parseApiZones([
  { value: 193, text: "Республика Бурятия", data: null, order: 0, description: null },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: 231 + n, text: `Республика Бурятия (${String(n)} зона)` })),
  { value: 282, text: "Амурская область (1 зона)" },
  { value: 153, text: "Амурская область" },
  { value: 50, text: "Республика Калмыкия" },
  { value: 51, text: "  " },
  "мусор",
]);

describe("адреса ФГИС ЦС", () => {
  it("список зон, периоды и три файла зоны за период", () => {
    expect(zonesUrl()).toBe("https://fgiscs.minstroyrf.ru/api/PriceZone");
    expect(periodsUrl(236)).toBe("https://fgiscs.minstroyrf.ru/api/EstimatedPrice/Periods?priceZoneId=236");
    expect(zoneFileUrls(236, 427)).toEqual({
      fscsr: "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/BuildingResources/Export?periodId=427&priceZoneId=236&authorityId=null",
      wages: "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/RimWorkerSalaryRegistry?periodId=427&priceZoneId=236",
      split: "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/BuildingResources/ExportSplitForm?periodId=427&priceZoneId=236",
    });
  });
});

describe("адреса выгрузок перевозки и погрузки", () => {
  it("только автомобильный транспорт: перевозка и погрузочно-разгрузочные работы за период и зону", () => {
    expect(serviceFileUrls(246, 427)).toEqual({
      transport: "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/Services/Export/TransportationByAutoPortal?periodId=427&priceZoneId=246",
      load: "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/Services/Export/LoadWorksByAutoPortal?periodId=427&priceZoneId=246",
    });
  });
});

describe("зоны с ценами", () => {
  it("запись субъекта (193, 153) пропускается, зоны остаются; субъект с одной зоной без номера — это и есть зона", () => {
    const priced = selectPricedZones(ZONES);

    expect(priced.map((zone) => zone.value)).toEqual([50, 232, 233, 234, 235, 236, 237, 238, 239, 282]);
    expect(priced.some((zone) => zone.text === "Республика Бурятия")).toBe(false);
    expect(priced.some((zone) => zone.text === "Амурская область")).toBe(false);
    expect(priced.some((zone) => zone.text === "Республика Калмыкия")).toBe(true);
  });
});

describe("справочник зон", () => {
  it("мусорные записи пропускаются, пустой список — ошибка", () => {
    expect(ZONES).toHaveLength(12);
    expect(() => parseApiZones([])).toThrow(/ни одной записи/);
    expect(() => parseApiZones({})).toThrow(/не массивом/);
  });

  it("зоны субъекта — без записи самого субъекта (193), по порядку", () => {
    expect(selectSubjectZones(ZONES, "Республика Бурятия").map((zone) => zone.value)).toEqual([232, 233, 234, 235, 236, 237, 238, 239]);
    expect(selectSubjectZones(ZONES, "республика бурятия")).toHaveLength(8);
  });

  it("у субъекта одна зона — это запись субъекта; чужого субъекта нет — пусто", () => {
    expect(selectSubjectZones(ZONES, "Республика Калмыкия").map((zone) => zone.value)).toEqual([50]);
    expect(selectSubjectZones(ZONES, "Республика Тыва")).toEqual([]);
  });

  it("«Амурская область» берёт зоны с номерами, а не запись субъекта", () => {
    expect(selectSubjectZones(ZONES, "Амурская область").map((zone) => zone.value)).toEqual([282]);
  });
});

describe("периоды", () => {
  const periods = parseApiPeriods([{ id: 427, name: "3 квартал 2026 г." }, { id: 426, name: "2 квартал 2026 г." }, { nope: 1 }]);

  it("latest — первый (самый свежий), номер — по совпадению", () => {
    expect(pickPeriod(periods, "latest")).toEqual({ id: 427, name: "3 квартал 2026 г." });
    expect(pickPeriod(periods, 426).name).toBe("2 квартал 2026 г.");
  });

  it("нет периода — ошибка с перечнем доступных", () => {
    expect(() => pickPeriod(periods, 1)).toThrow(/доступны: 427, 426/);
    expect(() => pickPeriod([], "latest")).toThrow(/ни одного периода/);
  });
});

describe("проверка ответа до записи на диск", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const zip = new Uint8Array([0x50, 0x4b, 3, 4, 0]);

  it("пустой ответ", () => {
    expect(() => assertPayload("xlsx", new Uint8Array(), null, "ФСЦСР")).toThrow(/пустой ответ/);
  });

  it("HTML вместо файла — по типу содержимого и по началу тела", () => {
    expect(() => assertPayload("xlsx", zip, "text/html; charset=utf-8", "ФСЦСР")).toThrow(/HTML-страница/);
    expect(() => assertPayload("json", bytes("<!DOCTYPE html><html>"), null, "Ставки")).toThrow(/HTML-страница/);
    expect(() => assertPayload("json", bytes("  <html><body>"), "application/json", "Ставки")).toThrow(/HTML-страница/);
  });

  it("xlsx без сигнатуры zip и битый JSON", () => {
    expect(() => assertPayload("xlsx", bytes("просто текст"), null, "Сплит-форма")).toThrow(/не похож на xlsx/);
    expect(() => assertPayload("json", bytes("{не json"), null, "Ставки")).toThrow(/не разбирается как JSON/);
  });

  it("настоящие файлы проходят", () => {
    expect(() => assertPayload("xlsx", zip, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x")).not.toThrow();
    expect(() => assertPayload("json", bytes('{"items":[]}'), "application/json", "x")).not.toThrow();
  });
});

describe("реестр ставок листается постранично", () => {
  const record = (id: number) => ({ id, code: `1-100-${String(id)}`, salary: String(id) });
  /** Сервер на 60 записей: страницы по 25, `page` с 1, за пределами — пусто. */
  const server = (total: number, perPage = 25) => {
    const requested: number[] = [];
    return {
      requested,
      fetchPage: async (page: number) => {
        requested.push(page);
        const from = (page - 1) * perPage;
        const items = Array.from({ length: Math.max(0, Math.min(perPage, total - from)) }, (_, i) => record(from + i + 1));
        return { total, items };
      },
    };
  };

  it("адрес страницы — параметр page поверх адреса реестра", () => {
    expect(wagesPageUrl(282, 427, 3)).toBe(
      "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/RimWorkerSalaryRegistry?periodId=427&priceZoneId=282&page=3",
    );
  });

  it("листает page=1,2,3… пока не наберётся total, и не просит лишнего", async () => {
    const { fetchPage, requested } = server(60);
    const result = await collectRegistryPages(fetchPage);

    expect(result.items).toHaveLength(60);
    expect(result.total).toBe(60);
    expect(result.pages).toBe(3);
    expect(requested).toEqual([1, 2, 3]);
  });

  it("186 записей — 8 страниц, как у настоящего реестра", async () => {
    const result = await collectRegistryPages(server(186).fetchPage);

    expect(result.items).toHaveLength(186);
    expect(result.pages).toBe(8);
  });

  it("дубли по id убираются: сервер повторил страницу — стоп без цикла", async () => {
    const same = { total: 100, items: [record(1), record(2)] };
    await expect(collectRegistryPages(async () => same)).rejects.toThrow(/собран не целиком: 2 записей из 100/);
  });

  it("пустая страница раньше total — ошибка, а не молчаливо неполный реестр", async () => {
    const pages = [{ total: 50, items: Array.from({ length: 25 }, (_, i) => record(i + 1)) }, { total: 50, items: [] }];
    await expect(collectRegistryPages(async (page) => pages[page - 1])).rejects.toThrow(/25 записей из 50/);
  });

  it("предохранитель: не больше 50 страниц, даже если total недостижим", async () => {
    let calls = 0;
    await expect(
      collectRegistryPages(async (page) => {
        calls += 1;
        return { total: 100_000, items: [record(page)] };
      }),
    ).rejects.toThrow(/собран не целиком/);
    expect(calls).toBe(MAX_REGISTRY_PAGES);
  });

  it("пустой реестр и ответ без items — ошибки с понятным текстом", async () => {
    await expect(collectRegistryPages(async () => ({ total: 0, items: [] }))).rejects.toThrow(/пуст/);
    await expect(collectRegistryPages(async () => ({ total: 1 }))).rejects.toThrow(/без списка items/);
  });

  it("total не пришёл — собирается всё, что дали, до первой пустой страницы", async () => {
    const pages = [{ items: [record(1), record(2)] }, { items: [] }];
    const result = await collectRegistryPages(async (page) => pages[page - 1]);

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });
});
