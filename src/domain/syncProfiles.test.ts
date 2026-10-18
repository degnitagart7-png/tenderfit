import { describe, expect, it } from "vitest";

import {
  MAX_SERVER_PROFILES,
  parseServerProfiles,
  pickSyncProfiles,
  toServerProfiles,
  type ServerProfile,
} from "@/domain/syncProfiles";
import type { SearchProfile } from "@/domain/entities";

/**
 * Профили поиска на сервере.
 *
 * Раньше сборщик знал три зашитых профиля («автомобили», «компьютеры»,
 * «стройка»), а всё остальное в ленте появлялось только случайно. Теперь
 * владелец отправляет свои профили на сервер, и сборщик собирает их.
 */

const file = [
  { name: "Автомобили", enabled: true, laws: ["FZ_44"], keywords: ["автомобиль"] },
  { name: "Стройка", enabled: true, laws: ["FZ_44"], keywords: ["ремонт"] },
];

function server(over: Partial<ServerProfile> = {}): ServerProfile {
  return {
    name: "Юридические услуги",
    laws: ["FZ_44", "FZ_223"],
    keywords: ["юридические услуги", "юрист"],
    okpd2Codes: [],
    minPrice: null,
    maxPrice: null,
    regions: [],
    enabled: true,
    ...over,
  };
}

describe("pickSyncProfiles", () => {
  it("на сервере профилей нет — работают профили из файла", () => {
    expect(pickSyncProfiles(file, [])).toEqual(file);
  });

  it("профили сервера заменяют зашитые целиком: чужих тем в сборе не остаётся", () => {
    const picked = pickSyncProfiles(file, [server()]);

    expect(picked.map((p) => p.name)).toEqual(["Юридические услуги"]);
    expect(picked[0]?.keywords).toEqual(["юридические услуги", "юрист"]);
  });

  it("выключенный профиль сервера не собирается", () => {
    const picked = pickSyncProfiles(file, [server(), server({ name: "Пауза", enabled: false })]);

    expect(picked.map((p) => p.name)).toEqual(["Юридические услуги"]);
  });

  it("все профили сервера выключены — собирать нечего, а не откат к зашитым", () => {
    expect(pickSyncProfiles(file, [server({ enabled: false })])).toEqual([]);
  });

  it("цена и коды ОКПД2 доходят до профиля сборщика", () => {
    const [picked] = pickSyncProfiles(file, [
      server({ minPrice: 1000, maxPrice: 5000, okpd2Codes: ["69.10"] }),
    ]);

    expect(picked).toMatchObject({ minPrice: 1000, maxPrice: 5000, okpd2Codes: ["69.10"], enabled: true });
  });
});

describe("pickSyncProfiles со спросом посетителей", () => {
  const demand = [
    { name: "Спрос 1", enabled: true, laws: ["FZ_44" as const], keywords: ["юрист"] },
  ];

  it("есть только спрос — собирается он, а зашитые профили не возвращаются", () => {
    expect(pickSyncProfiles(file, [], demand)).toEqual(demand);
  });

  it("профили владельца и спрос собираются вместе", () => {
    const picked = pickSyncProfiles(file, [server()], demand);

    expect(picked.map((p) => p.name)).toEqual(["Юридические услуги", "Спрос 1"]);
  });

  it("владелец выключил свои профили, а спрос есть — собирается спрос", () => {
    expect(pickSyncProfiles(file, [server({ enabled: false })], demand)).toEqual(demand);
  });

  it("ни спроса, ни профилей сервера — работает файл", () => {
    expect(pickSyncProfiles(file, [], [])).toEqual(file);
  });
});

/*
  Регион в плановом сборе. Живой поиск уже искал по региону заказчика, а
  плановый прогон шёл по всей России: региональная компания получала в базе
  единицы своих закупок. Регионы профиля теперь доходят до сборщика.
*/
describe("регионы профиля сервера", () => {
  it("регионы доходят до профиля сборщика", () => {
    const [picked] = pickSyncProfiles(file, [server({ regions: ["Республика Бурятия"] })]);

    expect(picked).toMatchObject({ regions: ["Республика Бурятия"] });
  });

  it("регионы чистятся и не повторяются", () => {
    const result = parseServerProfiles([server({ regions: [" Республика  Бурятия ", "республика бурятия", "Москва"] })]);

    expect(result.ok && result.profiles[0]?.regions).toEqual(["Республика Бурятия", "Москва"]);
  });

  it("старый отчёт без поля регионов принимается как «вся Россия»", () => {
    const { regions: _omit, ...legacy } = server();
    const result = parseServerProfiles([legacy]);

    expect(result.ok && result.profiles[0]?.regions).toEqual([]);
  });

  it("регионов больше пяти не принимается", () => {
    const six = ["Москва", "Бурятия", "Крым", "Тыва", "Коми", "Карелия"];

    expect(parseServerProfiles([server({ regions: six })]).ok).toBe(false);
  });
});

