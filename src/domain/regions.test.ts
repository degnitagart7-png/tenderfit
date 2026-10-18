import { describe, expect, it } from "vitest";
import { UNKNOWN_REGION } from "@/domain/entities";
import {
  CANONICAL_REGIONS,
  REGION_CAPITALS,
  RF_REGIONS,
  normalizeRegionText,
  regionFromAddress,
  regionFromAddresses,
} from "@/domain/regions";

describe("normalizeRegionText", () => {
  it("убирает регистр, пунктуацию и «ё»", () => {
    expect(normalizeRegionText("Ханты-Мансийский АО — Югра")).toBe("ханты мансийский ао югра");
    expect(normalizeRegionText("Республика Бурятия, г. Улан-Удэ")).toBe(
      "республика бурятия г улан удэ",
    );
    expect(normalizeRegionText("  ПЕРМСКИЙ   край ")).toBe("пермский край");
    expect(normalizeRegionText("")).toBe("");
  });
});

describe("regionFromAddress — реальные адреса поставки из API Контур.Закупок", () => {
  it("находит субъект, когда он стоит первым в адресе", () => {
    expect(
      regionFromAddress(
        "Приволжский федеральный округ, Башкортостан Респ, 452750, Р.Б., г. Туймазы, пл. Октября д. 2",
      ),
    ).toBe("Республика Башкортостан");
    expect(
      regionFromAddress(
        "Республика Башкортостан, Бурзянский район, село Старосубхангулово, ул Уральская, д 7",
      ),
    ).toBe("Республика Башкортостан");
    expect(regionFromAddress("г Новосибирск, ул Курчатова, д 11/5")).toBe(
      "Новосибирская область",
    );
  });

  it("определяет субъект по административному центру", () => {
    expect(regionFromAddress("г. Улан-Удэ, ул. Ленина, д. 30")).toBe("Республика Бурятия");
    expect(regionFromAddress("г. Екатеринбург, ул. Малышева")).toBe("Свердловская область");
    expect(regionFromAddress("Нижний Новгород, Кремль")).toBe("Нижегородская область");
  });

  it("не путает город с однокоренным прилагательным и не угадывает неоднозначное", () => {
    // «Кировский район» есть почти в каждом крупном городе — это не Кировская область.
    expect(regionFromAddress("Кировский район, г. Уфа")).toBe("Республика Башкортостан");
    expect(regionFromAddress("Омский район, с. Троицкое")).toBe(UNKNOWN_REGION);
    // Одно название «Благовещенск» неоднозначно: Амурская область и Башкортостан.
    expect(regionFromAddress("г. Благовещенск")).toBe(UNKNOWN_REGION);
    expect(regionFromAddress("г. Киров")).toBe(UNKNOWN_REGION);
  });

  it("распознаёт край, область и город федерального значения", () => {
    expect(regionFromAddress("Красноярский край, г. Норильск")).toBe("Красноярский край");
    expect(regionFromAddress("Иркутская обл., г. Братск")).toBe("Иркутская область");
    expect(regionFromAddress("г. Москва, ул. Вымышленная, д. 1")).toBe("Москва");
    expect(regionFromAddress("Санкт-Петербург, наб. р. Фонтанки")).toBe("Санкт-Петербург");
  });

  it("различает Республику Алтай и Алтайский край", () => {
    expect(regionFromAddress("Республика Алтай, Майминский район")).toBe("Республика Алтай");
    expect(regionFromAddress("Алтайский край, г. Барнаул")).toBe("Алтайский край");
    // «Алтайск» — город в Алтайском крае, но не самостоятельное совпадение «Алтай».
    expect(regionFromAddress("г. Алтайск")).toBe(UNKNOWN_REGION);
  });

  it("не принимает Москву за Московскую область и наоборот", () => {
    expect(regionFromAddress("Московская область, г. Химки")).toBe("Московская область");
    expect(regionFromAddress("Москва, Зеленоград")).toBe("Москва");
    expect(regionFromAddress("Московский проспект, г. Воронеж")).toBe("Воронежская область");
  });

  it("автономные округа важнее области, в которую они входят по адресу", () => {
    expect(regionFromAddress("Ханты-Мансийский автономный округ — Югра, г. Сургут")).toBe(
      "Ханты-Мансийский автономный округ — Югра",
    );
    expect(regionFromAddress("ХМАО, г. Нижневартовск")).toBe(
      "Ханты-Мансийский автономный округ — Югра",
    );
    expect(regionFromAddress("ЯНАО, г. Новый Уренгой")).toBe("Ямало-Ненецкий автономный округ");
  });

  it("возвращает «Не указан», когда субъекта в тексте нет", () => {
    expect(regionFromAddress("г. Туймазы, пл. Октября д. 2")).toBe(UNKNOWN_REGION);
    expect(regionFromAddress("")).toBe(UNKNOWN_REGION);
    expect(regionFromAddress(null)).toBe(UNKNOWN_REGION);
    expect(regionFromAddress(undefined)).toBe(UNKNOWN_REGION);
    // Закрашенное значение тестового ключа — тоже неизвестность.
    expect(regionFromAddress("░░░░░░░░░░░░░░░░░░░░░░░░░")).toBe(UNKNOWN_REGION);
  });
});

