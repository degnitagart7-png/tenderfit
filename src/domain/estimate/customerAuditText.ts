import type {
  AuditFinding,
  AuditFindingType,
  AuditReport,
  ImpactGroup,
  UncheckedItem,
} from "@/domain/estimate/customerAudit";

/**
 * Подписи аудита сметы заказчика для экрана и отчёта Word.
 *
 * Один набор текстов на оба места: карточка и подраздел отчёта обязаны говорить одно
 * и то же теми же словами и числами, иначе человек, сверяющий экран с файлом, найдёт
 * «расхождение» там, где разошлись только формулировки.
 */

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** «240 000 ₽»; со знаком — «+240 000 ₽» / «−3 200 ₽». */
export function formatRub(value: number, signed = false): string {
  const rounded = Math.round(value);
  const text = `${RUB.format(Math.abs(rounded))} ₽`;
  if (!signed) return rounded < 0 ? `−${text}` : text;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${text}`;
}

export function formatPercent(value: number): string {
  return `${Math.abs(value).toFixed(1).replace(".", ",")} %`;
}

/**
 * Процент со знаком: «+4,9 %», «−12,0 %». Значение, которое при одном знаке после запятой даёт ноль («−0,04»), печатается «0,0 %» без
 * знака: «−0,0 %» читается как отрицательная разница там, где её нет.
 */
export function formatSignedPercent(value: number): string {
  const text = formatPercent(value);
  if (Math.round(Math.abs(value) * 10) === 0) return text;
  return `${value < 0 ? "−" : "+"}${text}`;
}

/** «Республика Бурятия (5 зона)», «3 квартал 2026 г.» → «Республика Бурятия, 5 зона, 3 кв. 2026». */
export function zoneLabel(zoneName: string, period: string): string {
  const zone = /^(.*?)\s*\((\d+\s*зона)\)\s*$/u.exec(zoneName);
  const place = zone === null ? zoneName : `${zone[1] as string}, ${zone[2] as string}`;
  const quarter = /(\d)\s*квартал\s*(\d{4})/u.exec(period);
  const when = quarter === null ? period : `${quarter[1] as string} кв. ${quarter[2] as string}`;
  return `${place}, ${when}`;
}

/** Смета БИМ: итог в её же уровне цен пересчитан по ФЕР-2020 и индексам письма. */
export const isBimReport = (report: AuditReport): boolean => report.method === "BASE_INDEX";

/** «Республика Бурятия, 5 зона» для сметы БИМ; субъект не определён — так и сказано. */
function bimWhere(report: AuditReport): string {
  const subject = report.bim?.subject ?? null;
  if (subject === null) return "субъект не определён";
  return `${subject}${report.bim?.zone == null ? "" : `, ${String(report.bim.zone)} зона`}`;
}

/** «Смета заказчика: … · по нашим ценам (…): … · НМЦК занижена на … (…)» — шапка карточки и отчёта. */
export function auditHeadline(report: AuditReport): string {
  if (isBimReport(report)) {
    return (
      `Смета заказчика (базисно-индексный метод): ${formatRub(report.customerTotal)}${report.totalMissing ? " (итога в тексте нет — сумма позиций)" : ""}` +
      ` · по ФЕР-2020 и индексам Минстроя (${bimWhere(report)}, ${report.period}): ${formatRub(report.repricedTotal)}` +
      ` · ${report.conclusion}`
    );
  }
  return (
    `Смета заказчика: ${formatRub(report.customerTotal)}${report.totalMissing ? " (итога в тексте нет — сумма позиций)" : ""}` +
    ` · по нашим ценам (${zoneLabel(report.zone, report.period)}): ${formatRub(report.repricedTotal)}` +
    ` · ${report.conclusion}`
  );
}

export function coverageText(report: AuditReport): string {
  return `проверено ${String(Math.round(report.coverage * 100))} % прямых затрат`;
}

export interface BreakdownLine {
  readonly group: ImpactGroup | "OUTDATED" | "SOURCE_INDEX" | "SOURCE_BASE";
  readonly text: string;
  /** Сумма влияния; null — строка без суммы. */
  readonly amount: number | null;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «Откуда разница»: группы с ненулевым влиянием и находки без суммы. */
export function auditBreakdown(report: AuditReport): BreakdownLine[] {
  const lines: BreakdownLine[] = [];
  const { impacts } = report;
  const significant = (group: ImpactGroup): boolean => Math.abs(impacts[group].amount) >= 0.5 || impacts[group].count > 0;

  const rows = (count: number): string => `${String(count)} ${plural(count, "строка", "строки", "строк")}`;
  const positions = (count: number): string => `${String(count)} ${plural(count, "позиция", "позиции", "позиций")}`;

  if (significant("LABOUR")) {
    lines.push({
      group: "LABOUR",
      amount: impacts.LABOUR.amount,
      text: `Труд (с НР и СП на него): ${formatRub(impacts.LABOUR.amount, true)} (${rows(impacts.LABOUR.count)})`,
    });
  }
  if (significant("MACHINES")) {
    lines.push({
      group: "MACHINES",
      amount: impacts.MACHINES.amount,
      text: `Машины: ${formatRub(impacts.MACHINES.amount, true)} (${rows(impacts.MACHINES.count)})`,
    });
  }
  if (significant("MATERIALS")) {
    lines.push({
      group: "MATERIALS",
      amount: impacts.MATERIALS.amount,
      text: `Материалы: ${formatRub(impacts.MATERIALS.amount, true)} (${rows(impacts.MATERIALS.count)})`,
    });
  }
  if (report.vat.included && impacts.VAT.count > 0) {
    lines.push({
      group: "VAT",
      amount: impacts.VAT.amount,
      text: `НДС ${String(report.vat.customerPercent ?? "")} % вместо ${String(report.vat.ourPercent)} %: ${formatRub(impacts.VAT.amount, true)}`,
    });
  }
  if (significant("OVERHEAD")) {
    lines.push({
      group: "OVERHEAD",
      amount: impacts.OVERHEAD.amount,
      text: `Накладные не по приказу 812/пр: ${formatRub(impacts.OVERHEAD.amount, true)} (${positions(impacts.OVERHEAD.count)})`,
    });
  }
  if (significant("PROFIT")) {
    lines.push({
      group: "PROFIT",
      amount: impacts.PROFIT.amount,
      text: `Сметная прибыль не по приказу 774/пр: ${formatRub(impacts.PROFIT.amount, true)} (${positions(impacts.PROFIT.count)})`,
    });
  }
  if (impacts.ARITHMETIC.count > 0) {
    const discrepancy = impacts.ARITHMETIC.discrepancy ?? 0;
    lines.push({
      group: "ARITHMETIC",
      amount: impacts.ARITHMETIC.amount,
      text: `Арифметические ошибки: ${rows(impacts.ARITHMETIC.count)}, расхождение ${formatRub(discrepancy)}`,
    });
  }
  // Смета БИМ: те же суммы, но по источнику — из каких проверок они взялись (входят в группы выше, а не прибавляются к ним).
  if (isBimReport(report) && report.bim !== undefined) {
    const { indices, basePrices } = report.bim.impactBySource;
    if (Math.abs(indices) >= 0.5) {
      lines.push({ group: "SOURCE_INDEX", amount: indices, text: `Из них индексы (письмо Минстроя): ${formatRub(indices, true)}` });
    }
    if (Math.abs(basePrices) >= 0.5) {
      lines.push({ group: "SOURCE_BASE", amount: basePrices, text: `Из них базисные цены расценок (ФЕР-2020): ${formatRub(basePrices, true)}` });
    }
  }
  const outdated = report.findings.find((finding) => finding.type === "OUTDATED_PRICE_LEVEL");
  if (outdated !== undefined) lines.push({ group: "OUTDATED", amount: null, text: outdated.message });
  return lines;
}

/**
 * Что проверено в смете БИМ и что нет, одной строкой на предмет: индексы, базисные цены, нормативы НР и СП.
 * Те же строки в карточке и в отчёте Word; у ресурсной сметы пусто.
 */
export function bimDetailLines(report: AuditReport): string[] {
  const bim = report.bim;
  if (!isBimReport(report) || bim === undefined) return [];
  const lines: string[] = [];
  for (const finding of report.findings) {
    if (finding.type === "INDEX_VALUE" || finding.type === "INDEX_QUARTER") lines.push(finding.message);
  }
  lines.push(`Индексы: ${bim.indexNote}`);
  if (bim.object !== null) lines.push(`Объект строительства по наименованию стройки: ${bim.object}`);
  else if (bim.objectCandidates.length > 0) lines.push(`Объект строительства однозначно не определён: ${bim.objectReason ?? ""}`);
  const checks = bim.baseChecks;
  const parts: string[] = [];
  if (checks.compared > 0) parts.push(`сверено с ФЕР-2020 ${String(checks.compared)} (совпало ${String(checks.matched)}, расходится ${String(checks.mismatched)})`);
  if (checks.terNotChecked > 0) parts.push(`ТЕР ${bim.subject ?? "региона"} — базисные цены не проверены, нет открытой базы: ${String(checks.terNotChecked)}`);
  if (checks.otherNotChecked > 0) parts.push(`корпоративные расценки, не с чем сравнить: ${String(checks.otherNotChecked)}`);
  if (checks.notFound > 0) parts.push(`шифра нет в ФЕР-2020: ${String(checks.notFound)}`);
  if (parts.length > 0) lines.push(`Базисные цены расценок: ${parts.join("; ")}`);
  lines.push(`НР и СП: ${bim.overheadNote}`);
  return lines;
}

const FINDING_TITLE: Record<AuditFindingType, string> = {
  RESOURCE_PRICE: "Цены ресурсов",
  OUR_PRICE_MISSING: "Нашей цены нет",
  CUSTOMER_PRICE_NO_COMPARE: "Цена заказчика по КП — не с чем сравнить",
  UNIT_MISMATCH: "Единицы различаются",
  ARITHMETIC: "Арифметика",
  OVERHEAD_RATE: "Накладные расходы (НР)",
  PROFIT_RATE: "Сметная прибыль (СП)",
  RATE_NOT_CHECKED: "Норматив не проверен",
  COEFFICIENTS: "Коэффициенты к затратам",
  LIMITED_COSTS: "Зимнее удорожание и временные здания",
  OUTDATED_PRICE_LEVEL: "Уровень цен",
  VAT_RATE: "НДС",
  ZONE_MISMATCH: "Ценовая зона",
  SECTIONS_SUM: "Итоги разделов",
  BASE_PRICE: "Базисные цены (ФСБЦ-2022)",
  INDEX_VALUE: "Индексы пересчёта (письмо Минстроя)",
  INDEX_QUARTER: "Квартал индексов",
  INDEX_NOT_CHECKED: "Индексы не сверены",
  FER_PRICE: "Базисные цены расценок (ФЕР-2020)",
  BASE_NOT_CHECKED: "Базисные цены и нормативы не проверены",
};

export interface FindingList {
  readonly type: AuditFindingType;
  readonly title: string;
  readonly items: readonly AuditFinding[];
}

/** Порядок и состав списков находок: от денег к справочному. */
const FINDING_ORDER: readonly AuditFindingType[] = [
  "RESOURCE_PRICE",
  "INDEX_VALUE",
  "FER_PRICE",
  "INDEX_QUARTER",
  "OVERHEAD_RATE",
  "PROFIT_RATE",
  "ARITHMETIC",
  "VAT_RATE",
  "ZONE_MISMATCH",
  "OUTDATED_PRICE_LEVEL",
  "SECTIONS_SUM",
  "BASE_PRICE",
  "INDEX_NOT_CHECKED",
  "BASE_NOT_CHECKED",
  "LIMITED_COSTS",
  "COEFFICIENTS",
];

/** Находки по типам; ресурсные — по убыванию влияния. «Не проверено» — отдельным списком. */
export function findingLists(report: AuditReport): FindingList[] {
  const lists: FindingList[] = [];
  for (const type of FINDING_ORDER) {
    const items = report.findings.filter((finding) => finding.type === type);
    if (items.length === 0) continue;
    const sorted =
      type === "RESOURCE_PRICE"
        ? [...items].sort((a, b) => Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0))
        : items;
    lists.push({ type, title: FINDING_TITLE[type], items: sorted });
  }
  return lists;
}

const UNCHECKED_KIND: Record<UncheckedItem["kind"], string> = {
  OUR_PRICE_MISSING: "нашей цены нет",
  CUSTOMER_PRICE: "цена заказчика по КП — не с чем сравнить",
  UNIT_MISMATCH: "единицы различаются",
  NO_RESOURCES: "в смете нет ресурсов позиции",
  TER_NO_BASE: "ТЕР региона — открытой базы нет, базисная цена не проверена",
  OTHER_BASE: "расценка не из ФЕР и не из ТЕР (корпоративная) — не с чем сравнить",
  RATE_NOT_FOUND: "шифра нет в ФЕР-2020",
  COEFFICIENTS_UNPARSED: "поправочные коэффициенты не разобраны — цена не сверена",
};

export function uncheckedLine(item: UncheckedItem): string {
  const name = item.name === "" ? "" : ` ${item.name.slice(0, 60)}`;
  return `${item.code}${name} — ${UNCHECKED_KIND[item.kind]}; позиций ${String(item.positions)}, у заказчика ${formatRub(item.amount)}`;
}

/**
 * «Смета “…” — не форма 421/пр, построчно не проверена». Смета БИМ, которую нечем проверить (нет ФЕР-2020), форму 421/пр не
 * нарушает: причина названа в самой строке.
 */
export function notRecognizedLine(item: { documentName: string; estimateName: string | null; reason: string }): string {
  const name = item.estimateName ?? item.documentName;
  if (/^смета по базисно-индексному методу/iu.test(item.reason)) return `Смета «${name}» — построчно не проверена (${item.reason})`;
  return `Смета «${name}» — не форма 421/пр, построчно не проверена (${item.reason})`;
}

/**
 * Причины разницы без двойного счёта: те же строки «откуда разница» (`auditBreakdown`), но только со суммой и без вложенных.
 * У ресурсной сметы это группы: труд, машины, материалы, НДС, НР, СП, арифметика. У сметы БИМ группы по элементам и
 * разбивка по источникам — две нарезки одних и тех же денег, поэтому берётся нарезка по источникам: индексы, базисные цены
 * расценок, нормативы НР и СП, арифметика. Для заключения по смете: из них берутся главные причины.
 */
export function auditReasons(report: AuditReport): BreakdownLine[] {
  const lines = auditBreakdown(report).filter((line) => line.amount !== null);
  if (!isBimReport(report) || report.bim === undefined) return lines;
  const { indices, basePrices, norms } = report.bim.impactBySource;
  const result: BreakdownLine[] = [];
  if (Math.abs(indices) >= 0.5) {
    result.push({ group: "SOURCE_INDEX", amount: indices, text: `Индексы пересчёта (письмо Минстроя): ${formatRub(indices, true)}` });
  }
  if (Math.abs(basePrices) >= 0.5) {
    result.push({ group: "SOURCE_BASE", amount: basePrices, text: `Базисные цены расценок (ФЕР-2020): ${formatRub(basePrices, true)}` });
  }
  if (Math.abs(norms) >= 0.5) {
    result.push({ group: "OVERHEAD", amount: norms, text: `Нормативы НР и СП не по приказам 812/пр и 774/пр: ${formatRub(norms, true)}` });
  }
  const arithmetic = lines.find((line) => line.group === "ARITHMETIC");
  if (arithmetic !== undefined) result.push(arithmetic);
  return result;
}

export interface UncheckedSummary {
  /** Позиции, по которым не переоценено ничего (`checkedShare` = 0), и их стоимость у заказчика, ₽. */
  readonly positions: number;
  readonly amount: number;
  /** Позиции, переоценённые частично: часть ресурсов осталась по цене заказчика. */
  readonly partial: number;
  /** Строки ресурсов, которые не удалось переоценить, по причинам: число строк и стоимость у заказчика, ₽. */
  readonly byReason: readonly { readonly kind: UncheckedItem["kind"]; readonly label: string; readonly rows: number; readonly amount: number }[];
}

/** Что не удалось переоценить и почему: для вывода в заключении. Тексты причин — те же, что в списке «Не проверено». */
export function uncheckedSummary(report: AuditReport): UncheckedSummary {
  const none = report.positions.filter((position) => position.checkedShare <= 0);
  const partial = report.positions.filter((position) => position.checkedShare > 0 && position.checkedShare < 0.999);
  const reasons = new Map<UncheckedItem["kind"], { rows: number; amount: number }>();
  for (const item of report.unchecked) {
    const entry = reasons.get(item.kind) ?? { rows: 0, amount: 0 };
    reasons.set(item.kind, { rows: entry.rows + item.positions, amount: entry.amount + item.amount });
  }
  return {
    positions: none.length,
    amount: none.reduce((sum, position) => sum + position.customerTotal, 0),
    partial: partial.length,
    byReason: [...reasons.entries()]
      .map(([kind, value]) => ({ kind, label: UNCHECKED_KIND[kind], rows: value.rows, amount: value.amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/** Короткие русские подписи флагов позиции для экрана: сырые коды типов находок пользователю не показываются. */
export const FINDING_FLAG_LABEL: Readonly<Record<AuditFindingType, string>> = {
  RESOURCE_PRICE: "цены ресурсов",
  OUR_PRICE_MISSING: "нет нашей цены",
  CUSTOMER_PRICE_NO_COMPARE: "цена по КП",
  UNIT_MISMATCH: "единицы различаются",
  ARITHMETIC: "арифметика",
  OVERHEAD_RATE: "норматив НР",
  PROFIT_RATE: "норматив СП",
  RATE_NOT_CHECKED: "норматив не проверен",
  COEFFICIENTS: "коэффициенты к норме",
  LIMITED_COSTS: "зимнее и временные здания",
  OUTDATED_PRICE_LEVEL: "устаревший уровень цен",
  VAT_RATE: "ставка НДС",
  ZONE_MISMATCH: "другая ценовая зона",
  SECTIONS_SUM: "итоги разделов",
  BASE_PRICE: "базисная цена",
  INDEX_VALUE: "индексы",
  INDEX_QUARTER: "квартал индексов",
  INDEX_NOT_CHECKED: "индексы не сверены",
  FER_PRICE: "цена ФЕР-2020",
  BASE_NOT_CHECKED: "не проверено",
};

/** Подпись флага; неизвестный код (отчёт новее экрана) — нейтральное слово, а не сырой код. */
export function flagLabel(flag: string): string {
  return (FINDING_FLAG_LABEL as Record<string, string>)[flag] ?? "особенность расчёта";
}
