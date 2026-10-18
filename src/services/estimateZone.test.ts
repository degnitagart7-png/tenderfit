import { describe, expect, it } from "vitest";

import type { PriceZoneRecord } from "@/domain/estimate/priceZoneResolve";
import { chooseEstimateZone, EstimatePriceZoneError, fingerprintCandidateZones, type BuiltZoneRef } from "@/services/estimateZone";

/*
  Выбор зоны перед расчётом: пользователь, закупка, отказ с объяснением. Зоны —
  сокращённые строки настоящего price-zones.csv.
*/

const zone = (n: number, center: string, municipalities: string): PriceZoneRecord => ({
  subjectCode: "3",
  subjectName: "Республика Бурятия",
  zoneName: `Республика Бурятия (${String(n)} зона)`,
  center,
  municipalities,
});

const ZONES: PriceZoneRecord[] = [
  zone(5, "г. Улан-Удэ", "р-н. Кабанский, г. Улан-Удэ"),
  zone(8, "пгт. Новый Уоян", "р-н. Муйский, г. Северобайкальск"),
  zone(3, "с. Петропавловка", "р-н. Джидинский"),
  zone(7, "с. Курумкан", "р-н. Баргузинский, р-н. Баунтовский эвенкийский, р-н. Курумканский, п. Баунт"),
  { subjectCode: "8", subjectName: "Республика Калмыкия", zoneName: "Республика Калмыкия", center: "г. Элиста", municipalities: "" },
  { subjectCode: "28", subjectName: "Амурская область", zoneName: "Амурская область (1 зона)", center: "г. Благовещенск", municipalities: "р-н. Архаринский" },
  { subjectCode: "28", subjectName: "Амурская область", zoneName: "Амурская область (2 зона)", center: "г. Тында", municipalities: "р-н. Зейский" },
];

const bur = (id: number, n: number): BuiltZoneRef => ({ priceZoneId: id, zoneName: `Республика Бурятия (${String(n)} зона)`, subject: "Республика Бурятия" });
const BUILT: BuiltZoneRef[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => bur(231 + n, n)),
  { priceZoneId: 282, zoneName: "Амурская область (1 зона)", subject: "Амурская область" },
];

function message(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(EstimatePriceZoneError);
    return (error as Error).message;
  }
  throw new Error("ожидался отказ");
}

describe("chooseEstimateZone: зона не собрана", () => {
  it("Калмыкия не собрана — сообщение называет зону, собранное и ручной выбор", () => {
    const text = message(() =>
      chooseEstimateZone({ tender: { region: "Республика Калмыкия", address: "Не указан", customerName: "" }, zones: ZONES, built: BUILT }),
    );

    expect(text).toBe(
      "Цен по зоне «Республика Калмыкия» ещё нет. Собраны: Республика Бурятия (1–8 зона), Амурская область (1 зона). Можно выбрать зону вручную.",
    );
  });

  it("зона субъекта по муниципалитету есть в справочнике, но цены не собраны", () => {
    const built = BUILT.filter((zone) => zone.priceZoneId !== 234);
    const text = message(() =>
      chooseEstimateZone({ tender: { region: "Республика Бурятия", address: "Джидинский район" }, zones: ZONES, built }),
    );

    expect(text).toContain("Цен по зоне «Республика Бурятия (3 зона)» ещё нет.");
    expect(text).toContain("Республика Бурятия (1, 2, 4–8 зона)");
  });

  it("ничего не собрано: «ни одной»", () => {
    const text = message(() =>
      chooseEstimateZone({ tender: { region: "Республика Калмыкия" }, zones: ZONES, built: [] }),
    );
    expect(text).toContain("Собраны: ни одной.");
  });
});

