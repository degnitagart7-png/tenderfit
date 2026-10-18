import { describe, expect, it } from "vitest";

import {
  describeBuiltZones,
  describePriceZoneBasis,
  northZoneOfZone,
  resolvePriceZone,
  type PriceZoneRecord,
} from "@/domain/estimate/priceZoneResolve";

/*
  Зоны Бурятии — сокращённые строки настоящего price-zones.csv ФГИС ЦС: у каждой
  зоны центр и список муниципалитетов в том виде, как они там записаны (с
  префиксами «р-н.», «г.», «с.», «у.»), чтобы разбор ловил реальные
  формулировки. Списки урезаны до тех названий, на которых стоят проверки.
*/

function zone(n: number, center: string, municipalities: string): PriceZoneRecord {
  return {
    subjectCode: "3",
    subjectName: "Республика Бурятия",
    zoneName: `Республика Бурятия (${String(n)} зона)`,
    center,
    municipalities,
  };
}

const BURYATIA: PriceZoneRecord[] = [
  zone(1, "с. Орлик", "р-н. Окинский, п. Боксон, с. Орлик, у. Сорок, у. Хурга"),
  zone(2, "с. Кырен", "р-н. Тункинский, п. Аршан, с. Никольск, с. Тунка, у. Далахай"),
  zone(3, "с. Петропавловка", "р-н. Джидинский, р-н. Закаменский, г. Закаменск, с. Петропавловка"),
  zone(4, "г. Гусиноозерск", "р-н. Бичурский, р-н. Кяхтинский, г. Гусиноозерск, г. Кяхта, п. Ардасан, с. Никольск, с. Петропавловка, п. Арда"),
  zone(
    5,
    "г. Улан-Удэ",
    "р-н. Заиграевский, р-н. Иволгинский, р-н. Кабанский, р-н. Прибайкальский, р-н. Тарбагатайский, г. Бабушкин, г. Улан-Удэ, пгт. Заиграево, п. Лесной, с. Кабанск, с. Никольск, с. Петропавловка, п/ст. Хужир ,п. Усановка",
  ),
  zone(6, "с. Хоринск", "р-н. Еравнинский, р-н. Кижингинский, р-н. Хоринский, с. Кижинга"),
  zone(7, "с. Курумкан", "р-н. Баргузинский, р-н. Баунтовский эвенкийский, р-н. Курумканский, п. Баунт"),
  zone(8, "пгт. Новый Уоян", "р-н. Муйский, р-н. Северо-Байкальский, г. Северобайкальск, пгт. Нижнеангарск, пгт. Новый Уоян"),
];

const KALMYKIA: PriceZoneRecord = {
  subjectCode: "8",
  subjectName: "Республика Калмыкия",
  zoneName: "Республика Калмыкия",
  center: "г. Элиста",
  municipalities: "",
};

const AMUR: PriceZoneRecord[] = [
  {
    subjectCode: "28",
    subjectName: "Амурская область",
    zoneName: "Амурская область (1 зона)",
    center: "г. Благовещенск",
    municipalities: "р-н. Архаринский, р-н. Белогорский, р-н. Благовещенский",
  },
  {
    subjectCode: "28",
    subjectName: "Амурская область",
    zoneName: "Амурская область (2 зона)",
    center: "г. Тында",
    municipalities: "р-н. Зейский, р-н. Селемджинский, р-н. Тындинский",
  },
];

const ZONES = [...BURYATIA, KALMYKIA, ...AMUR];

const IDS = new Map<string, number>([
  ...BURYATIA.map((z, i) => [z.zoneName, 232 + i] as const),
  [KALMYKIA.zoneName, 50],
  ["Амурская область (1 зона)", 282],
  ["Амурская область (2 зона)", 283],
]);

const ALL_BURYATIA = [232, 233, 234, 235, 236, 237, 238, 239];

function resolve(
  query: Parameters<typeof resolvePriceZone>[0],
  built: readonly number[] = ALL_BURYATIA,
) {
  return resolvePriceZone(query, ZONES, built, IDS);
}

const BUR = "Республика Бурятия";

describe("resolvePriceZone: одна зона у субъекта", () => {
  it("SINGLE_ZONE: у Калмыкии одна зона, муниципалитеты не нужны", () => {
    const result = resolve({ region: "Республика Калмыкия" }, [50]);

    expect(result).toMatchObject({
      priceZoneId: 50,
      zoneName: "Республика Калмыкия",
      subject: "Республика Калмыкия",
      basis: "SINGLE_ZONE",
      matched: null,
      built: true,
      northZone: "TERRITORY",
      alternatives: [],
    });
  });

  it("зона не собрана: идентификатор известен, built — false", () => {
    const result = resolve({ region: "Калмыкия" }, [232]);

    expect(result.priceZoneId).toBe(50);
    expect(result.built).toBe(false);
  });

  it("регион можно назвать коротко: «Бурятия» и «Республика Бурятия» — одно и то же", () => {
    expect(resolve({ region: "Бурятия", address: "Кабанский район" }).zoneName).toBe("Республика Бурятия (5 зона)");
  });
});

