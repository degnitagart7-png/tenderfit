import { describe, expect, it } from "vitest";

import {
  loadPriceByName,
  parseTransportName,
  priceByServiceCode,
  resolveServicePrice,
  serviceCodeFromText,
  servicesFromRecords,
  transportPriceByName,
  type LoadPrice,
  type TransportSeries,
  type ZoneAutoServices,
} from "@/domain/estimate/autoServices";

/*
  Сопоставление позиции с ценой перевозки и погрузки: по шифру и по наименованию. Цены — из
  настоящей выгрузки зоны 246 (3 кв. 2026): 02-15-1-01-0047 = 619,94; 49-1 и 42-1 = 94,64.
  Правило одно: только однозначное сопоставление, иначе цены нет и позиция считается как прежде.
*/

function series(prefix: string, capacityUnit: "т" | "м3" | null, prices: Readonly<Record<number, number>>, max = 100): TransportSeries {
  const [vehicle, capacity, cls, road] = prefix.split("-") as [string, string, string, string];
  return {
    prefix,
    vehicle,
    capacity: Number.parseInt(capacity, 10),
    capacityUnit,
    cls: Number.parseInt(cls, 10) as 1 | 2 | 3 | 4,
    road,
    vehicleName: vehicle === "02" ? "Автомобили-самосвалы" : null,
    roadName: road === "01" ? "усовершенствованное дорожное покрытие" : null,
    prices: Array.from({ length: max }, (_, index) => prices[index + 1] ?? null),
  };
}

const LOADS: LoadPrice[] = [
  ["Мусор строительный с погрузкой вручную", 47, "LOAD", 1391.69],
  ["Мусор строительный с погрузкой транспортерами", 48, "LOAD", 378.79],
  ["Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", 49, "LOAD", 94.64],
  ["Гравий (выгрузка учитывает перемещение транспортерами)", 42, "LOAD", 94.64],
  ["Гравий (выгрузка учитывает перемещение транспортерами)", 42, "UNLOAD", 234.05],
  ["Песок (выгрузка учитывает перекидку и штабелирование)", 43, "LOAD", 70.98],
  ["Песок (выгрузка учитывает перекидку и штабелирование)", 43, "UNLOAD", 198.64],
  ["Лес круглый", 7, "LOAD", 580.78],
  ["Лес пиленый, погонаж плотничный, шпалы", 8, "LOAD", 476.08],
  ["Камень естественный без штабелирования (ленточными транспортерами)", 10, "LOAD", 133.96],
  ["Камень шлакобетонный (с применением транспортеров)", 11, "LOAD", 133.96],
].map(([groupName, group, operation, price]) => ({
  code: `${String(group).padStart(2, "0")}-${operation === "LOAD" ? "1" : "2"}`,
  group: group as number,
  groupName: groupName as string,
  operation: operation as "LOAD" | "UNLOAD",
  price: price as number,
}));

const SERVICES: ZoneAutoServices = servicesFromRecords(
  [
    series("02-15-1-01", "т", { 47: 619.94, 48: 630.77 }, 48),
    series("02-15-2-01", "т", { 47: 729.34 }, 48),
    series("02-15-1-02", "т", { 47: 896.07 }, 48),
    series("02-30-1-01", "т", { 47: 380.58 }, 48),
    series("05-06-1-01", "м3", { 47: 1000 }, 100),
  ],
  LOADS,
);

const FULL_NAME =
  "Перевозка грузов I класса автомобилями-самосвалами грузоподъемностью до 15 т по дорогам с усовершенствованным (асфальтобетонным, цементобетонным, железобетонным, обработанным органическим вяжущим) дорожным покрытием на расстояние 47 км";

describe("шифр услуги в обосновании строки", () => {
  it("находит шифр перевозки и шифр погрузки, а шифры расценок и ресурсов не принимает за услугу", () => {
    expect(serviceCodeFromText("02-15-1-01-0047")).toBe("02-15-1-01-0047");
    expect(serviceCodeFromText(" 49-1 ")).toBe("49-1");
    expect(serviceCodeFromText("42-2")).toBe("42-2");
    expect(serviceCodeFromText("ГЭСН46-06-009-03")).toBeNull();
    expect(serviceCodeFromText("ФСБЦ-02.2.04.03-0013")).toBeNull();
    // Перевозка материала в составе позиции («_02-15») — не шифр таблицы перевозки.
    expect(serviceCodeFromText("ФСБЦ-02.2.04.03-0013_02-15")).toBeNull();
    expect(serviceCodeFromText("п. 49-1 табл.")).toBeNull();
    expect(serviceCodeFromText(undefined)).toBeNull();
  });

  it("шифр перевозки берётся и из цитаты строки, когда обоснование пустое; погрузка — только из обоснования", () => {
    expect(serviceCodeFromText("", "7 02-15-1-01-0047 Перевозка грузов I класса")).toBe("02-15-1-01-0047");
    expect(serviceCodeFromText(undefined, "5 42-1 Погрузка в автотранспортное средство: гравий")).toBeNull();
  });
});