describe("chooseEstimateZone: зона не определяется", () => {
  it("регион закупки неизвестен", () => {
    const text = message(() =>
      chooseEstimateZone({ tender: { region: "Не указан", address: "Не указан", customerName: "ООО Ромашка" }, zones: ZONES, built: BUILT }),
    );

    expect(text).toContain("Регион закупки не определён");
    expect(text).toContain("Можно выбрать зону вручную.");
  });

  it("расчёт по присланным документам без закупки — тоже нужна ручная зона", () => {
    expect(message(() => chooseEstimateZone({ tender: null, zones: ZONES, built: BUILT }))).toContain("Регион закупки не определён");
  });

  it("у субъекта несколько зон и выбрать не по чему (зоны со столицей в списке нет)", () => {
    const withoutCapital = ZONES.filter((item) => item.zoneName !== "Республика Бурятия (5 зона)");
    const text = message(() =>
      chooseEstimateZone({ tender: { region: "Республика Бурятия", address: "Не указан" }, zones: withoutCapital, built: BUILT }),
    );

    expect(text).toContain("внутри субъекта «Республика Бурятия»");
    expect(text).toContain("Можно выбрать зону вручную.");
  });

  it("Амурская область без адреса — 1 зона по столице, а не отказ", () => {
    const choice = chooseEstimateZone({ tender: { region: "Амурская область", address: "Не указан" }, zones: ZONES, built: BUILT });

    expect(choice).toMatchObject({ priceZoneId: 282, basis: "CAPITAL", matched: "Благовещенск" });
  });
});

describe("chooseEstimateZone: выбор", () => {
  it("MUNICIPALITY и Север: Северобайкальск — зона 8, нормативы для МПРКС", () => {
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "г. Северобайкальск, ул. Мира", customerName: "" },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toMatchObject({ priceZoneId: 239, basis: "MUNICIPALITY", matched: "г. Северобайкальск", northZone: "MPRKS" });
  });

  it("CAPITAL: адрес «Не указан» — столица, зона 5", () => {
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "Не указан", customerName: "Администрация" },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toMatchObject({ priceZoneId: 236, basis: "CAPITAL", matched: "Улан-Удэ", northZone: "TERRITORY" });
  });

  it("SINGLE_ZONE: Калмыкия, когда она собрана", () => {
    const built = [...BUILT, { priceZoneId: 50, zoneName: "Республика Калмыкия", subject: "Республика Калмыкия" }];
    expect(chooseEstimateZone({ tender: { region: "Республика Калмыкия" }, zones: ZONES, built })).toMatchObject({
      priceZoneId: 50,
      basis: "SINGLE_ZONE",
    });
  });

  it("USER: зона, выбранная вручную, важнее закупки — даже чужого региона", () => {
    const choice = chooseEstimateZone({
      userPriceZoneId: 282,
      tender: { region: "Республика Бурятия", address: "г. Северобайкальск" },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toEqual({
      priceZoneId: 282,
      basis: "USER",
      matched: null,
      northZone: "TERRITORY",
      northBasis: "ZONE",
      zoneName: "Амурская область (1 зона)",
    });
  });

  it("USER: выбор возможен и без закупки, и без региона", () => {
    expect(chooseEstimateZone({ userPriceZoneId: 236, tender: null, zones: ZONES, built: BUILT }).basis).toBe("USER");
  });

  it("USER: выбрана несобранная зона — отказ, а не молчаливая подмена", () => {
    const text = message(() => chooseEstimateZone({ userPriceZoneId: 999, tender: null, zones: ZONES, built: BUILT }));

    expect(text).toBe("Цен по ценовой зоне 999 ещё нет. Собраны: Республика Бурятия (1–8 зона), Амурская область (1 зона).");
  });
});