describe("resolvePriceZone: муниципалитет", () => {
  it.each([
    ["р-н. Кабанский"],
    ["Кабанского района"],
    ["Кабанский район"],
    ["Республика Бурятия, Кабанском районе, 671200"],
    ["КАБАНСКИЙ РАЙОН"],
  ])("«%s» → Кабанский р-н, зона 5", (address) => {
    const result = resolve({ region: BUR, address });

    expect(result.basis).toBe("MUNICIPALITY");
    expect(result.matched).toBe("Кабанский р-н");
    expect(result.zoneName).toBe("Республика Бурятия (5 зона)");
    expect(result.priceZoneId).toBe(236);
    expect(result.northZone).toBe("TERRITORY");
  });

  it.each([["г. Северобайкальск"], ["Северобайкальска"], ["в городе Северобайкальске"]])(
    "«%s» → г. Северобайкальск, зона 8, Север",
    (address) => {
      const result = resolve({ region: BUR, address });

      expect(result).toMatchObject({
        basis: "MUNICIPALITY",
        matched: "г. Северобайкальск",
        zoneName: "Республика Бурятия (8 зона)",
        northZone: "MPRKS",
      });
    },
  );

  it("слова из названия района склоняются все: «Баунтовского эвенкийского района»", () => {
    const result = resolve({ region: BUR, address: "Баунтовского эвенкийского района" });

    expect(result).toMatchObject({ zoneName: "Республика Бурятия (7 зона)", matched: "Баунтовский эвенкийский р-н", northZone: "MPRKS" });
  });

  it("«Северо-Байкальский район» и «Муйский район» — Север", () => {
    expect(resolve({ region: BUR, address: "Северо-Байкальского района" })).toMatchObject({ northZone: "MPRKS", zoneName: "Республика Бурятия (8 зона)" });
    expect(resolve({ region: BUR, address: "Муйский район, п. Таксимо" })).toMatchObject({ northZone: "MPRKS", matched: "Муйский р-н" });
  });

  it("населённый пункт зоны 8 — Север по всей зоне", () => {
    expect(resolve({ region: BUR, address: "пгт. Нижнеангарск" })).toMatchObject({
      basis: "MUNICIPALITY",
      zoneName: "Республика Бурятия (8 зона)",
      northZone: "MPRKS",
    });
  });

  /*
    Перечень Севера — постановление Правительства РФ от 16.11.2021 N 1946 (data/fsnb/normatives/north.json):
    в Бурятии это Северобайкальск и шесть районов, среди них Баргузинский, Курумканский и Окинский.
    Прежний ручной список (четыре записи) их пропускал; тест Курумкана менялся вместе с данными.
  */
  it("Курумкан (зона 7): район Курумканский — МПРКС по перечню, поэтому и зона из трёх районов перечня — МПРКС", () => {
    expect(resolve({ region: BUR, address: "с. Курумкан" })).toMatchObject({ zoneName: "Республика Бурятия (7 зона)", northZone: "MPRKS" });
  });

  it("«Кабанский район» (зона 5) — обычная территория: районов нет в перечне Бурятии", () => {
    expect(resolve({ region: BUR, address: "Кабанский район" })).toMatchObject({ zoneName: "Республика Бурятия (5 зона)", northZone: "TERRITORY" });
  });

  it("муниципалитет ищется и в названии заказчика, и в дополнительном тексте", () => {
    expect(resolve({ region: BUR, address: "Не указан", customerName: "Администрация МО «Тарбагатайский район»" }).matched).toBe("Тарбагатайский р-н");
    expect(resolve({ region: BUR, extraText: "Выполнение работ в с. Кижинга" })).toMatchObject({ zoneName: "Республика Бурятия (6 зона)" });
  });

  it("ё и е — одно и то же", () => {
    const zones = [{ ...zone(1, "г. Орёл", "г. Орёл, с. Тёплое"), subjectName: "Республика Бурятия" }, zone(2, "г. Ёлка", "с. Берёзовка")];
    const ids = new Map([[zones[0]!.zoneName, 1], [zones[1]!.zoneName, 2]]);
    const result = resolvePriceZone({ region: BUR, address: "село Березовка" }, zones, [1, 2], ids);

    expect(result.basis).toBe("MUNICIPALITY");
    expect(result.matched).toBe("с. Берёзовка");
  });

  it("совпали две зоны — берётся та, где совпадение длиннее", () => {
    // «Тункинский район» (зона 2) длиннее, чем «с. Никольск», которое есть в зонах 2, 4 и 5.
    const result = resolve({ region: BUR, address: "Тункинский район, с. Никольск" });

    expect(result).toMatchObject({ basis: "MUNICIPALITY", zoneName: "Республика Бурятия (2 зона)" });
  });

  it("при равенстве совпадений MUNICIPALITY не применяется: «с. Никольск» есть в трёх зонах", () => {
    const result = resolve({ region: BUR, address: "с. Никольск" });

    expect(result.basis).not.toBe("MUNICIPALITY");
    expect(result.basis).toBe("CAPITAL");
  });
});