describe("цена по шифру", () => {
  it("02-15-1-01-0047 → 619,94, 49-1 → 94,64", () => {
    expect(priceByServiceCode(SERVICES, "02-15-1-01-0047")).toMatchObject({ ok: true, price: { kind: "TRANSPORT", price: 619.94, km: 47 } });
    expect(priceByServiceCode(SERVICES, "49-1")).toMatchObject({ ok: true, price: { kind: "LOAD", price: 94.64 } });
    expect(priceByServiceCode(SERVICES, "42-2")).toMatchObject({ ok: true, price: { kind: "UNLOAD", price: 234.05 } });
  });

  it("шифр, которого нет в таблице зоны, или чужая форма — причина, а не цена", () => {
    const unknown = priceByServiceCode(SERVICES, "09-65-1-01-0047");
    expect(unknown.ok ? "" : unknown.reason).toContain("нет в таблице перевозки зоны");
    const nonService = priceByServiceCode(SERVICES, "46-06-009-03");
    expect(nonService.ok).toBe(false);
  });
});

describe("разбор наименования перевозки", () => {
  it("класс, тип ТС, грузоподъёмность, дорога и километры читаются из наименования", () => {
    const parsed = parseTransportName(FULL_NAME);

    expect(parsed).toEqual({ ok: true, name: { cls: 1, vehicle: "02", capacity: 15, capacityUnit: "т", road: "01", km: 47 } });
  });

  it("«1 класса», «1-го класса», «II класса» — один и тот же класс груза", () => {
    const name = (cls: string): string => FULL_NAME.replace("I класса", cls);

    expect(parseTransportName(name("1 класса"))).toMatchObject({ ok: true, name: { cls: 1 } });
    expect(parseTransportName(name("1-го класса"))).toMatchObject({ ok: true, name: { cls: 1 } });
    expect(parseTransportName(name("II класса"))).toMatchObject({ ok: true, name: { cls: 2 } });
    expect(parseTransportName(name("IV класса"))).toMatchObject({ ok: true, name: { cls: 4 } });
  });

  it("скан читает «I» как «|»: класс неоднозначен («|» может быть и «II»), цены нет", () => {
    const parsed = parseTransportName(FULL_NAME.replace("I класса", "| класса"));

    expect(parsed).toEqual({ ok: false, reason: "класс груза в наименовании не читается" });
  });

  it("тип ТС без подтверждённого кода (бортовые) и тип дорог без кода (переходное) — неоднозначно, цены нет", () => {
    expect(parseTransportName(FULL_NAME.replace("автомобилями-самосвалами", "автомобилями бортовыми"))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("тип автотранспортного средства не сопоставлен"),
    });
    expect(parseTransportName(FULL_NAME.replace("с усовершенствованным (асфальтобетонным, цементобетонным, железобетонным, обработанным органическим вяжущим) дорожным", "с переходным"))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("тип дорог не сопоставлен"),
    });
  });

  it("без расстояния, с дробным расстоянием и без грузоподъёмности — отказ с причиной", () => {
    expect(parseTransportName(FULL_NAME.replace(" на расстояние 47 км", ""))).toMatchObject({ ok: false, reason: expect.stringContaining("расстояние перевозки") });
    expect(parseTransportName(FULL_NAME.replace("47 км", "47,5 км"))).toMatchObject({ ok: false, reason: expect.stringContaining("не целое") });
    expect(parseTransportName(FULL_NAME.replace("грузоподъемностью до 15 т", ""))).toMatchObject({ ok: false, reason: expect.stringContaining("грузоподъёмность") });
  });

  it("не «Перевозка» — не разбирается", () => {
    expect(parseTransportName("Погрузка в автотранспортное средство: гравий").ok).toBe(false);
  });
});

describe("цена перевозки по наименованию", () => {
  it("полное наименование → 02-15-1-01-0047, 619,94", () => {
    expect(transportPriceByName(SERVICES, FULL_NAME)).toMatchObject({ ok: true, price: { code: "02-15-1-01-0047", price: 619.94 } });
  });

  it("класс 2 и грузоподъёмность 30 т находят свои серии", () => {
    expect(transportPriceByName(SERVICES, FULL_NAME.replace("I класса", "2 класса"))).toMatchObject({ ok: true, price: { code: "02-15-2-01-0047", price: 729.34 } });
    expect(transportPriceByName(SERVICES, FULL_NAME.replace("до 15 т", "до 30 т"))).toMatchObject({ ok: true, price: { code: "02-30-1-01-0047", price: 380.58 } });
  });

  it("сочетания нет в таблице зоны, единица грузоподъёмности не та, километр за пределом — цены нет, причина названа", () => {
    const noSeries = transportPriceByName(SERVICES, FULL_NAME.replace("I класса", "3 класса"));
    expect(noSeries.ok ? "" : noSeries.reason).toContain("нет сочетания 02-15-3-01");

    const wrongUnit = transportPriceByName(SERVICES, FULL_NAME.replace("до 15 т", "до 15 м3"));
    expect(wrongUnit.ok ? "" : wrongUnit.reason).toContain("в «м3», а в таблице 02-15-1-01-… — в «т»");

    const beyond = transportPriceByName(SERVICES, FULL_NAME.replace("47 км", "49 км"));
    expect(beyond.ok ? "" : beyond.reason).toContain("больше таблицы перевозки зоны (48 км)");
  });
});

