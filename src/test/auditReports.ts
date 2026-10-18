import { auditCustomerLsr, type AuditReport } from "@/domain/estimate/customerAudit";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { REAL_A_WITH_TOTALS } from "@/domain/estimate/customerLsr.fixtures";
import type { AuditJobData } from "@/hooks/useEstimateJob";
import { ANCHORS, makeBook } from "@/test/auditPriceBook";

/**
 * Готовые отчёты аудита для тестов интерфейса и Word-отчёта: не выдуманные структуры, а то,
 * что реально возвращает `auditCustomerLsr` на смете A (образец из prod).
 */

function lsrA() {
  const parsed = parseCustomerLsr([{ name: "Локальный сметный расчет.xlsx", text: REAL_A_WITH_TOTALS }]);
  return parsed.estimates[0]!;
}

/** Труд у нас дороже на 10 %, НР и СП по приказу ниже, чем у заказчика: все группы заполнены. */
export function reportWithFindings(): AuditReport {
  const book = makeBook({
    anchors: ANCHORS.map((anchor) => ({ ...anchor, salary: Math.round(anchor.salary * 1.1 * 100) / 100 })),
    rates: { "Пр/812-090.0": 85, "Пр/774-090.0": 40, "Пр/812-091.0": 89, "Пр/774-091.0": 49 },
  });
  return auditCustomerLsr(lsrA(), { priceBook: book });
}

/** Нашей цены на труд нет: почти вся смета не проверена, покрытие ниже 70 %. */
export function reportLowCoverage(): AuditReport {
  return auditCustomerLsr(lsrA(), { priceBook: makeBook({ anchors: [] }) });
}

/** Наша книга совпадает с ценами заказчика: разницы нет. */
export function reportMatching(): AuditReport {
  return auditCustomerLsr(lsrA(), { priceBook: makeBook() });
}

export function auditData(reports: readonly AuditReport[], extra: Partial<AuditJobData> = {}): AuditJobData {
  return {
    reports,
    zone: { priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)", basis: "USER", matched: null, northZone: "TERRITORY" },
    period: "3 квартал 2026 г.",
    notRecognized: [],
    ...extra,
  };
}