describe("resolvePriceZone: короткие имена не сопоставляются", () => {
  it.each([["улус Сорок"], ["п. Арда"], ["у. Хурга"], ["п. Лесной"], ["п. Баунт"]])(
    "«%s» не находит зону: слишком много ложных совпадений",
    (address) => {
      const result = resolve({ region: BUR, address });

      expect(result.basis).toBe("CAPITAL");
      expect(result.zoneName).toBe("Республика Бурятия (5 зона)");
    },
  );

  it("но город с коротким корнем (г. Кяхта) находится", () => {
    expect(resolve({ region: BUR, address: "г. Кяхта" })).toMatchObject({ basis: "MUNICIPALITY", zoneName: "Республика Бурятия (4 зона)" });
  });

  it("слово, лишь начинающееся с основы, не совпадение: «Кабанскиеполя»", () => {
    expect(resolve({ region: BUR, address: "Кабанскиеполя" }).basis).toBe("CAPITAL");
  });
});

describe("resolvePriceZone: столица субъекта", () => {
  it("CAPITAL: адрес не назван — зона с Улан-Удэ, и всегда не Север", () => {
    const result = resolve({ region: BUR, address: "Не указан" });

    expect(result).toMatchObject({
      basis: "CAPITAL",
      matched: "Улан-Удэ",
      zoneName: "Республика Бурятия (5 зона)",
      northZone: "TERRITORY",
      built: true,
    });
  });

  it("если сама зона столицы не собрана — built false, остальные собранные в alternatives", () => {
    const result = resolve({ region: BUR }, [237, 239]);

    expect(result.built).toBe(false);
    expect(result.priceZoneId).toBe(236);
    expect(result.alternatives).toEqual([
      { priceZoneId: 237, zoneName: "Республика Бурятия (6 зона)" },
      { priceZoneId: 239, zoneName: "Республика Бурятия (8 зона)" },
    ]);
  });

  it("alternatives — собранные зоны того же субъекта, без выбранной и без чужих субъектов", () => {
    const result = resolve({ region: BUR, address: "г. Северобайкальск" }, [236, 239, 282]);

    expect(result.priceZoneId).toBe(239);
    expect(result.alternatives).toEqual([{ priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)" }]);
  });

  it("Амурская область без адреса — зона Благовещенска (столицы нет в REGION_CAPITALS, но для зон она задана)", () => {
    const result = resolve({ region: "Амурская область", address: "Не указан" }, [282]);

    expect(result).toMatchObject({ priceZoneId: 282, basis: "CAPITAL", matched: "Благовещенск", built: true });
  });

  it("короткая столица («Чита») находится по центру зоны, хотя порог основы отсекает её в списке", () => {
    const zab = (n: number, center: string, municipalities: string): PriceZoneRecord => ({
      subjectCode: "75",
      subjectName: "Забайкальский край",
      zoneName: `Забайкальский край (${String(n)} зона)`,
      center,
      municipalities,
    });
    const zones = [zab(1, "г. Чита", "р-н. Агинский, р-н. Читинский"), zab(2, "пгт. Новая Чара", "р-н. Каларский")];
    const ids = new Map([
      ["Забайкальский край (1 зона)", 280],
      ["Забайкальский край (2 зона)", 281],
    ]);

    expect(resolvePriceZone({ region: "Забайкальский край", address: "Не указан" }, zones, [280, 281], ids)).toMatchObject({
      priceZoneId: 280,
      basis: "CAPITAL",
      matched: "Чита",
    });
  });

  it("Амурская область: район из списка находит зону", () => {
    expect(resolve({ region: "Амурская область", address: "Тындинский район" }, [282, 283])).toMatchObject({
      priceZoneId: 283,
      basis: "MUNICIPALITY",
      matched: "Тындинский р-н",
    });
  });
});

describe("resolvePriceZone: субъект не определён", () => {
  it("UNKNOWN_REGION: регион «Не указан» и адрес без региона", () => {
    expect(resolve({ region: "Не указан", address: "Не указан" })).toMatchObject({
      basis: "UNKNOWN_REGION",
      priceZoneId: null,
      zoneName: null,
      subject: null,
      built: false,
      northZone: "TERRITORY",
    });
  });

  it("регион пустой — тоже неизвестен", () => {
    expect(resolve({ region: "" }).basis).toBe("UNKNOWN_REGION");
  });

  it("регион в базе не определён, но адрес назвал субъект — он принимается", () => {
    const result = resolve({ region: "Не указан", address: "Республика Бурятия, с. Кабанск" });

    expect(result).toMatchObject({ basis: "MUNICIPALITY", subject: BUR });
  });

  it("регион назван, но зон у него нет в справочнике — по адресу не переопределяется", () => {
    const result = resolve({ region: "Калининградская область", address: "Республика Бурятия, Кабанский район" });

    expect(result.basis).toBe("UNKNOWN_REGION");
    expect(result.subject).toBeNull();
  });
});

describe("подписи", () => {
  it("основание выбора зоны словами", () => {
    expect(describePriceZoneBasis({ basis: "MUNICIPALITY", matched: "Кабанский р-н" })).toBe("по муниципалитету: Кабанский р-н");
    expect(describePriceZoneBasis({ basis: "CAPITAL", matched: "Улан-Удэ" })).toBe("по столице субъекта");
    expect(describePriceZoneBasis({ basis: "USER", matched: null })).toBe("выбрана вручную");
    expect(describePriceZoneBasis({ basis: "SINGLE_ZONE", matched: null })).toBe("в субъекте одна зона");
    expect(describePriceZoneBasis({ basis: "CUSTOMER_PRICES", matched: "1-100-31, 4-100-040" })).toBe("по ценам сметы заказчика");
    expect(describePriceZoneBasis({ basis: "UNKNOWN_REGION", matched: null })).toBe("регион закупки не определён");
  });

  it("собранные зоны одной фразой: подряд — диапазон, остальные перечислены", () => {
    const zone = (subject: string, name: string) => ({ subject, zoneName: name });
    expect(
      describeBuiltZones([
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => zone(BUR, `Республика Бурятия (${String(n)} зона)`)),
        zone("Амурская область", "Амурская область (1 зона)"),
      ]),
    ).toBe("Республика Бурятия (1–8 зона), Амурская область (1 зона)");
    expect(describeBuiltZones([1, 3, 4, 5, 8].map((n) => zone(BUR, `Республика Бурятия (${String(n)} зона)`)))).toBe(
      "Республика Бурятия (1, 3–5, 8 зона)",
    );
    expect(describeBuiltZones([zone("Республика Калмыкия", "Республика Калмыкия")])).toBe("Республика Калмыкия");
    expect(describeBuiltZones([])).toBe("ни одной");
  });
});

describe("northZoneOfZone: северность зоны целиком", () => {
  const north = (n: number) => BURYATIA[n - 1]!;

  it("зона 8: все районы и города — из таблицы Севера → MPRKS; посёлки внутри не меняют вывода", () => {
    expect(northZoneOfZone(north(8))).toBe("MPRKS");
  });

  it("зона 7: Баунтовский, Баргузинский, Курумканский — все районы в перечне → MPRKS", () => {
    expect(northZoneOfZone(north(7))).toBe("MPRKS");
  });

  it("зона 1: единственный район (Окинский) в перечне → MPRKS; остальные зоны 2–6 — обычная территория", () => {
    expect(northZoneOfZone(north(1))).toBe("MPRKS");
    for (const n of [2, 3, 4, 5, 6]) expect(northZoneOfZone(north(n))).toBe("TERRITORY");
  });

  it("зона без районов и городов (одни посёлки) и пустая зона — обычная территория", () => {
    expect(northZoneOfZone(zone(1, "п. Горный", "п. Лесной, с. Орлик"))).toBe("TERRITORY");
    expect(northZoneOfZone({ ...KALMYKIA })).toBe("TERRITORY");
  });

  it("одна зона из одного северного района — MPRKS; добавь обычный район — TERRITORY", () => {
    expect(northZoneOfZone(zone(1, "пгт. Новый Уоян", "р-н. Муйский"))).toBe("MPRKS");
    expect(northZoneOfZone(zone(1, "пгт. Новый Уоян", "р-н. Муйский, р-н. Кабанский"))).toBe("TERRITORY");
  });
});