describe("цена погрузки по наименованию", () => {
  it("«гравий (выгрузка учитывает перомещение транспортерами)» — опечатка в скобках не мешает: группа 42, 94,64", () => {
    const found = loadPriceByName(SERVICES, "Погрузка в автотранспортное средство: гравий (выгрузка учитывает перомещение транспортерами)");

    expect(found).toMatchObject({ ok: true, price: { kind: "LOAD", code: "42-1", price: 94.64 } });
  });

  it("мусор с экскаваторами: латинская «M3» после распознавания не мешает, группа 49", () => {
    const found = loadPriceByName(
      SERVICES,
      "Погрузка в автотранспортное средство: мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 M3",
    );

    expect(found).toMatchObject({ ok: true, price: { code: "49-1", price: 94.64 } });
  });

  it("«мусор строительный» без способа погрузки подходит трём группам: неоднозначно, цены нет", () => {
    const found = loadPriceByName(SERVICES, "Погрузка в автотранспортное средство: мусор строительный");

    expect(found.ok).toBe(false);
    expect(found.ok ? "" : found.reason).toContain("несколько групп груза (47, 48, 49)");
  });

  it("«лес» и «камень» без уточнения — неоднозначно; «лес круглый» — однозначно", () => {
    expect(loadPriceByName(SERVICES, "Погрузка в автотранспортное средство: лес").ok).toBe(false);
    expect(loadPriceByName(SERVICES, "Погрузка в автотранспортное средство: камень").ok).toBe(false);
    expect(loadPriceByName(SERVICES, "Погрузка в автотранспортное средство: лес круглый")).toMatchObject({ ok: true, price: { code: "07-1", price: 580.78 } });
  });

  it("разгрузка называется отдельно и берёт цену разгрузки; груза нет в таблице — причина", () => {
    expect(loadPriceByName(SERVICES, "Разгрузка из автотранспортного средства: песок")).toMatchObject({ ok: true, price: { kind: "UNLOAD", code: "43-2", price: 198.64 } });
    const absent = loadPriceByName(SERVICES, "Погрузка в автотранспортное средство: стекловата");
    expect(absent.ok ? "" : absent.reason).toContain("не найдена");
  });
});

describe("resolveServicePrice: шифр важнее наименования, единица обязана быть тонной", () => {
  const base = { workName: FULL_NAME, quantityUnit: "т", quantity: 505.94 };

  it("шифр есть — цена по шифру, даже если наименование не читается", () => {
    const found = resolveServicePrice(SERVICES, { ...base, workName: "Перевозка грузов | класса", serviceCode: "02-15-1-01-0047" });
    expect(found).toMatchObject({ ok: true, price: { price: 619.94 } });
  });

  it("шифра нет — цена по наименованию; позиция, не похожая на услугу, — null (считается как обычно)", () => {
    expect(resolveServicePrice(SERVICES, base)).toMatchObject({ ok: true, price: { price: 619.94 } });
    expect(resolveServicePrice(SERVICES, { ...base, workName: "Разборка зданий методом обрушения" })).toBeNull();
  });

  it("объём не в тоннах (м3, 100 т) — цена за тонну не применяется", () => {
    const cubic = resolveServicePrice(SERVICES, { ...base, quantityUnit: "м3" });
    expect(cubic?.ok).toBe(false);
    expect(cubic && !cubic.ok ? cubic.reason : "").toContain("за тонну");
    expect(resolveServicePrice(SERVICES, { ...base, quantityUnit: "100 т" })?.ok).toBe(false);
  });

  it("объём не положителен — отказ", () => {
    expect(resolveServicePrice(SERVICES, { ...base, quantity: 0 })?.ok).toBe(false);
  });

  it("шифр названный, но цены нет (километр за пределом) — отказ с причиной, на наименование не переходит", () => {
    const found = resolveServicePrice(SERVICES, { ...base, serviceCode: "02-15-1-01-0049" });
    expect(found?.ok).toBe(false);
    expect(found && !found.ok ? found.reason : "").toContain("больше таблицы");
  });
});