describe("parseServerProfiles", () => {
  it("принимает корректный список", () => {
    const result = parseServerProfiles([server()]);

    expect(result.ok).toBe(true);
  });

  it("чистит пробелы и повторы ключевых слов", () => {
    const result = parseServerProfiles([server({ keywords: ["  юрист ", "юрист", "", "адвокат"] })]);

    expect(result.ok && result.profiles[0]?.keywords).toEqual(["юрист", "адвокат"]);
  });

  it("профиль без ключевых слов отклоняется: он собрал бы всё подряд", () => {
    expect(parseServerProfiles([server({ keywords: [" ", ""] })]).ok).toBe(false);
  });

  it("слишком много профилей — отказ: каждый стоит запросов к чужим площадкам", () => {
    const many = Array.from({ length: MAX_SERVER_PROFILES + 1 }, (_, i) => server({ name: `П${i}` }));

    expect(parseServerProfiles(many).ok).toBe(false);
  });

  it("слишком много ключевых слов в профиле — отказ", () => {
    const words = Array.from({ length: 31 }, (_, i) => `слово${i}`);

    expect(parseServerProfiles([server({ keywords: words })]).ok).toBe(false);
  });

  it("закон вне списка отклоняется", () => {
    expect(parseServerProfiles([server({ laws: ["XX" as never] })]).ok).toBe(false);
  });

  it("не список — отказ", () => {
    expect(parseServerProfiles({ a: 1 }).ok).toBe(false);
  });

  it("одноимённые профили отклоняются: имя — ключ записи", () => {
    expect(parseServerProfiles([server(), server()]).ok).toBe(false);
  });
});

describe("toServerProfiles", () => {
  function local(over: Partial<SearchProfile> = {}): SearchProfile {
    return {
      id: "sp-1",
      name: "Юристы",
      laws: ["FZ_44", "FZ_223"],
      keywords: ["юрист"],
      stopWords: ["юридический адрес"],
      okpd2Codes: ["69.10"],
      regions: [],
      customerInns: [],
      minPrice: null,
      maxPrice: 900,
      onlyOpenForSubmission: true,
      enabled: true,
      ...over,
    };
  }

  it("регионы профиля поиска уходят на сервер", () => {
    const { profiles } = toServerProfiles([local({ regions: ["Республика Бурятия"] })]);

    expect(profiles[0]?.regions).toEqual(["Республика Бурятия"]);
  });

  it("у профиля нет региона — берутся приоритетные регионы компании", () => {
    const { profiles } = toServerProfiles([local({ regions: [] })], ["Республика Бурятия"]);

    expect(profiles[0]?.regions).toEqual(["Республика Бурятия"]);
  });

  it("свой регион профиля сильнее приоритетных регионов компании", () => {
    const { profiles } = toServerProfiles([local({ regions: ["Москва"] })], ["Республика Бурятия"]);

    expect(profiles[0]?.regions).toEqual(["Москва"]);
  });

  it("переносит то, что нужно сборщику, и не тащит остальное", () => {
    const { profiles, skipped } = toServerProfiles([local()]);

    expect(skipped).toEqual([]);
    expect(profiles).toEqual([
      {
        name: "Юристы",
        laws: ["FZ_44", "FZ_223"],
        keywords: ["юрист"],
        okpd2Codes: ["69.10"],
        minPrice: null,
        maxPrice: 900,
        regions: [],
        enabled: true,
      },
    ]);
  });

  it("профиль без ключевых слов не отправляется и называется среди пропущенных", () => {
    const { profiles, skipped } = toServerProfiles([local(), local({ id: "sp-2", name: "Пустой", keywords: [] })]);

    expect(profiles.map((p) => p.name)).toEqual(["Юристы"]);
    expect(skipped).toEqual(["Пустой"]);
  });

  it("результат проходит ту же проверку, что и на сервере", () => {
    const { profiles } = toServerProfiles([local()]);

    expect(parseServerProfiles(profiles).ok).toBe(true);
  });
});