describe("chooseEstimateZone: зона Севера при ручном выборе", () => {
  it("по закупке определилась та же зона — берётся её северность и совпавшее название", () => {
    const choice = chooseEstimateZone({
      userPriceZoneId: 239,
      tender: { region: "Республика Бурятия", address: "г. Северобайкальск, ул. Мира" },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toEqual({
      priceZoneId: 239,
      basis: "USER",
      matched: "г. Северобайкальск",
      northZone: "MPRKS",
      northBasis: "MUNICIPALITY",
      zoneName: "Республика Бурятия (8 зона)",
    });
  });

  it("то же в смешанной зоне: Баунтовский район (7 зона) — Север, потому что закупка называет его", () => {
    const choice = chooseEstimateZone({
      userPriceZoneId: 238,
      tender: { region: "Республика Бурятия", address: "Баунтовского эвенкийского района" },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toMatchObject({ basis: "USER", matched: "Баунтовский эвенкийский р-н", northZone: "MPRKS" });
  });

  it("закупка зону не определила — северность зоны целиком: зона 8 вся из районов Севера → MPRKS", () => {
    for (const tender of [null, { region: "Не указан" }, { region: "Республика Калмыкия" }]) {
      const choice = chooseEstimateZone({ userPriceZoneId: 239, tender, zones: ZONES, built: BUILT });

      expect(choice).toMatchObject({ basis: "USER", matched: null, northZone: "MPRKS" });
    }
  });

  it("закупка указывает на другую зону — северность выбранной зоны, а не закупки", () => {
    const choice = chooseEstimateZone({
      userPriceZoneId: 239,
      tender: { region: "Республика Бурятия", address: "Кабанский район" },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toMatchObject({ priceZoneId: 239, matched: null, northZone: "MPRKS" });
  });

  it("зона 7 (три района перечня) без указания района — МПРКС, обычная зона (5) — обычная территория", () => {
    expect(chooseEstimateZone({ userPriceZoneId: 238, tender: null, zones: ZONES, built: BUILT }).northZone).toBe("MPRKS");
    expect(chooseEstimateZone({ userPriceZoneId: 236, tender: null, zones: ZONES, built: BUILT }).northZone).toBe("TERRITORY");
  });

  it("ручной выбор зоны 5 совпал с зоной по столице: основание остаётся USER, название — Улан-Удэ, не Север", () => {
    const choice = chooseEstimateZone({
      userPriceZoneId: 236,
      tender: { region: "Республика Бурятия", address: "Не указан" },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toMatchObject({ basis: "USER", matched: "Улан-Удэ", northZone: "TERRITORY" });
  });

  it("зоны нет в справочнике зон — обычная территория, а не догадка", () => {
    const choice = chooseEstimateZone({ userPriceZoneId: 282, tender: null, zones: [], built: BUILT });
    expect(choice.northZone).toBe("TERRITORY");
  });
});

describe("chooseEstimateZone: справочник зон ФГИС ЦС и сборка по требованию", () => {
  /** Справочник знает все зоны: Бурятия 232–239, Амурская 282, Калмыкия 50; на диске — только часть. */
  const DIRECTORY = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ priceZoneId: 231 + n, zoneName: `Республика Бурятия (${String(n)} зона)` })),
    { priceZoneId: 282, zoneName: "Амурская область (1 зона)" },
    { priceZoneId: 283, zoneName: "Амурская область (2 зона)" },
    { priceZoneId: 50, zoneName: "Республика Калмыкия" },
  ];

  it("не собранная зона закупки (Калмыкия) со справочником — не отказ, а выбор с built: false", () => {
    const choice = chooseEstimateZone({
      tender: { region: "Республика Калмыкия", address: "Не указан", customerName: "" },
      zones: ZONES,
      built: BUILT,
      directory: DIRECTORY,
    });

    expect(choice).toEqual({ priceZoneId: 50, basis: "SINGLE_ZONE", matched: null, northZone: "TERRITORY", northBasis: "NONE", zoneName: "Республика Калмыкия", built: false });
  });

  it("зона по муниципалитету не собрана (Джидинский район — 3 зона, 234): тоже built: false, основание сохранено", () => {
    const built = BUILT.filter((zone) => zone.priceZoneId !== 234);
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "Джидинский район" },
      zones: ZONES,
      built,
      directory: DIRECTORY,
    });

    expect(choice).toMatchObject({ priceZoneId: 234, basis: "MUNICIPALITY", built: false });
  });

  it("зона выбрана вручную и не собрана, но есть в справочнике — built: false с названием из справочника", () => {
    const choice = chooseEstimateZone({ userPriceZoneId: 283, tender: null, zones: ZONES, built: BUILT, directory: DIRECTORY });

    // Тында и Зейский район — МПРКС по перечню (постановление Правительства РФ N 1946).
    expect(choice).toEqual({ priceZoneId: 283, basis: "USER", matched: null, northZone: "MPRKS", northBasis: "ZONE", zoneName: "Амурская область (2 зона)", built: false });
  });

  it("собранная зона со справочником выбирается как раньше: поля built нет, результат тот же", () => {
    const withDirectory = chooseEstimateZone({ tender: { region: "Амурская область", address: "Не указан" }, zones: ZONES, built: BUILT, directory: DIRECTORY });
    const without = chooseEstimateZone({ tender: { region: "Амурская область", address: "Не указан" }, zones: ZONES, built: BUILT });

    expect(withDirectory).toEqual(without);
    expect(withDirectory).not.toHaveProperty("built");
  });

  it("зоны нет и в справочнике — отказ прежний, с перечнем собранных", () => {
    const text = message(() => chooseEstimateZone({ userPriceZoneId: 999, tender: null, zones: ZONES, built: BUILT, directory: DIRECTORY }));

    expect(text).toBe("Цен по ценовой зоне 999 ещё нет. Собраны: Республика Бурятия (1–8 зона), Амурская область (1 зона).");
  });

  it("регион не определён — справочник не помогает: отказ прежний", () => {
    const text = message(() => chooseEstimateZone({ tender: { region: "Не указан", address: "Не указан" }, zones: ZONES, built: BUILT, directory: DIRECTORY }));

    expect(text).toContain("Регион закупки не определён");
  });

  it("справочник null (не удалось получить) — как без него: не собранная зона отказывает", () => {
    const text = message(() =>
      chooseEstimateZone({ tender: { region: "Республика Калмыкия" }, zones: ZONES, built: BUILT, directory: null }),
    );

    expect(text).toContain("Цен по зоне «Республика Калмыкия» ещё нет.");
  });
});

describe("chooseEstimateZone: зона из сметы заказчика", () => {
  const declared5 = { subject: "Республика Бурятия", zoneName: "Республика Бурятия (5 зона)", zoneNumber: 5 };
  /** Собраны только 1 и 5 зоны Бурятии. */
  const BUILT_1_5 = [bur(232, 1), bur(236, 5)];
  /** Закупка по Джидинскому району — по ней вышла бы 3 зона, которой на диске нет. */
  const JIDA = { region: "Республика Бурятия", address: "Джидинский район", customerName: "" };

  it("ЛСР заказчика (5 зона) и регион Бурятия: берётся 5 зона, основание CUSTOMER_ESTIMATE", () => {
    const choice = chooseEstimateZone({ tender: JIDA, declared: declared5, zones: ZONES, built: BUILT_1_5 });

    expect(choice).toEqual({
      priceZoneId: 236,
      basis: "CUSTOMER_ESTIMATE",
      matched: null,
      northZone: "TERRITORY",
      northBasis: "ZONE",
      zoneName: "Республика Бурятия (5 зона)",
    });
  });

  it("сметы заказчика важнее определения по закупке: закупка указала бы другую собранную зону", () => {
    // По столице вышла бы 5 зона, заказчик считал в 1 — берётся 1.
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "Не указан" },
      declared: { subject: "Республика Бурятия", zoneName: "Республика Бурятия (1 зона)", zoneNumber: 1 },
      zones: ZONES,
      built: BUILT_1_5,
    });

    expect(choice).toMatchObject({ priceZoneId: 232, basis: "CUSTOMER_ESTIMATE" });
  });

  it("ручной выбор важнее сметы заказчика: зона 1 остаётся, основание USER", () => {
    const choice = chooseEstimateZone({ userPriceZoneId: 232, tender: JIDA, declared: declared5, zones: ZONES, built: BUILT_1_5 });

    expect(choice).toMatchObject({ priceZoneId: 232, basis: "USER" });
    expect(choice).not.toHaveProperty("notes");
  });

  it("сметы без названия зоны в шапке не мешают: закупка решает, как раньше", () => {
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "Не указан" },
      declared: { subject: null, zoneName: null, zoneNumber: null },
      zones: ZONES,
      built: BUILT_1_5,
    });

    expect(choice).toMatchObject({ priceZoneId: 236, basis: "CAPITAL" });
    expect(choice).not.toHaveProperty("notes");
  });

  it("субъект сметы не тот, что у закупки: смета сильнее поля «регион» — считаем в зоне сметы, расхождение в notes", () => {
    const zones = [
      ...ZONES,
      { subjectCode: "38", subjectName: "Иркутская область", zoneName: "Иркутская область (1 зона)", center: "г. Иркутск", municipalities: "" },
    ];
    const built = [...BUILT_1_5, { priceZoneId: 100, zoneName: "Иркутская область (1 зона)", subject: "Иркутская область" }];
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "Не указан" },
      declared: { subject: "Иркутская область", zoneName: "Иркутская область (1 зона)", zoneNumber: 1 },
      zones,
      built,
    });

    expect(choice).toMatchObject({ priceZoneId: 100, basis: "CUSTOMER_ESTIMATE", zoneName: "Иркутская область (1 зона)" });
    expect(choice.notes).toEqual([
      "Регион закупки «Республика Бурятия», смета заказчика составлена в зоне «Иркутская область (1 зона)» — считаем в зоне сметы.",
    ]);
  });

  it("закупка 32616409061: регион закупки «город Москва» (регистрация заказчика), смета — Сахалинская область (1 зона): считается Сахалин", () => {
    const zones = [
      ...ZONES,
      { subjectCode: "77", subjectName: "город Москва", zoneName: "город Москва", center: "г. Москва", municipalities: "" },
      { subjectCode: "65", subjectName: "Сахалинская область", zoneName: "Сахалинская область (1 зона)", center: "г. Южно-Сахалинск", municipalities: "" },
    ];
    const built = [
      ...BUILT_1_5,
      { priceZoneId: 77, zoneName: "город Москва", subject: "город Москва" },
      { priceZoneId: 65, zoneName: "Сахалинская область (1 зона)", subject: "Сахалинская область" },
    ];
    const choice = chooseEstimateZone({
      tender: { region: "город Москва", address: "Не указан", customerName: "ГБУ" },
      declared: { subject: "Сахалинская область", zoneName: "Сахалинская область (1 зона)", zoneNumber: 1 },
      zones,
      built,
    });

    // Северность — по субъекту сметы (Сахалин — МПРКС), а не по региону закупки.
    expect(choice).toMatchObject({ priceZoneId: 65, basis: "CUSTOMER_ESTIMATE", northZone: "MPRKS" });
    expect(choice.notes?.[0]).toContain("Регион закупки «город Москва»");
    expect(choice.notes?.[0]).toContain("считаем в зоне сметы");
  });

  it("зона сметы другого субъекта не собрана и справочника нет — отказ с перечнем собранных, а не тихий расчёт в чужом регионе", () => {
    const zones = [
      ...ZONES,
      { subjectCode: "65", subjectName: "Сахалинская область", zoneName: "Сахалинская область (1 зона)", center: "г. Южно-Сахалинск", municipalities: "" },
    ];
    const text = message(() =>
      chooseEstimateZone({
        tender: { region: "Республика Бурятия", address: "Не указан" },
        declared: { subject: "Сахалинская область", zoneName: "Сахалинская область (1 зона)", zoneNumber: 1 },
        zones,
        built: BUILT_1_5,
      }),
    );
    expect(text).toContain("Смета заказчика составлена в зоне «Сахалинская область (1 зона)»");
  });

  it("закупки нет (присланные документы): зона заказчика берётся без сверки региона", () => {
    const choice = chooseEstimateZone({ tender: null, declared: declared5, zones: ZONES, built: BUILT_1_5 });

    expect(choice).toMatchObject({ priceZoneId: 236, basis: "CUSTOMER_ESTIMATE" });
  });

  it("регион закупки не определён: зона заказчика берётся — раньше расчёт отказывал", () => {
    const choice = chooseEstimateZone({ tender: { region: "Не указан", address: "Не указан" }, declared: declared5, zones: ZONES, built: BUILT_1_5 });

    expect(choice).toMatchObject({ priceZoneId: 236, basis: "CUSTOMER_ESTIMATE" });
  });

  it("зона без номера («Республика Калмыкия») находится по субъекту", () => {
    const built = [...BUILT, { priceZoneId: 50, zoneName: "Республика Калмыкия", subject: "Республика Калмыкия" }];
    const choice = chooseEstimateZone({
      tender: { region: "Республика Калмыкия" },
      declared: { subject: "Республика Калмыкия", zoneName: "Республика Калмыкия", zoneNumber: null },
      zones: ZONES,
      built,
    });

    expect(choice).toMatchObject({ priceZoneId: 50, basis: "CUSTOMER_ESTIMATE", zoneName: "Республика Калмыкия" });
  });

  it("у субъекта несколько зон, а в смете только субъект: неоднозначно — зона не используется", () => {
    const choice = chooseEstimateZone({
      tender: { region: "Амурская область", address: "Не указан" },
      declared: { subject: "Амурская область", zoneName: null, zoneNumber: null },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toMatchObject({ priceZoneId: 282, basis: "CAPITAL" });
    expect(choice.notes?.[0]).toContain("неоднозначно");
  });

  it("зоны заказчика нет среди зон: note, расчёт идёт по закупке", () => {
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "Не указан" },
      declared: { subject: "Республика Бурятия", zoneName: "Республика Бурятия (9 зона)", zoneNumber: 9 },
      zones: ZONES,
      built: BUILT_1_5,
    });

    expect(choice).toMatchObject({ priceZoneId: 236, basis: "CAPITAL" });
    expect(choice.notes?.[0]).toContain("нет в справочнике");
  });

  it("северность: закупка определила ту же зону (Северобайкальск, 8) — берётся оттуда вместе с совпавшим названием", () => {
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "г. Северобайкальск, ул. Мира" },
      declared: { subject: "Республика Бурятия", zoneName: "Республика Бурятия (8 зона)", zoneNumber: 8 },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toMatchObject({ priceZoneId: 239, basis: "CUSTOMER_ESTIMATE", matched: "г. Северобайкальск", northZone: "MPRKS" });
  });

  it("северность: закупка указывает на другую зону — северность зоны заказчика целиком", () => {
    // Закупка в Улан-Удэ (5 зона), заказчик считал в 8 зоне — вся она из районов Севера.
    const choice = chooseEstimateZone({
      tender: { region: "Республика Бурятия", address: "г. Улан-Удэ" },
      declared: { subject: "Республика Бурятия", zoneName: "Республика Бурятия (8 зона)", zoneNumber: 8 },
      zones: ZONES,
      built: BUILT,
    });

    expect(choice).toMatchObject({ priceZoneId: 239, basis: "CUSTOMER_ESTIMATE", matched: null, northZone: "MPRKS" });
  });

  describe("зона заказчика не собрана", () => {
    const DIRECTORY = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ priceZoneId: 231 + n, zoneName: `Республика Бурятия (${String(n)} зона)` })),
    ];

    it("со справочником — built: false (воркер соберёт по требованию)", () => {
      const choice = chooseEstimateZone({
        tender: JIDA,
        declared: { subject: "Республика Бурятия", zoneName: "Республика Бурятия (6 зона)", zoneNumber: 6 },
        zones: [...ZONES, zone(6, "с. Баргузин", "р-н. Селенгинский")],
        built: BUILT_1_5,
        directory: DIRECTORY,
      });

      expect(choice).toMatchObject({ priceZoneId: 237, basis: "CUSTOMER_ESTIMATE", built: false });
    });

    it("без справочника — отказ с перечнем собранных (воркер повторит со справочником)", () => {
      const text = message(() =>
        chooseEstimateZone({
          tender: JIDA,
          declared: { subject: "Республика Бурятия", zoneName: "Республика Бурятия (3 зона)", zoneNumber: 3 },
          zones: ZONES,
          built: BUILT_1_5,
        }),
      );

      expect(text).toContain("Смета заказчика составлена в зоне «Республика Бурятия (3 зона)», цен по ней ещё нет.");
      expect(text).toContain("Собраны: Республика Бурятия (1, 5 зона)");
    });
  });
});

