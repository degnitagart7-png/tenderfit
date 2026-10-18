import { describe, expect, it } from "vitest";

import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { buildLsrSet, lsrTotalExVat, normalizeLsrNumber } from "@/domain/estimate/customerLsrSet";
import {
  DESCRIPTION_NAME,
  DOCUMENTS_1118,
  LSR_12_TEXT,
  NMCK_NAME,
  TOTALS_EX_VAT,
  TOTALS_WITH_VAT,
} from "@/test/t1118Fixtures";

/*
  Живые вырезки закупки 0302300048726001118: три ЛСР лежат в двух архивах («Обоснование НМЦК» и
  «Описание объекта закупки»), и смета, собранная из обеих копий, получилась бы вдвое больше заказчика.
*/

const parsed = parseCustomerLsr(DOCUMENTS_1118);

describe("parseCustomerLsr: номер, наименование и подпозиции", () => {
  it("номер и название берутся из шапки сметы", () => {
    const numbers = [...new Set(parsed.estimates.map((estimate) => estimate.estimateNumber))].sort();
    expect(numbers).toEqual(["02-02-05/13", "02-02-08", "02-02-12"]);
    const gutter = parsed.estimates.find((estimate) => estimate.estimateNumber === "02-02-12");
    expect(gutter?.title).toContain("Ремонт водосточного желоба");
  });

  it("подпозиции (поставки, оборудование) читаются отдельно и сходятся с итогом сметы без НДС", () => {
    for (const estimate of parsed.estimates) {
      const subs = estimate.subPositions ?? [];
      const sum = [...estimate.positions, ...subs].reduce((total, position) => total + (position.total ?? 0), 0);
      const key = estimate.estimateNumber as keyof typeof TOTALS_EX_VAT;
      expect(Math.abs(sum - TOTALS_EX_VAT[key])).toBeLessThan(0.02);
      expect(estimate.total).toBe(TOTALS_WITH_VAT[key]);
      expect(lsrTotalExVat(estimate)).toBeCloseTo(TOTALS_EX_VAT[key], 2);
    }
  });

  it("подпозиции несут метку, пометку оборудования и пояснения заказчика", () => {
    const ventilation = parsed.estimates.find((estimate) => estimate.estimateNumber === "02-02-08");
    const subs = ventilation?.subPositions ?? [];
    expect(subs.map((position) => position.label)).toContain("3.2");
    const equipment = subs.find((position) => position.label === "1.1");
    expect(equipment?.equipment).toBe(true);
    expect(equipment?.book).toBe("CUSTOMER_PRICE");
    const withNotes = ventilation?.positions.filter((position) => (position.notes ?? []).length > 0) ?? [];
    expect(withNotes.length).toBeGreaterThan(0);
  });

  it("позиции верхнего уровня не изменились: подпозиций среди них нет", () => {
    for (const estimate of parsed.estimates) {
      expect(estimate.positions.every((position) => position.sub !== true)).toBe(true);
    }
  });
});

describe("buildLsrSet: дубль ЛСР из двух архивов берётся один раз", () => {
  const set = buildLsrSet(parsed.estimates);

  it("шесть копий — три сметы", () => {
    expect(parsed.estimates).toHaveLength(6);
    expect(set.entries).toHaveLength(3);
  });

  it("берётся копия из «Описания объекта закупки», а не из «Обоснования НМЦК»", () => {
    for (const entry of set.entries) {
      expect(entry.documentName).toBe(DESCRIPTION_NAME);
      expect(entry.documents).toEqual([NMCK_NAME, DESCRIPTION_NAME]);
    }
  });

  it("видно: «ЛСР 02-02-12 найдена в 2 документах, взята из …»", () => {
    expect(set.notes).toContain(
      `ЛСР 02-02-12 найдена в 2 документах («${NMCK_NAME}», «${DESCRIPTION_NAME}»), взята из «${DESCRIPTION_NAME}»`,
    );
    expect(set.notes).toHaveLength(3);
  });

  it("название раздела нашей сметы — номер и название ЛСР", () => {
    const gutter = set.entries.find((entry) => entry.number === "02-02-12");
    expect(gutter?.sectionTitle.startsWith("ЛСР 02-02-12. ")).toBe(true);
    expect(gutter?.sectionTitle).toContain("водосточного желоба");
  });

  it("порядок документов не влияет на выбор копии", () => {
    const reversed = parseCustomerLsr([...DOCUMENTS_1118].reverse());
    const entries = buildLsrSet(reversed.estimates).entries;
    expect(entries.every((entry) => entry.documentName === DESCRIPTION_NAME)).toBe(true);
  });
});

describe("buildLsrSet: одинаковый номер, разные итоги — обе сметы, с пометкой", () => {
  // Вторая «02-02-12» — другая смета: в позиции изменён итог, итог сметы — тоже.
  const altered = LSR_12_TEXT.replaceAll("52,622.66", "60,000.00");
  const other = parseCustomerLsr([{ name: "Другой комплект.xlsx", text: altered }]);
  const first = parseCustomerLsr([{ name: DESCRIPTION_NAME, text: LSR_12_TEXT }]);
  const set = buildLsrSet([...first.estimates, ...other.estimates]);

  it("итоги разные — не копии", () => {
    expect(first.estimates[0]?.total).toBe(52_622.66);
    expect(other.estimates[0]?.total).toBe(60_000);
    expect(set.entries).toHaveLength(2);
  });

  it("у обеих пометка, названия разделов различаются", () => {
    expect(set.entries.every((entry) => entry.sharedNumber)).toBe(true);
    expect(set.entries[0]?.sectionTitle).not.toBe(set.entries[1]?.sectionTitle);
    expect(set.entries[1]?.sectionTitle).toContain("вариант 2");
    expect(set.notes.filter((note) => note.includes("номер повторяется"))).toHaveLength(2);
  });
});

describe("normalizeLsrNumber", () => {
  it("«02-02-05/13» и «02-02-05-13» — один номер", () => {
    expect(normalizeLsrNumber("02-02-05/13")).toBe(normalizeLsrNumber(" 02-02-05-13 "));
    expect(normalizeLsrNumber(null)).toBeNull();
  });
});
