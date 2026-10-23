import { describe, expect, it } from "vitest";

import { buildEisSearchUrl } from "@/adapters/tender-source/eisParser";
import {
  normalizeOkpd2Code,
  okpd2Section,
  resolveOkpd2Id,
  resolveOkpd2Ids,
} from "@/adapters/tender-source/eisOkpdTree";

/**
 * Справочник ЕИС в миниатюре: раздел F (8873866) → классы 41–43 → «43.2» → «43.21».
 * Номера 41–43 сняты с живого справочника 24.10.2026, глубже — условные.
 */
const TREE: Record<string, unknown> = {
  "8873866": [
    { code: "41", key: 8873919, name: "Здания и работы по возведению зданий" },
    { code: "42", key: 8873920, name: "Сооружения и строительные работы в области гражданского строительства" },
    { code: "43", key: 8873921, name: "Работы строительные специализированные" },
  ],
  "8873921": [
    { code: "43.1", key: 9001 },
    { code: "43.2", key: 9002 },
  ],
  "9002": [
    { code: "43.21", key: 9021 },
    { code: "43.22", key: 9022 },
  ],
};

function fakeNsi() {
  const calls: string[] = [];
  const getJson = async (url: string): Promise<unknown> => {
    calls.push(url);
    const parent = new URL(url).searchParams.get("parentId") ?? "";
    return TREE[parent] ?? [];
  };
  return { calls, getJson };
}

describe("коды ОКПД2 для справочника ЕИС", () => {
  it("раздел определяется по двум первым цифрам", () => {
    expect(okpd2Section("41")).toBe("F");
    expect(okpd2Section("43.21.10")).toBe("F");
    expect(okpd2Section("68.10")).toBe("L");
    expect(okpd2Section("04")).toBeNull();
  });

  it("код чистится, мусор не считается кодом", () => {
    expect(normalizeOkpd2Code(" 43.21. ")).toBe("43.21");
    expect(normalizeOkpd2Code("43.21.10.120")).toBe("43.21.10.120");
    expect(normalizeOkpd2Code("стройка")).toBeNull();
    expect(normalizeOkpd2Code("4")).toBeNull();
  });

  it("класс находится одним запросом детей раздела", async () => {
    const nsi = fakeNsi();
    expect(await resolveOkpd2Id("41", nsi.getJson, "https://zakupki.gov.ru")).toEqual({ code: "41", id: 8873919 });
    expect(nsi.calls).toEqual(["https://zakupki.gov.ru/epz/api/nsi/okpd2/children.html?parentId=8873866"]);
  });

  it("подгруппа находится спуском по дереву", async () => {
    const nsi = fakeNsi();
    expect(await resolveOkpd2Id("43.21", nsi.getJson, "https://zakupki.gov.ru")).toEqual({ code: "43.21", id: 9021 });
    expect(nsi.calls).toHaveLength(3);
  });

  it("кода нет в справочнике — null, а не чужая позиция", async () => {
    const nsi = fakeNsi();
    expect(await resolveOkpd2Id("43.99", nsi.getJson, "https://zakupki.gov.ru")).toBeNull();
  });

  it("список без повторов, общий кэш не спрашивает раздел дважды", async () => {
    const nsi = fakeNsi();
    const refs = await resolveOkpd2Ids(["41", "42", "43", "41", "мусор"], nsi.getJson, "https://zakupki.gov.ru");
    expect(refs.map((r) => r.id)).toEqual([8873919, 8873920, 8873921]);
    expect(nsi.calls).toHaveLength(1);
  });
});

describe("buildEisSearchUrl с ОКПД2", () => {
  it("передаёт номера справочника, коды и вложенные позиции", () => {
    const url = new URL(
      buildEisSearchUrl({
        okpd2: [
          { code: "41", id: 8873919 },
          { code: "43", id: 8873921 },
        ],
      }),
    );
    expect(url.searchParams.get("okpd2Ids")).toBe("8873919,8873921");
    expect(url.searchParams.get("okpd2IdsCodes")).toBe("41,43");
    expect(url.searchParams.get("okpd2IdsWithNested")).toBe("on");
    // Голый параметр ЕИС игнорирует — его быть не должно.
    expect(url.searchParams.has("okpd2")).toBe(false);
  });
});
