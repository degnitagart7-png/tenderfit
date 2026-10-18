import { describe, expect, it, vi } from "vitest";

import { EstimateBaseMissingError, buildEstimateFromDocuments, type EstimateRequestInput } from "@/services/estimateService";
import { BIM_PARAMETERS } from "@/test/bimFixtures";
import { EDIT_DOC_TEXT, editFetcher, makeEditBase } from "@/test/billEditFixtures";

/*
  ФЕР-2020 на сервере не собраны. Что видит пользователь: выбрал БИМ сам — отказ с командой сборки; метод вывели из документов
  заказчика — смета считается ресурсно-индексным методом, и в пометках сказано, что метод не тот.
*/

vi.mock("@/repositories/bimRepository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/repositories/bimRepository")>();
  return {
    ...original,
    loadFerBase: vi.fn(async () => {
      throw new original.FerBaseUnavailableError("ФЕР-2020 не собраны: соберите командой npx tsx scripts/fsnb/build-fer2020.ts", "data/fsnb/index");
    }),
  };
});

const NONE = { phase: null, workKind: null, conditionIds: [], newConstructionNorms: false, winterWork: null, workPeriod: null, winterPartId: null } as const;

function input(patch: Partial<EstimateRequestInput> = {}): EstimateRequestInput {
  return {
    regNumber: "0123",
    subject: "Реконструкция",
    documents: [{ name: "ВОР.docx", text: `${EDIT_DOC_TEXT}\nРасценки ФЕР 01-01-001-01 в базисном уровне цен` }],
    parameters: BIM_PARAMETERS,
    priceZoneId: 282,
    priceZoneName: "Белгородская область",
    priceZoneChoice: { basis: "USER", matched: null, northZone: "TERRITORY" },
    now: new Date("2026-10-09T00:00:00.000Z"),
    ...patch,
  };
}

describe("БИМ без ФЕР-2020 на сервере", () => {
  it("метод выведен из документации — считается ресурсно-индексный, пометка BIM_FALLBACK_RIM называет причину", async () => {
    const result = await buildEstimateFromDocuments(input(), { base: makeEditBase(), fetcher: editFetcher });
    expect(result.document.method).toBe("RESOURCE_INDEX");
    const gap = result.document.gaps.find((item) => item.kind === "BIM_FALLBACK_RIM");
    expect(gap?.message).toContain("ФЕР-2020 на сервере не собраны");
    expect(gap?.message).toContain("ресурсно-индексным методом");
  });

  it("метод выбран вручную — отказ с командой сборки, а не тихая подмена", async () => {
    const failure = buildEstimateFromDocuments(input({ options: { ...NONE, method: "BASE_INDEX" } }), { base: makeEditBase(), fetcher: editFetcher });
    await expect(failure).rejects.toBeInstanceOf(EstimateBaseMissingError);
    await expect(failure).rejects.toMatchObject({ command: "npx tsx scripts/fsnb/build-fer2020.ts" });
  });

  it("документация о методе молчит — ресурсно-индексный без пометок о БИМ", async () => {
    const result = await buildEstimateFromDocuments(input({ documents: [{ name: "ВОР.docx", text: EDIT_DOC_TEXT }] }), { base: makeEditBase(), fetcher: editFetcher });
    expect(result.document.method).toBe("RESOURCE_INDEX");
    expect(result.document.gaps.some((item) => item.kind === "BIM_FALLBACK_RIM")).toBe(false);
  });
});
