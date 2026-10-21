import type { BidCostBase, BidEconomicsInput } from "@/domain/estimate/bidEconomics";
import type { AuditReport } from "@/domain/estimate/customerAudit";

/**
 * «Экономика участия» по проверке сметы заказчика.
 *
 * Расчёт сметы даёт нашу смету по ведомости. Проверка (`mode: "audit"`) даёт другое: смету заказчика — его объёмы и расход
 * ресурсов, — пересчитанную по нашим ценам зоны и квартала и нашим нормативам НР и СП. Для подрядчика это и есть «сколько
 * стоит сделать то, что просит заказчик»: основа себестоимости, а НМЦК — итог самой сметы заказчика (цены закупки в проверке
 * нет). Здесь отчёт проверки превращается во вход `computeBidEconomics`.
 *
 * Что не берётся. Сметы БИМ и отчёты, посчитанные до появления `ourCosts`, разбивки по группам не имеют: вся пересчитанная
 * сумма идёт одной строкой (`AUDIT_LUMP`) и принимается за себестоимость целиком. Это осторожная оценка, она названа в пометках.
 *
 * Модуль чистый.
 */

const VAT_DENOMINATOR = (percent: number): number => 1 + percent / 100;

export interface AuditBidBase {
  /** Основа по группам затрат, ₽ без НДС. */
  readonly costBase: BidCostBase;
  /** НМЦК по умолчанию: итог сметы заказчика (с НДС, если он с НДС). */
  readonly nmc: number;
  readonly nmcIncludesVat: boolean;
  /** Доля затрат, которую не удалось переоценить, %. */
  readonly unverifiedPercent: number;
  /** Позиций в смете: знаменатель в пометках. */
  readonly billItems: number;
}

export function auditBidBase(report: AuditReport): AuditBidBase {
  const vatPercent = report.vat.ourPercent;
  const repricedBeforeVat = report.vat.included ? report.repricedTotal / VAT_DENOMINATOR(vatPercent) : report.repricedTotal;
  const ours = report.ourCosts;
  const costBase: BidCostBase =
    ours === undefined
      ? {
          labour: 0,
          machines: 0,
          materials: 0,
          other: repricedBeforeVat,
          overhead: 0,
          profit: 0,
          limited: 0,
          beforeVat: repricedBeforeVat,
          vatPercent,
          origin: "AUDIT_LUMP",
        }
      : {
          labour: ours.labour,
          machines: ours.machines,
          materials: ours.materials,
          other: ours.other,
          overhead: ours.overhead,
          profit: ours.profit,
          limited: 0,
          beforeVat: repricedBeforeVat,
          vatPercent,
          origin: "AUDIT",
        };
  return {
    costBase,
    nmc: report.customerTotal,
    nmcIncludesVat: report.vat.included,
    unverifiedPercent: Math.max(0, Math.min(100, (1 - report.coverage) * 100)),
    billItems: report.positions.length,
  };
}

/** Вход `computeBidEconomics` по отчёту проверки; профиль компании, НМЦК и допущения добавляет вызывающий код. */
export function auditBidInput(
  report: AuditReport,
  company: BidEconomicsInput["company"],
  extra: Partial<Pick<BidEconomicsInput, "costProfile" | "nmcIncludesVat" | "law">> & { readonly nmc?: number | null } = {},
): BidEconomicsInput {
  const base = auditBidBase(report);
  return {
    costBase: base.costBase,
    nmc: extra.nmc === undefined ? base.nmc : extra.nmc,
    billItems: base.billItems,
    droppedPositions: 0,
    assumedPercent: 0,
    unpricedResources: 0,
    unverifiedPercent: base.unverifiedPercent,
    company,
    nmcIncludesVat: extra.nmcIncludesVat ?? base.nmcIncludesVat,
    ...(extra.costProfile === undefined ? {} : { costProfile: extra.costProfile }),
    ...(extra.law === undefined ? {} : { law: extra.law }),
  };
}

/**
 * Основа по всем сметам закупки вместе: суммы групп затрат складываются, НМЦК — сумма итогов смет заказчика. Сметы с НДС и без него
 * приводятся к НДС по нашей ставке (иначе их складывать нельзя). Сметы без разбивки по группам (БИМ, отчёты, посчитанные раньше)
 * идут в «прочие» целиком; если разбивки нет ни у одной — основа «одной суммой». Непереоценённая доля — взвешенная по прямым затратам.
 */
export function auditBidBaseTotal(reports: readonly AuditReport[]): AuditBidBase | null {
  if (reports.length === 0) return null;
  const withVat = reports.filter((report) => report.vat.included).length;
  const mixed = withVat > 0 && withVat < reports.length;
  const includesVat = withVat === reports.length || mixed;
  const vatPercent = reports[0]!.vat.ourPercent;
  const total = { labour: 0, machines: 0, materials: 0, other: 0, overhead: 0, profit: 0, beforeVat: 0, nmc: 0, checked: 0, direct: 0 };
  let withGroups = 0;
  for (const report of reports) {
    const base = auditBidBase(report).costBase;
    total.labour += base.labour;
    total.machines += base.machines;
    total.materials += base.materials;
    total.other += base.other;
    total.overhead += base.overhead;
    total.profit += base.profit;
    total.beforeVat += base.beforeVat;
    // НМЦК — с НДС; у сметы без НДС (БИМ) итог дополняется нашим НДС, когда набор смешанный.
    total.nmc += mixed && !report.vat.included ? report.customerTotal * (1 + report.vat.ourPercent / 100) : report.customerTotal;
    total.checked += report.checkedDirect;
    total.direct += report.totalDirect;
    if (base.origin === "AUDIT") withGroups += 1;
  }
  return {
    costBase: {
      labour: total.labour,
      machines: total.machines,
      materials: total.materials,
      other: total.other,
      overhead: total.overhead,
      profit: total.profit,
      limited: 0,
      beforeVat: total.beforeVat,
      vatPercent,
      origin: withGroups > 0 ? "AUDIT" : "AUDIT_LUMP",
    },
    nmc: total.nmc,
    nmcIncludesVat: includesVat,
    unverifiedPercent: total.direct > 0 ? Math.max(0, Math.min(100, (1 - total.checked / total.direct) * 100)) : 100,
    billItems: reports.reduce((sum, report) => sum + report.positions.length, 0),
  };
}
