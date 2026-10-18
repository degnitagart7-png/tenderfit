import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { customerWageRates, identifyZoneByWages, type CustomerWageRate, type ZoneWageCandidate } from "@/domain/estimate/zoneFingerprint";
import { buildWageScale } from "@/domain/estimate/wageScale";

/*
  Зона по ставкам труда в ЛСР заказчика (закупка 0134300025826000377, Иркутск): шапка зону не называет, а ставка
  «1-100-31» 921,66 ₽ и машинист «4-100-040» 1 024,91 ₽ — ровно реестр 3 зоны Иркутской области.
  Числа зон 1, 3, 4–5 и 6 — из реестра ФГИС ЦС по этим двум кодам; остальные разряды шкалы условны (для отпечатка не нужны).
*/

const META = { region: "Иркутская область", period: "III квартал 2026" };

/** Шкала зоны: ставка 1-го разряда, разряд 3,1 и машинист 4,0 из реестра. */
function candidate(n: string, worker31: number, machinist40: number, options: { machinists?: boolean } = {}): ZoneWageCandidate {
  const zone = `Иркутская область (${n} зона)`;
  return {
    zoneName: zone,
    scale: buildWageScale(
      [
        { rank: 1, salary: Math.round((worker31 / 1.3) * 100) / 100, source: "реестр" },
        { rank: 3.1, salary: worker31, source: "реестр" },
      ],
      { ...META, zone },
      options.machinists === false ? {} : { machinists: [{ rank: 4, salary: machinist40, source: "реестр" }] },
    ),
  };
}

const ZONES = [
  candidate("1", 586.29, 651.98),
  candidate("3", 921.66, 1024.91),
  candidate("4", 1001.93, 1114.18),
  candidate("5", 1001.93, 1114.18),
  candidate("6", 1093.86, 1216.41),
];

const rate = (code: string, price: number): CustomerWageRate => ({ code, price, rows: 1 });

describe("identifyZoneByWages", () => {
  it("921,66 и 1 024,91 — точно 3 зона: совпадают два разных кода, остальные зоны не подходят", () => {
    const result = identifyZoneByWages([rate("1-100-31", 921.66), rate("4-100-040", 1024.91)], ZONES);

    expect(result).toEqual({ kind: "MATCH", zoneName: "Иркутская область (3 зона)", matchedCodes: ["1-100-31", "4-100-040"] });
  });

  it("допуск ±0,01: ставка заказчика на копейку ниже — совпадение; на две — нет", () => {
    expect(identifyZoneByWages([rate("1-100-31", 921.65), rate("4-100-040", 1024.92)], ZONES).kind).toBe("MATCH");
    expect(identifyZoneByWages([rate("1-100-31", 921.64), rate("4-100-040", 1024.91)], ZONES).kind).toBe("NONE");
  });

  it("зоны 4 и 5 с одинаковыми ставками — неоднозначность, а не выбор", () => {
    const result = identifyZoneByWages([rate("1-100-31", 1001.93), rate("4-100-040", 1114.18)], ZONES);

    expect(result).toEqual({
      kind: "AMBIGUOUS",
      reason: "несколько зон имеют те же ставки труда",
      zoneNames: ["Иркутская область (4 зона)", "Иркутская область (5 зона)"],
    });
  });

  it("одного совпавшего кода мало: отпечаток требует двух разных кодов", () => {
    expect(identifyZoneByWages([rate("1-100-31", 921.66)], ZONES).kind).toBe("NONE");
    // Две строки одного кода — тоже один код.
    expect(identifyZoneByWages([{ code: "1-100-31", price: 921.66, rows: 40 }], ZONES).kind).toBe("NONE");
  });

  it("ставка, которая точно не совпала с реестром зоны, — не отпечаток: один код совпал, другой разошёлся", () => {
    const result = identifyZoneByWages([rate("1-100-31", 921.66), rate("4-100-040", 1100)], ZONES);

    expect(result.kind).toBe("NONE");
    expect((result as { reason: string }).reason).toContain("расхождение");
  });

  it("ставки другого квартала (ни с одной зоной не совпали) — зона не названа", () => {
    const result = identifyZoneByWages([rate("1-100-31", 880.1), rate("4-100-040", 990.5)], ZONES);

    expect(result).toEqual({ kind: "NONE", reason: "ставки смет заказчика не совпали ни с одной зоной субъекта (другой квартал или другие ставки)" });
  });

  it("ставка, достроенная интерполяцией, совпадать может, а расходиться — нет: копейки интерполяции не измерены", () => {
    // Код 1-100-35 между опорными 3,1 и 1,0 шкалы: значение интерполировано, заказчик напечатал другое — это не расхождение.
    const result = identifyZoneByWages([rate("1-100-31", 921.66), rate("4-100-040", 1024.91), rate("1-100-20", 5)], ZONES);

    expect(result).toMatchObject({ kind: "MATCH", zoneName: "Иркутская область (3 зона)" });
  });

  it("у победителя нет ставки машиниста, а она совпала с другой зоной — данные противоречат: неоднозначно", () => {
    const zones = [candidate("3", 921.66, 1024.91, { machinists: false }), candidate("6", 1093.86, 1024.91)];
    const result = identifyZoneByWages(
      [rate("1-100-31", 921.66), rate("1-100-10", Math.round((921.66 / 1.3) * 100) / 100), rate("4-100-040", 1024.91)],
      zones,
    );

    expect(result.kind).toBe("AMBIGUOUS");
  });

  it("нет кандидатов — null-результат с причиной", () => {
    expect(identifyZoneByWages([rate("1-100-31", 921.66), rate("4-100-040", 1024.91)], []).kind).toBe("NONE");
  });
});

describe("customerWageRates", () => {
  const FIXTURE = readFileSync(path.resolve(__dirname, "__fixtures__/t0377/lsr-irkutsk-no-groups.txt"), "utf8");

  it("ставки труда и машинистов из ресурсных строк ЛСР: 921,66 и 1 024,91; машины и материалы не берутся", () => {
    const { estimates } = parseCustomerLsr([{ name: "ЛСР.xlsx", text: FIXTURE }]);

    expect(customerWageRates(estimates)).toEqual([
      { code: "1-100-31", price: 921.66, rows: 1 },
      { code: "4-100-040", price: 1024.91, rows: 1 },
    ]);
  });

  it("из ЛСР без шапки зоны и по ним — зона 3", () => {
    const { estimates } = parseCustomerLsr([{ name: "ЛСР.xlsx", text: FIXTURE }]);

    expect(identifyZoneByWages(customerWageRates(estimates), ZONES)).toMatchObject({ kind: "MATCH", zoneName: "Иркутская область (3 зона)" });
  });

  it("у кода две цены с одинаковой частотой — код не берётся: ничья не повод выбирать", () => {
    const text = FIXTURE.replace(
      ",,Итого прямые затраты",
      ",1-100-31,\"Средний разряд работы 3,1\",,,,,чел.-ч,1,,1,,,950.00,,950.00\n,,Итого прямые затраты",
    );
    const { estimates } = parseCustomerLsr([{ name: "ЛСР.xlsx", text }]);

    expect(customerWageRates(estimates).map((item) => item.code)).toEqual(["4-100-040"]);
  });
});
