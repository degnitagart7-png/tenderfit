import { describe, expect, it, vi } from "vitest";

vi.mock("@/repositories/tenderRepository", () => ({ tenderRepository: {} }));

import type { Tender } from "@/domain/entities";
import { EisBlockedError } from "@/lib/eisGate";
import { describeLinkImport, importTendersByLink, type LinkImportDeps } from "@/services/tenderLinkImport";

function tender(regNumber: string, submissionEnd = "2026-10-30T10:00:00.000Z"): Tender {
  return {
    regNumber,
    externalId: regNumber,
    law: "FZ_44",
    placingWay: "EA",
    subject: "Ремонт кровли",
    customerName: "Школа",
    customerInn: "0300000000",
    region: "Республика Бурятия",
    deliveryAddress: "",
    financial: { price: 1_000_000, currency: "RUB", advancePercent: null, bidSecurityAmount: null, contractSecurityAmount: null },
    deadlines: { submissionEnd, publicationDate: "", lastUpdateDate: "", deliveryTermDays: null },
    okpd2Codes: [],
    lots: [],
    requirements: [],
    nationalRegime: false,
    onlyForSmp: false,
    eisUrl: `https://zakupki.gov.ru/?regNumber=${regNumber}`,
    dataSource: "EIS",
  } as unknown as Tender;
}

function deps(patch: Partial<LinkImportDeps> = {}): LinkImportDeps & { saved: unknown[]; marked: string[] } {
  const saved: unknown[] = [];
  const marked: string[] = [];
  return {
    saved,
    marked,
    find: async () => null,
    fetchFromEis: async (n) => tender(n),
    save: async (row) => {
      saved.push(row);
    },
    markLink: async (n) => {
      marked.push(n);
    },
    now: () => Date.parse("2026-10-13T12:00:00.000Z"),
    ...patch,
  };
}

describe("importTendersByLink", () => {
  it("закупки нет в базе — берётся из ЕИС и пишется с пометкой «link»", async () => {
    const d = deps();
    const report = await importTendersByLink(["0302300083426000012"], d);

    expect(report.added).toEqual(["0302300083426000012"]);
    expect(d.saved[0]).toMatchObject({
      reg_number: "0302300083426000012",
      data_source: "EIS",
      raw_data: { origin: "link", at: "2026-10-13T12:00:00.000Z" },
    });
  });

  it("уже в базе без пометки — помечается, чтобы плановая очистка её не удалила; с пометкой «live» — не трогается", async () => {
    const plain = deps({ find: async () => ({ raw_data: null }) });
    expect((await importTendersByLink(["32616407955"], plain)).existing).toEqual(["32616407955"]);
    expect(plain.marked).toEqual(["32616407955"]);

    const live = deps({ find: async () => ({ raw_data: { origin: "live", query: "кровля" } }) });
    await importTendersByLink(["32616407955"], live);
    expect(live.marked).toEqual([]);
  });

  it("в ЕИС не нашлась или без срока подачи — «не найдено», и причина понятна", async () => {
    const d = deps({ fetchFromEis: async (n) => (n.endsWith("1") ? null : tender(n, "")) });
    const report = await importTendersByLink(["32616400001", "32616400002"], d);

    expect(report.notFound).toEqual(["32616400001", "32616400002"]);
    expect(describeLinkImport(report)).toMatch(/в ЕИС не найдено: 32616400001, 32616400002/);
  });

  it("блокировка ЕИС останавливает добавление и попадает в отчёт", async () => {
    const d = deps({
      fetchFromEis: async () => {
        throw new EisBlockedError(Date.parse("2026-10-13T12:30:00.000Z"), 434);
      },
    });
    const report = await importTendersByLink(["0302300083426000012", "32616407955"], d);

    expect(report.added).toEqual([]);
    expect(report.blocked).toMatch(/ЕИС временно ограничила доступ/);
  });
});
