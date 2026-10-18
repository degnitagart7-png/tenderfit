import { describe, expect, it } from "vitest";

import type { Tender } from "@/domain/entities";
import { nonContractLabel, nonContractReason } from "@/domain/procurementNature";
import { demoTenders } from "@/mocks/tenders";

/** Поставки в ленте подрядчика: прячутся, если человек сам не ищет поставки. */

function tender(subject: string): Tender {
  return { ...demoTenders[0]!, subject, lots: [], okpd2Codes: [] };
}

describe("nonContractReason: поставка товаров", () => {
  const furniture = tender("Поставка медицинской мебели для поликлиники");

  it("у подрядчика поставка прячется с причиной «поставка товаров»", () => {
    expect(nonContractReason(furniture, { words: ["капитальный ремонт"], contractor: true })).toBe("GOODS");
    expect(nonContractLabel({ GOODS: 3 })).toBe("не подряд: поставка товаров");
  });

  it("человек сам ищет поставки — не прячется; не подрядчик — не прячется", () => {
    expect(nonContractReason(furniture, { words: ["поставка мебели"], contractor: true })).toBeNull();
    expect(nonContractReason(furniture, { words: ["ремонт"], contractor: false })).toBeNull();
  });

  it("работы не трогаются", () => {
    expect(nonContractReason(tender("Выполнение работ по ремонту кровли"), { words: [], contractor: true })).toBeNull();
  });
});