describe("chooseEstimateZone: зона по ценам сметы заказчика (отпечаток ставок труда)", () => {
  const IRK = (n: number, id: number) => ({ priceZoneId: id, zoneName: `Иркутская область (${String(n)} зона)`, subject: "Иркутская область" });
  const IRK_ZONES: PriceZoneRecord[] = [
    ...ZONES,
    { subjectCode: "38", subjectName: "Иркутская область", zoneName: "Иркутская область (1 зона)", center: "г. Иркутск", municipalities: "р-н. Иркутский" },
    { subjectCode: "38", subjectName: "Иркутская область", zoneName: "Иркутская область (3 зона)", center: "г. Усть-Кут", municipalities: "р-н. Усть-Кутский" },
  ];
  const IRK_BUILT = [IRK(1, 101), IRK(3, 103)];
  /** Закупка 0134300025826000377: адрес «г. Иркутск» ведёт к 1 зоне, а ставки сметы — зоны 3. */
  const TENDER = { region: "Иркутская область", address: "г. Иркутск", customerName: "" };
  const BY_PRICES = { zoneName: "Иркутская область (3 зона)", matchedCodes: ["1-100-31", "4-100-040"] };

  it("шапка зону не называет: берётся зона отпечатка, основание CUSTOMER_PRICES, совпавшие коды в matched", () => {
    const choice = chooseEstimateZone({ tender: TENDER, zones: IRK_ZONES, built: IRK_BUILT, fingerprint: BY_PRICES });

    expect(choice).toMatchObject({ priceZoneId: 103, basis: "CUSTOMER_PRICES", matched: "1-100-31, 4-100-040", zoneName: "Иркутская область (3 зона)" });
    expect(choice.notes?.[0]).toContain("считаем в зоне по ценам сметы");
  });

  it("без отпечатка зона определяется по закупке, как раньше (адрес «г. Иркутск» — 1 зона)", () => {
    const choice = chooseEstimateZone({ tender: TENDER, zones: IRK_ZONES, built: IRK_BUILT, fingerprint: null });

    expect(choice).toMatchObject({ priceZoneId: 101, basis: "MUNICIPALITY" });
  });

  it("приоритет: ручной выбор важнее отпечатка", () => {
    const choice = chooseEstimateZone({ userPriceZoneId: 101, tender: TENDER, zones: IRK_ZONES, built: IRK_BUILT, fingerprint: BY_PRICES });

    expect(choice).toMatchObject({ priceZoneId: 101, basis: "USER" });
  });

  it("приоритет: зона из шапки важнее отпечатка; если они расходятся, берётся шапка и расхождение названо", () => {
    const choice = chooseEstimateZone({
      tender: TENDER,
      declared: { subject: "Иркутская область", zoneName: "Иркутская область (1 зона)", zoneNumber: 1 },
      zones: IRK_ZONES,
      built: IRK_BUILT,
      fingerprint: BY_PRICES,
    });

    expect(choice).toMatchObject({ priceZoneId: 101, basis: "CUSTOMER_ESTIMATE" });
    expect(choice.notes?.[0]).toContain("Иркутская область (3 зона)");
    expect(choice.notes?.[0]).toContain("в шапке сметы названа «Иркутская область (1 зона)»");
    expect(choice.notes?.[0]).toContain("принята зона из шапки");
  });

  it("шапка и отпечаток согласны — лишних пометок нет", () => {
    const choice = chooseEstimateZone({
      tender: TENDER,
      declared: { subject: "Иркутская область", zoneName: "Иркутская область (3 зона)", zoneNumber: 3 },
      zones: IRK_ZONES,
      built: IRK_BUILT,
      fingerprint: BY_PRICES,
    });

    expect(choice).toMatchObject({ priceZoneId: 103, basis: "CUSTOMER_ESTIMATE" });
    expect(choice).not.toHaveProperty("notes");
  });

  it("шапка названа, но зоны нет в справочнике: отпечаток всё равно срабатывает (приоритет выше закупки)", () => {
    const choice = chooseEstimateZone({
      tender: TENDER,
      declared: { subject: "Иркутская область", zoneName: "Иркутская область (9 зона)", zoneNumber: 9 },
      zones: IRK_ZONES,
      built: IRK_BUILT,
      fingerprint: BY_PRICES,
    });

    expect(choice).toMatchObject({ priceZoneId: 103, basis: "CUSTOMER_PRICES" });
    expect(choice.notes?.some((note) => note.includes("нет в справочнике"))).toBe(true);
  });

  it("отпечаток называет зону, которой нет на диске и нет справочника, — игнорируется: определяется по закупке", () => {
    const choice = chooseEstimateZone({
      tender: TENDER,
      zones: IRK_ZONES,
      built: [IRK(1, 101)],
      fingerprint: BY_PRICES,
    });

    expect(choice).toMatchObject({ priceZoneId: 101, basis: "MUNICIPALITY" });
  });

  it("то же со справочником зон: зона отпечатка выбрана и помечена `built: false` — воркер соберёт её по требованию", () => {
    const choice = chooseEstimateZone({
      tender: TENDER,
      zones: IRK_ZONES,
      built: [IRK(1, 101)],
      directory: [{ priceZoneId: 103, zoneName: "Иркутская область (3 зона)" }],
      fingerprint: BY_PRICES,
    });

    expect(choice).toMatchObject({ priceZoneId: 103, basis: "CUSTOMER_PRICES", built: false });
  });

  describe("fingerprintCandidateZones", () => {
    it("субъект из шапки (без названия зоны) важнее закупки: кандидаты — собранные зоны Иркутской области", () => {
      const candidates = fingerprintCandidateZones({
        declared: { subject: "Иркутская область", zoneName: null, zoneNumber: null },
        tender: { region: "Республика Бурятия" },
        zones: IRK_ZONES,
        built: [...BUILT, ...IRK_BUILT],
      });

      expect(candidates.map((zone) => zone.priceZoneId)).toEqual([101, 103]);
    });

    it("шапки нет: субъект — по региону закупки, а если регион не указан, по адресу", () => {
      const built = [...BUILT, ...IRK_BUILT];
      expect(fingerprintCandidateZones({ tender: TENDER, zones: IRK_ZONES, built }).map((zone) => zone.priceZoneId)).toEqual([101, 103]);
      expect(
        fingerprintCandidateZones({ tender: { region: "Не указан", address: "г. Иркутск, ул. Ленина" }, zones: IRK_ZONES, built }).map((zone) => zone.priceZoneId),
      ).toEqual([101, 103]);
    });

    it("ни шапки, ни закупки — кандидаты все собранные зоны: решает точное совпадение ставок", () => {
      expect(fingerprintCandidateZones({ tender: null, zones: IRK_ZONES, built: IRK_BUILT })).toEqual(IRK_BUILT);
      expect(fingerprintCandidateZones({ tender: { region: "Не указан", address: null }, zones: IRK_ZONES, built: IRK_BUILT })).toEqual(IRK_BUILT);
    });
  });
});
