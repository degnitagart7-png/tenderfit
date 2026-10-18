import { describe, expect, it } from "vitest";

import { northClassOfUnit, northSubjectOf, resolveNorth, resolveNorthByText } from "@/domain/estimate/north";
import { northOfZone, resolvePriceZone, type PriceZoneRecord } from "@/domain/estimate/priceZoneResolve";
import { normalizeRegionText } from "@/domain/regions";

/*
  Районы Крайнего Севера и приравненные местности — по перечню (постановление Правительства РФ N 1946),
  data/fsnb/normatives/north.json. Тесты: Бурятия (прежние случаи), Якутия, Магаданская область,
  Иркутская область (Катангский и Бодайбинский районы), ХМАО.
*/

const words = (text: string): string[] => normalizeRegionText(text).split(" ").filter((word) => word !== "");

describe("resolveNorth: субъект целиком", () => {
  it("Якутия и Магаданская область — РКС в любом месте субъекта", () => {
    expect(resolveNorth("Республика Саха (Якутия)", words("г. Якутск"))).toEqual({ zone: "RKS", basis: "SUBJECT", matched: "Республика Саха (Якутия)" });
    expect(resolveNorth("Магаданская область", [])).toMatchObject({ zone: "RKS", basis: "SUBJECT" });
    expect(resolveNorth("Мурманская область", words("г. Мурманск"))).toMatchObject({ zone: "RKS", basis: "SUBJECT" });
  });

  it("субъекта нет в перечне — обычная территория, основание NONE", () => {
    expect(resolveNorth("Воронежская область", words("г. Воронеж"))).toEqual({ zone: "TERRITORY", basis: "NONE", matched: null });
    expect(resolveNorth(null, [])).toMatchObject({ zone: "TERRITORY", basis: "NONE" });
  });
});

describe("resolveNorth: субъект частично — по муниципалитету из текста", () => {
  it("Иркутская область: Катангский район — РКС, Бодайбинский район и Братск — МПРКС", () => {
    expect(resolveNorth("Иркутская область", words("Катангский район, с. Ербогачен"))).toMatchObject({ zone: "RKS", basis: "MUNICIPALITY", matched: "Катангский район" });
    expect(resolveNorth("Иркутская область", words("Бодайбинский район, г. Бодайбо"))).toMatchObject({ zone: "MPRKS", matched: "Бодайбинский район" });
    expect(resolveNorth("Иркутская область", words("г. Братск, ул. Мира"))).toMatchObject({ zone: "MPRKS", matched: "г. Братск" });
    expect(resolveNorth("Иркутская область", words("г. Усть-Илимск"))).toMatchObject({ zone: "MPRKS" });
  });

  it("Иркутский район (закупка 0134600012126000001) — обычная территория, муниципалитет не из перечня", () => {
    expect(resolveNorth("Иркутская область", words("Иркутская область, Иркутский район, д. Сосновый бор, ул. Мелехова, д. 4"))).toEqual({
      zone: "TERRITORY",
      basis: "UNDETERMINED",
      matched: null,
    });
  });

  it("Братский район без слова «район» — не Братск: город требует «г.» рядом, район — «района»", () => {
    expect(resolveNorthByText("Иркутская область", words("Братского района"))).toMatchObject({ matched: "Братский район" });
    expect(resolveNorthByText("Иркутская область", words("г. Братске"))).toMatchObject({ matched: "г. Братск" });
    expect(resolveNorthByText("Иркутская область", words("Братск"))).toBeNull();
  });

  it("ХМАО: «ул. Советская» — не Советский район; «Советский район» — МПРКС", () => {
    expect(resolveNorthByText("Ханты-Мансийский автономный округ — Югра", words("г. Тюмень, ул. Советская, 5"))).toBeNull();
    expect(resolveNorthByText("Ханты-Мансийский автономный округ — Югра", words("Советский район, г. Советский"))).toMatchObject({ zone: "MPRKS" });
    expect(resolveNorthByText("Ханты-Мансийский автономный округ — Югра", words("г. Сургут"))).toMatchObject({ zone: "MPRKS", matched: "г. Сургут" });
  });

  it("Бурятия, как раньше: Северобайкальск, Баунтовский, Северо-Байкальский и Муйский районы — МПРКС", () => {
    expect(resolveNorth("Республика Бурятия", words("в городе Северобайкальске"))).toMatchObject({ zone: "MPRKS" });
    expect(resolveNorth("Республика Бурятия", words("Баунтовского эвенкийского района"))).toMatchObject({ zone: "MPRKS" });
    expect(resolveNorth("Республика Бурятия", words("Северо-Байкальского района"))).toMatchObject({ zone: "MPRKS" });
    expect(resolveNorth("Республика Бурятия", words("Муйский район, п. Таксимо"))).toMatchObject({ zone: "MPRKS" });
  });

  it("Бурятия: по перечню МПРКС ещё и Баргузинский, Курумканский, Окинский районы; Кабанский — нет", () => {
    for (const district of ["Баргузинский", "Курумканский", "Окинский"]) {
      expect(northClassOfUnit("Республика Бурятия", "district", district), district).toBe("MPRKS");
    }
    expect(northClassOfUnit("Республика Бурятия", "district", "Кабанский")).toBe("TERRITORY");
    expect(northClassOfUnit("Республика Бурятия", "city", "Северобайкальск")).toBe("MPRKS");
    // Город вне перечня может лежать внутри северного района: «обычный» про него сказать нельзя.
    expect(northClassOfUnit("Республика Бурятия", "city", "Улан-Удэ")).toBeNull();
    expect(northClassOfUnit("Республика Коми", "district", "Вуктыльский")).toBe("MPRKS");
  });
});