describe("regionFromAddresses", () => {
  it("берёт первое распознанное место поставки", () => {
    expect(
      regionFromAddresses(["г. Туймазы, ул. Ленина", "Республика Бурятия, г. Улан-Удэ"]),
    ).toBe("Республика Бурятия");
  });

  it("возвращает «Не указан» для пустого списка и нераспознанных значений", () => {
    expect(regionFromAddresses([])).toBe(UNKNOWN_REGION);
    expect(regionFromAddresses([null, "", "склад получателя"])).toBe(UNKNOWN_REGION);
  });
});

describe("словарь субъектов", () => {
  it("содержит 85 уникальных канонических наименований", () => {
    expect(CANONICAL_REGIONS).toHaveLength(85);
    expect(new Set(CANONICAL_REGIONS).size).toBe(85);
  });

  it("каждый административный центр ссылается на существующий субъект", () => {
    const canonical = new Set(CANONICAL_REGIONS);
    for (const entry of REGION_CAPITALS) {
      expect(canonical.has(entry.canonical)).toBe(true);
    }
  });

  it("каждое каноническое наименование распознаётся из самого себя", () => {
    for (const region of RF_REGIONS) {
      expect(regionFromAddress(region.canonical)).toBe(region.canonical);
    }
  });

  it("каждый вариант указывает ровно на своё наименование", () => {
    const seen = new Map<string, string>();
    for (const region of [...RF_REGIONS, ...REGION_CAPITALS]) {
      for (const alias of region.aliases) {
        const key = normalizeRegionText(alias);
        const owner = seen.get(key);
        expect(owner ?? region.canonical).toBe(region.canonical);
        seen.set(key, region.canonical);
        expect(regionFromAddress(alias)).toBe(region.canonical);
      }
    }
  });
});

describe("regionFromAddress: падежные формы в названиях закупок", () => {
  it("узнаёт область, край и автономный округ не в именительном падеже", () => {
    expect(regionFromAddress("Ремонт ТРК на АЗС, расположенных в Белгородской области")).toBe("Белгородская область");
    expect(regionFromAddress("Капремонт школы в Иркутской обл.")).toBe("Иркутская область");
    expect(regionFromAddress("для нужд Краснодарского края")).toBe("Краснодарский край");
    expect(regionFromAddress("объекты в Забайкальском крае")).toBe("Забайкальский край");
    expect(regionFromAddress("Ямало-Ненецкого автономного округа")).toBe("Ямало-Ненецкий автономный округ");
    expect(regionFromAddress("на территорию Московскую область")).toBe("Московская область");
  });

  it("голое прилагательное в косвенном падеже регионом не считается", () => {
    expect(regionFromAddress("ул. Белгородской, д. 5")).toBe(UNKNOWN_REGION);
  });
});

