import { describe, expect, it } from "vitest";
import {
  extractNuxtTable,
  isEtpgpbCardPage,
  parseEtpgpbCard,
  resolveDevalue,
} from "@/adapters/tender-source/etpgpbCard";
import {
  ETPGPB_CARD_COMMERCE,
  ETPGPB_CARD_ETP_CLICK,
  ETPGPB_CARD_ETP_EIS11,
  ETPGPB_CARD_ETP_PRICE_UNKNOWN,
  ETPGPB_CARD_GAZ_EIS_URL,
  ETPGPB_CARD_SALE,
} from "@/adapters/tender-source/etpgpbCardFixtures";
import { SYNTHETIC_CONTACT_PATTERN, nuxtPage, withSyntheticContacts } from "@/adapters/tender-source/etpgpbTestFixtures";

type Table = unknown[];
type Entry = Record<string, number>;

const isObj = (value: unknown): value is Entry =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parse = (fixture: { url: string; table: Table }) => parseEtpgpbCard(nuxtPage(fixture.table), fixture.url);

describe("resolveDevalue", () => {
  it("значения — индексы: литералы лежат в таблице, объекты ссылаются на неё", () => {
    // [0] объект, [1] строка, [2] число, [3] список из индексов, [4] true
    const table: Table = [{ name: 1, price: 2, tags: 3, ok: 4 }, "Закупка", 12.5, [1, 2], true];
    expect(resolveDevalue(table, 0)).toEqual({ name: "Закупка", price: 12.5, tags: ["Закупка", 12.5], ok: true });
  });

  it("обёртки реактивности снимаются, в том числе вложенные друг в друга", () => {
    // Ref → Reactive → объект: так лежит `PROCEDURES_ID_STORE.procedure`.
    const table: Table = [["ShallowReactive", 1], { procedure: 2 }, ["Ref", 3], ["Reactive", 4], { id: 5 }, "42"];
    expect(resolveDevalue(table, 0)).toEqual({ procedure: { id: "42" } });
    expect(resolveDevalue([["EmptyRef", 1], "x"], 0)).toBe("x");
  });

  it("служебные значения: -1 — undefined, коллекции и даты", () => {
    const table: Table = [{ gone: -1, set: 1, date: 2, when: 3 }, ["Set", 4, 5], ["Date", "2026-10-19T00:00:00.000Z"], "x", "a", "b"];
    const out = resolveDevalue(table, 0) as Record<string, unknown>;
    expect(out["gone"]).toBeUndefined();
    expect(out["set"]).toEqual(["a", "b"]);
    expect(out["date"]).toBe("2026-10-19T00:00:00.000Z");
  });

  it("общий узел остаётся общим, цикл не зацикливает разворот", () => {
    const table: Table = [{ a: 1, b: 1 }, { self: 0 }];
    const out = resolveDevalue(table, 0) as { a: { self: unknown }; b: unknown };
    expect(out.a).toBe(out.b);
    expect(out.a.self).toBe(out);
  });

  it("недостижимый индекс и неизвестная обёртка — undefined, а не исключение", () => {
    expect(resolveDevalue([{ x: 99 }], 0)).toEqual({ x: undefined });
    expect(resolveDevalue([["Mystery", 1], "x"], 0)).toBeUndefined();
  });

  it("ключ __proto__ из чужих данных не подменяет прототип", () => {
    const table: Table = [JSON.parse('{"__proto__": 1, "ok": 2}'), { polluted: 2 }, "yes"];
    const out = resolveDevalue(table, 0) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("бесконечно глубокая цепочка обрывается, а не роняет процесс", () => {
    const table: Table = [];
    for (let i = 0; i < 500; i += 1) table.push({ next: i + 1 });
    table.push("end");
    expect(() => resolveDevalue(table, 0)).not.toThrow();
  });
});

describe("данные Nuxt на странице", () => {
  it("находит блок по id, даже когда в теге есть другие атрибуты", () => {
    const html = nuxtPage(["x"]);
    expect(isEtpgpbCardPage(html)).toBe(true);
    expect(extractNuxtTable(html)).toEqual(["x"]);
  });

  it("страница без блока, с битым JSON или с объектом вместо массива — не карточка", () => {
    expect(isEtpgpbCardPage("<html>captcha</html>")).toBe(false);
    expect(extractNuxtTable("<html>captcha</html>")).toBeNull();
    expect(extractNuxtTable('<script id="__NUXT_DATA__">{oops</script>')).toBeNull();
    expect(extractNuxtTable('<script id="__NUXT_DATA__">{"a":1}</script>')).toBeNull();
    expect(parseEtpgpbCard("<html>captcha</html>", ETPGPB_CARD_ETP_EIS11.url)).toBeNull();
  });
});

describe("главная процедура: не «похожая»", () => {
  const url = ETPGPB_CARD_ETP_PRICE_UNKNOWN.url;

  it("берётся процедура самой карточки: номер, лоты, заказчик — её, а не копий", () => {
    const card = parse(ETPGPB_CARD_ETP_PRICE_UNKNOWN);
    expect(card).not.toBeNull();
    expect(card?.registryNumber).toBe("АП125184");
    expect(card?.platformId).toBe("1299773");
    expect(card?.kind).toBe("etp");
    expect(card?.title).toContain("ГПН-Заполярье");
    expect(card?.lots).toHaveLength(1);
    expect(card?.customers.map((c) => c.inn)).toEqual(["5501072608"]);
  });

  it("в таблице есть копия той же процедуры с тем же id и чужой закупкой — она не выбирается", () => {
    const text = JSON.stringify(ETPGPB_CARD_ETP_PRICE_UNKNOWN.table);
    // Двойники на месте: иначе тест ничего бы не доказывал.
    expect(text).toContain("99999999999");
    expect(text).toContain("ДРУГАЯ-1");
    const card = parse(ETPGPB_CARD_ETP_PRICE_UNKNOWN);
    const out = JSON.stringify(card);
    expect(out).not.toContain("99999999999");
    expect(out).not.toContain("ДРУГАЯ-1");
    expect(out).not.toContain("Копия из блока похожих");
  });

  it("запасной обход (стора нет на месте) находит главную по platform_id и тоже не берёт двойников", () => {
    const table = JSON.parse(JSON.stringify(ETPGPB_CARD_ETP_PRICE_UNKNOWN.table)) as Table;
    // Переименовали ключ стора — прямой путь пропал. Заодно ставим «похожие» раньше главной.
    const pinia = table.find((e) => isObj(e) && "PROCEDURES_ID_STORE" in e) as Entry;
    pinia["PROCEDURES_ID_STORE_MOVED"] = pinia["PROCEDURES_ID_STORE"]!;
    delete pinia["PROCEDURES_ID_STORE"];
    const store = table.find((e) => isObj(e) && "procedure" in e && "similarProcedures" in e) as Entry;
    const reordered: Entry = { similarProcedures: store["similarProcedures"]!, procedure: store["procedure"]! };
    for (const key of Object.keys(store)) delete store[key];
    Object.assign(store, reordered);

    const card = parseEtpgpbCard(nuxtPage(table), url);
    expect(card?.registryNumber).toBe("АП125184");
    expect(card?.platformId).toBe("1299773");
    // Заказчики лотов лежат в сторе; обходом они не находятся — остаётся организатор.
    expect(card?.customers).toEqual([]);
    expect(card?.organizer?.inn).toBe("5501072608");
  });

  it("сверка с адресом: страница другой процедуры не принимается за запрошенную", () => {
    const other = "https://etpgpb.ru/procedures/etp/999999-drugaya-protsedura/";
    expect(parseEtpgpbCard(nuxtPage(ETPGPB_CARD_ETP_PRICE_UNKNOWN.table), other)).toBeNull();
  });

  it("platform_id сверяется, а не id ресурса: у разных видов они различаются", () => {
    const card = parse(ETPGPB_CARD_ETP_PRICE_UNKNOWN);
    const resourceId = JSON.stringify(ETPGPB_CARD_ETP_PRICE_UNKNOWN.table).match(/"2081478"/);
    expect(resourceId).not.toBeNull(); // id ресурса 2081478, а в адресе 1299773
    expect(card?.platformId).toBe("1299773");
  });

  it("указатель ведёт на чужую закупку, а настоящей больше нигде нет — null: чужую не берём", () => {
    const table = JSON.parse(JSON.stringify(ETPGPB_CARD_ETP_PRICE_UNKNOWN.table)) as Table;
    const store = table.find((e) => isObj(e) && "procedure" in e && "similarProcedures" in e) as Entry;
    // `procedure` теперь — Ref на ресурс «чужая закупка» (platform_id 424242) из списка процедур.
    table[store["procedure"]!] = ["Ref", decoyResourceIndex(table)];
    expect(parseEtpgpbCard(nuxtPage(table), ETPGPB_CARD_ETP_PRICE_UNKNOWN.url)).toBeNull();
  });
});

/** Индекс ресурса «чужая закупка» из списка процедур (`platform_id` 424242). */
function decoyResourceIndex(table: Table): number {
  const index = table.findIndex((e) => isObj(e) && "type" in e && "attributes" in e && "relationships" in e && isDecoyAttributes(table, e["attributes"]!));
  expect(index).toBeGreaterThan(0);
  return index;
}

function isDecoyAttributes(table: Table, attributesIndex: number): boolean {
  const attrs = table[attributesIndex];
  if (!isObj(attrs) || !("platform_id" in attrs)) return false;
  return table[attrs["platform_id"]!] === 424242;
}

describe("поля карточки", () => {
  it("etp с номером ЕИС вместо номера площадки: регион пуст, лот и заказчики разобраны", () => {
    const card = parse(ETPGPB_CARD_ETP_EIS11);
    expect(card).toMatchObject({
      kind: "etp",
      platformId: "1298399",
      registryNumber: "32616467295",
      stage: "accepting",
      amount: 2113390.4,
      priceUnknown: false,
      currency: "RUB",
      region: "",
      applicationEnd: "23.10.2026 03:00",
      eisUrl: null,
      lotRegions: ["Республика Бурятия"],
      customerAddress: "670031, РЕСПУБЛИКА БУРЯТИЯ, Г. УЛАН-УДЭ, УЛ. ПАВЛОВА, Д. 12",
    });
    expect(card?.flags.smsp).toBe(true);
    expect(card?.flags.auction).toBe(true);
    expect(card?.organizer?.name).toBe('ГАУЗ "РКБ ИМ. Н.А. СЕМАШКО"');
    expect(card?.organizer?.inn).toBe("0323054162");
    expect(card?.customers.map((c) => c.inn)).toEqual(["0323054162", "0318008361"]);
    expect(card?.lots[0]).toMatchObject({
      id: "2360953",
      number: 1,
      startPrice: 2113390.4,
      dateEndRegistration: "2026-10-23T03:00:00.000+03:00",
      deliveryAddress: ", Любой закрытый",
    });
    expect(card?.docs).toEqual([{ title: "АД_сов_агар.docx", date: "2026-10-14T05:19:52.000+03:00" }]);
  });

  it("commerce: организатора нет, заказчик — в lotCustomers", () => {
    const card = parse(ETPGPB_CARD_COMMERCE);
    expect(card?.kind).toBe("commerce");
    expect(card?.organizer).toBeNull();
    expect(card?.customers).toHaveLength(1);
    expect(card?.customers[0]).toMatchObject({ inn: "5752019857", kpp: expect.any(String) });
    expect(card?.stage).toBe("commission");
    expect(card?.priceUnknown).toBe(true);
  });

  it("gaz: ссылка на ЕИС, организатор и заказчик — разные лица", () => {
    const card = parse(ETPGPB_CARD_GAZ_EIS_URL);
    expect(card?.eisUrl).toContain("regNumber=32616379968");
    expect(card?.organizer?.name).toBe("Газпром комплектация");
    expect(card?.customers[0]?.inn).toBe("7702211710");
    expect(card?.regions).toEqual(["Санкт-Петербург"]);
    expect(card?.procedureNumber).toBe("26/4.3/0097937/ГПитание");
  });

  it("etp_click: срока процедуры нет, срок ответа — в лоте", () => {
    const card = parse(ETPGPB_CARD_ETP_CLICK);
    expect(card?.applicationEnd).toBeNull();
    expect(card?.lots[0]?.dateEndRegistration).toBeNull();
    expect(card?.lots[0]?.responseDate).toBe("2026-10-20T12:00:00.000+03:00");
    expect(card?.amount).toBe(142391.2);
    expect(card?.title).toBe("Поставка игрушек в ассортименте");
  });

  it("продажа имущества разбирается как есть: отсев — дело маппера и карты сайта", () => {
    const card = parse(ETPGPB_CARD_SALE);
    expect(card?.kind).toBe("sale");
    expect(card?.platform).toContain("Продажа");
  });
});

describe("контакты не выпускаются", () => {
  const FIXTURES = [
    ETPGPB_CARD_ETP_EIS11,
    ETPGPB_CARD_ETP_PRICE_UNKNOWN,
    ETPGPB_CARD_COMMERCE,
    ETPGPB_CARD_ETP_CLICK,
    ETPGPB_CARD_GAZ_EIS_URL,
  ];

  it("вымышленные контакты действительно попали во вход (иначе проверка пуста)", () => {
    const table = withSyntheticContacts(ETPGPB_CARD_ETP_EIS11.table);
    const resolved = JSON.stringify(resolveDevalue(table, 0));
    expect(resolved).toContain("synth.contact@example.invalid");
    expect(resolved).toContain("SYNTH-Контакт-Из-Связи");
    expect(resolved).toContain("SYNTH-Неизвестное-Поле");
  });

  it.each(FIXTURES.map((fixture) => [fixture.url.split("/")[4], fixture] as const))(
    "%s: ни ключей, ни значений контактов в очищенной записи",
    (_name, fixture) => {
      const card = parseEtpgpbCard(nuxtPage(withSyntheticContacts(fixture.table)), fixture.url);
      expect(card).not.toBeNull();
      const out = JSON.stringify(card);
      expect(out).not.toMatch(SYNTHETIC_CONTACT_PATTERN);
      // Ни одного ключа вида contact/email/phone на любой глубине.
      const keys: string[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (typeof value === "object" && value !== null) {
          for (const [key, child] of Object.entries(value)) {
            keys.push(key);
            walk(child);
          }
        }
      };
      walk(card);
      expect(keys.filter((key) => /contact|e-?mail|phone|fax/i.test(key))).toEqual([]);
    },
  );

  it("ссылки на документы (закрытый хост) в запись не попадают", () => {
    for (const fixture of FIXTURES) {
      const out = JSON.stringify(parse(fixture));
      expect(out).not.toMatch(/etp\.gpb\.ru|com\.etpgpb\.ru|click\.etpgpb\.ru|file\/get/);
    }
  });

  it("в закоммиченных фикстурах контактных ключей нет вовсе", () => {
    for (const fixture of [...FIXTURES, ETPGPB_CARD_SALE]) {
      const text = JSON.stringify(fixture.table);
      for (const key of ["contact_person", "contact_email", "contact_phone", "customer_contact", "customer_email", "customer_phone", "body_email"]) {
        expect(text, key).not.toContain(`"${key}"`);
      }
      expect(text).not.toMatch(/@/);
    }
  });
});