describe("перечень: сопоставление субъектов", () => {
  it("Якутия — весь субъект РКС; Иркутская область — частично", () => {
    expect(northSubjectOf("Республика Саха (Якутия)")?.whole).toBe("RKS");
    expect(northSubjectOf("Иркутская область")?.whole).toBeNull();
    expect(northSubjectOf("Республика Хакасия")).toBeNull();
  });
});

const zone = (subjectName: string, subjectCode: string, zoneName: string, center: string, municipalities: string): PriceZoneRecord => ({
  subjectCode,
  subjectName,
  zoneName,
  center,
  municipalities,
});

describe("resolvePriceZone: северность по перечню", () => {
  const YAKUTIA = [zone("Республика Саха (Якутия)", "14", "Республика Саха (Якутия) (1 зона)", "г. Якутск", "у. Амгинский, г. Якутск")];
  const MAGADAN = [
    zone("Магаданская область", "49", "Магаданская область (1 зона)", "г. Магадан", "р-н. Ольский"),
    zone("Магаданская область", "49", "Магаданская область (2 зона)", "г. Сусуман", "р-н. Сусуманский"),
  ];
  const IRKUTSK = [
    zone("Иркутская область", "38", "Иркутская область (1 зона)", "г. Иркутск", "р-н. Иркутский, р-н. Шелеховский"),
    zone("Иркутская область", "38", "Иркутская область (4 зона)", "г. Бодайбо", "р-н. Бодайбинский, р-н. Мамско-Чуйский"),
    zone("Иркутская область", "38", "Иркутская область (6 зона)", "с. Ербогачен", "р-н. Катангский"),
  ];
  const ids = (zones: PriceZoneRecord[]): ReadonlyMap<string, number> => new Map(zones.map((item, index) => [item.zoneName, index + 100]));
  const resolve = (zones: PriceZoneRecord[], query: { region: string; address?: string }) =>
    resolvePriceZone(query, zones, [100, 101, 102], ids(zones));

  it("Якутия: одна зона, но весь субъект — РКС (раньше SINGLE_ZONE всегда давала обычную территорию)", () => {
    expect(resolve(YAKUTIA, { region: "Республика Саха (Якутия)", address: "г. Якутск" })).toMatchObject({
      basis: "SINGLE_ZONE",
      northZone: "RKS",
      northBasis: "SUBJECT",
    });
  });

  it("Магаданская область, любая зона по столице: РКС", () => {
    expect(resolve(MAGADAN, { region: "Магаданская область", address: "г. Магадан" })).toMatchObject({ northZone: "RKS", northBasis: "SUBJECT" });
  });

  it("Иркутская область: Катангский район — РКС, Бодайбинский — МПРКС, Иркутский — обычная территория", () => {
    expect(resolve(IRKUTSK, { region: "Иркутская область", address: "Катангский район, с. Ербогачен" })).toMatchObject({
      zoneName: "Иркутская область (6 зона)",
      northZone: "RKS",
      northBasis: "MUNICIPALITY",
    });
    expect(resolve(IRKUTSK, { region: "Иркутская область", address: "Бодайбинский район" })).toMatchObject({
      zoneName: "Иркутская область (4 зона)",
      northZone: "MPRKS",
    });
    expect(resolve(IRKUTSK, { region: "Иркутская область", address: "Иркутский район, д. Сосновый бор" })).toMatchObject({
      zoneName: "Иркутская область (1 зона)",
      northZone: "TERRITORY",
      // Совпал «г. Иркутск» — город вне перечня; решает зона: все её районы не из перечня.
      northBasis: "ZONE",
    });
  });

  it("зона целиком: зона 4 Иркутской (Бодайбинский и Мамско-Чуйский районы, центр Бодайбо) — МПРКС, зона 1 — обычная", () => {
    expect(northOfZone(IRKUTSK[1] as PriceZoneRecord)).toEqual({ northZone: "MPRKS", northBasis: "ZONE" });
    expect(northOfZone(IRKUTSK[2] as PriceZoneRecord)).toEqual({ northZone: "RKS", northBasis: "ZONE" });
    expect(northOfZone(IRKUTSK[0] as PriceZoneRecord)).toEqual({ northZone: "TERRITORY", northBasis: "ZONE" });
  });
});
