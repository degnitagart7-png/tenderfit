import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PriceZoneRecord } from "@/domain/estimate/priceZoneResolve";
import { buildWageScale } from "@/domain/estimate/wageScale";
import { chooseEstimateZone } from "@/services/estimateZone";
import { fingerprintZoneByCustomerPrices } from "@/services/estimateZoneFingerprint";

/*
  Сборка отпечатка зоны: документы закупки 0134300025826000377 (ЛСР без зоны в шапке, ставки 921,66 и 1 024,91),
  собранные зоны Иркутской области и шкалы, которые отдаёт вызывающий код. Диска здесь нет — шкалы подставлены.
*/

const LSR = readFileSync(path.resolve(__dirname, "../domain/estimate/__fixtures__/t0377/lsr-irkutsk-no-groups.txt"), "utf8");
const DOCUMENTS = [{ name: "ЛСР.xlsx", text: LSR }];

const zoneRecord = (n: number): PriceZoneRecord => ({
  subjectCode: "38",
  subjectName: "Иркутская область",
  zoneName: `Иркутская область (${String(n)} зона)`,
  center: n === 1 ? "г. Иркутск" : "г. Усть-Кут",
  municipalities: n === 1 ? "р-н. Иркутский" : "р-н. Усть-Кутский",
});
const ZONES = [zoneRecord(1), zoneRecord(3)];
const BUILT = [1, 3].map((n) => ({ priceZoneId: 100 + n, zoneName: `Иркутская область (${String(n)} зона)`, subject: "Иркутская область" }));
const TENDER = { region: "Иркутская область", address: "г. Иркутск", customerName: "" };

function scaleOf(id: number) {
  const [worker31, machinist40] = id === 101 ? [586.29, 651.98] : [921.66, 1024.91];
  return buildWageScale(
    [
      { rank: 1, salary: Math.round((worker31 / 1.3) * 100) / 100, source: "реестр" },
      { rank: 3.1, salary: worker31, source: "реестр" },
    ],
    { region: "Иркутская область", zone: `Иркутская область (${id === 101 ? "1" : "3"} зона)`, period: "III квартал 2026" },
    { machinists: [{ rank: 4, salary: machinist40, source: "реестр" }] },
  );
}

describe("fingerprintZoneByCustomerPrices", () => {
  it("ЛСР без зоны в шапке: ставки 921,66 и 1 024,91 дают 3 зону Иркутской области, и выбор зоны идёт по ней, а не по адресу «г. Иркутск»", async () => {
    const loadScale = vi.fn(async (id: number) => scaleOf(id));
    const result = await fingerprintZoneByCustomerPrices(DOCUMENTS, { declared: null, tender: TENDER, zones: ZONES, built: BUILT }, loadScale);

    expect(result.fingerprint).toEqual({ zoneName: "Иркутская область (3 зона)", matchedCodes: ["1-100-31", "4-100-040"] });
    expect(loadScale.mock.calls.map(([id]) => id).sort()).toEqual([101, 103]);

    const choice = chooseEstimateZone({ tender: TENDER, zones: ZONES, built: BUILT, fingerprint: result.fingerprint });
    expect(choice).toMatchObject({ priceZoneId: 103, basis: "CUSTOMER_PRICES" });
  });

  it("ставок другого квартала нет ни у одной зоны — отпечатка нет, причина словами для журнала", async () => {
    const result = await fingerprintZoneByCustomerPrices(
      DOCUMENTS,
      { declared: null, tender: TENDER, zones: ZONES, built: BUILT },
      async () => buildWageScale([{ rank: 1, salary: 500, source: "реестр" }, { rank: 3.1, salary: 700, source: "реестр" }], { region: "x", zone: "Иркутская область (1 зона)", period: "x" }, { machinists: [{ rank: 4, salary: 800, source: "реестр" }] }),
    );

    expect(result.fingerprint).toBeNull();
    expect(result.message).toContain("зона по ценам сметы заказчика не определена");
  });

  it("шкала зоны не читается (null) — зона просто не участвует, ошибки нет", async () => {
    const result = await fingerprintZoneByCustomerPrices(
      DOCUMENTS,
      { declared: null, tender: TENDER, zones: ZONES, built: BUILT },
      async (id) => (id === 101 ? null : scaleOf(id)),
    );

    expect(result.fingerprint?.zoneName).toBe("Иркутская область (3 зона)");
  });

  it("загрузка шкалы упала — тоже не ошибка расчёта", async () => {
    const result = await fingerprintZoneByCustomerPrices(
      DOCUMENTS,
      { declared: null, tender: TENDER, zones: ZONES, built: BUILT },
      async () => {
        throw new Error("диск");
      },
    );

    expect(result.fingerprint).toBeNull();
  });

  it("нет смет заказчика, нет кандидатов — шкалы не читаются вовсе", async () => {
    const loadScale = vi.fn(async (id: number) => scaleOf(id));
    expect(await fingerprintZoneByCustomerPrices([{ name: "Договор", text: "Текст договора" }], { declared: null, tender: TENDER, zones: ZONES, built: BUILT }, loadScale)).toEqual({
      fingerprint: null,
      message: null,
    });
    expect(loadScale).not.toHaveBeenCalled();
  });

  it("субъект неизвестен ни по смете, ни по закупке — сверяются все собранные зоны", async () => {
    const loadScale = vi.fn(async (id: number) => scaleOf(id));
    await fingerprintZoneByCustomerPrices(DOCUMENTS, { declared: null, tender: null, zones: ZONES, built: BUILT }, loadScale);
    expect(loadScale).toHaveBeenCalledTimes(BUILT.length);
  });
});
