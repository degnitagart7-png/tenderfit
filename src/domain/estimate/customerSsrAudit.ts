import { chapterAmount, type CustomerSsr } from "@/domain/estimate/customerSsr";
import { computeForecastInflation, periodText, type InflationResult } from "@/domain/estimate/forecastInflation";
import type { SsrContractRowId, SsrPurpose, SsrResult } from "@/domain/estimate/ssr";
import { reserveLimitPercent, reserveRate, SSR } from "@/domain/estimate/ssrNormatives";
import type { SsrGroupId } from "@/domain/estimate/ssrTypes";

/**
 * Аудит сводного сметного расчёта заказчика: где он ошибся и на сколько это двигает НМЦК.
 *
 * Что проверяется (все числа — арифметика над разобранным ССР и справочниками, модели нет):
 * 1. Резерв на непредвиденные: процент против предела 421/пр п. 179 (2 % непроизводственные, 3 %
 *    производственные и линейные, 10 % уникальные) и база — итог глав 1-12 (п. 179, 142).
 * 2. Индекс прогнозной инфляции против нашего по срокам (841/пр п. 22-23, дефляторы Минэкономразвития);
 *    отсутствие индекса, когда срок известен.
 * 3. Арифметика: итог каждой главы против суммы её строк, итоги по главам 1-7, 1-8, 1-9, 1-12 против суммы
 *    глав (п. 143), сумма НДС (п. 181), итог всего расчёта.
 * 4. Ставка НДС против нашей.
 * 5. Главы 10-12 (содержание службы заказчика и строительный контроль, эксплуатационные кадры, ПИР и
 *    авторский надзор) и строки заказчика главы 9 в цене контракта: по 841/пр п. 21 в НМЦК подрядных
 *    работ входят только затраты, относящиеся к предмету закупки.
 *
 * Знак влияния — как в аудите ЛСР: влияние = «как должно быть» минус «как у заказчика», в рублях НМЦК
 * (с НДС и инфляцией заказчика). Плюс — НМЦК занижена, минус — завышена.
 *
 * Принцип «лучше не найдено, чем ложная находка»: чего заказчик не напечатал или что не разобрано,
 * не проверяется; находки по таким данным не строятся.
 */

export interface SsrAuditContext {
  /** Назначение объекта для предела резерва: выбор пользователя, вид работ или значение по умолчанию. */
  readonly purpose: SsrPurpose;
  /** Наша ставка НДС, %. */
  readonly vatPercent: number;
  /** НМЦК закупки, ₽; null — не объявлена. */
  readonly nmc: number | null;
  readonly nmcIncludesVat: boolean;
  /** Наш индекс по срокам пользователя; используется, когда заказчик период не назвал. */
  readonly ourInflation: InflationResult | null;
  /** ISO-дата определения НМЦК. */
  readonly priceDate: string | null;
  readonly today: string;
  /** Наш ССР: для сравнения по строкам. */
  readonly ourSsr?: SsrResult | null;
}

export type SsrAuditFindingType =
  | "CHAPTER_SUM"
  | "GROUP_SUM"
  | "RESERVE_PERCENT"
  | "RESERVE_BASE"
  | "INFLATION_INDEX"
  | "INFLATION_MISSING"
  | "INFLATION_ARITHMETIC"
  | "VAT_RATE"
  | "VAT_ARITHMETIC"
  | "TOTAL_ARITHMETIC"
  | "CUSTOMER_SCOPE"
  | "UNIT_ASSUMED"
  /** Расчёт НМЦК заказчика (приложения к обоснованию, `customerNmck.ts`). */
  | "NMCK_FUTURE_ACTUAL_INDEX"
  | "NMCK_MONTHLY_INDEX"
  | "NMCK_FORECAST_INDEX"
  | "NMCK_LSR_LABEL"
  | "NMCK_LIMIT_UNEVEN";

export type SsrAuditSeverity = "WARNING" | "INFO";

export interface SsrAuditFinding {
  readonly type: SsrAuditFindingType;
  readonly severity: SsrAuditSeverity;
  readonly message: string;
  /** Влияние на НМЦК, ₽ (плюс — НМЦК занижена, минус — завышена); null — без суммы. */
  readonly impact: number | null;
  /** Пункт приказа, на котором стоит находка. */
  readonly ref: string;
}

export interface SsrCompareRow {
  readonly id: SsrContractRowId;
  readonly label: string;
  /** Наша оценка по строке, ₽. */
  readonly ours: number;
  /** У заказчика, ₽; null — строка в его расчёте не найдена. */
  readonly customer: number | null;
  /** Наша минус заказчика; null, если у заказчика строки нет. */
  readonly diff: number | null;
}

export interface SsrAuditReport {
  readonly documentName: string;
  readonly estimateName: string | null;
  readonly findings: readonly SsrAuditFinding[];
  readonly warnings: number;
  readonly customer: {
    readonly chaptersTotal: number | null;
    readonly reservePercent: number | null;
    readonly inflationIndex: number | null;
    readonly vatPercent: number | null;
    readonly total: number | null;
    readonly unitMultiplier: 1 | 1000;
  };
  /** Наш индекс для срока заказчика (или пользователя) и строка расчёта; null — срок неизвестен. */
  readonly ourInflation: InflationResult | null;
  readonly inflationPeriod: string | null;
  readonly rows: readonly SsrCompareRow[];
  readonly conclusion: string;
}

const rubFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub = (value: number): string => `${rubFormat.format(Math.round(Math.abs(value)))} ₽`;
const signedRub = (value: number): string => `${value < 0 ? "−" : "+"}${rub(value)}`;
const pct = (value: number): string => `${String(Number(value.toFixed(2))).replace(".", ",")} %`;
const num4 = (value: number): string => value.toFixed(4).replace(".", ",");

/** Строки главы 9 и других глав, которые по тексту относятся к затратам заказчика. */
const CUSTOMER_LINE_RE =
  /строительн[а-яё]*\s+контрол|авторск[а-яё]*\s+надзор|содержани[а-яё]*\s+(?:службы\s+)?(?:технического\s+)?заказчика|технадзор|затрат[а-яё]*\s+заказчика\s+по\s+ввод|ввод[а-яё]*\s+(?:объект[а-яё]*\s+)?в\s+эксплуатацию/iu;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function auditCustomerSsr(ssr: CustomerSsr, ctx: SsrAuditContext): SsrAuditReport {
  const findings: SsrAuditFinding[] = [];
  const unit = ssr.unitMultiplier;

  // Если «тыс. руб.» в тексте не нашлось, а суммы на три порядка меньше НМЦК, принимается тысячная единица.
  let scale = 1;
  const maxStated = Math.max(
    ssr.total?.amount ?? 0,
    ...ssr.groups.map((group) => group.stated),
    ...ssr.chapters.map((chapter) => chapter.stated ?? 0),
  );
  if (unit === 1 && ctx.nmc !== null && maxStated > 0 && maxStated * 1000 >= ctx.nmc * 0.5 && maxStated * 1000 <= ctx.nmc * 1.6 && maxStated < ctx.nmc / 100) {
    scale = 1000;
    findings.push({
      type: "UNIT_ASSUMED",
      severity: "INFO",
      message: `Суммы расчёта заказчика приняты в тысячах рублей: в тексте единица не названа, а итог ${new Intl.NumberFormat("ru-RU").format(maxStated)} в 1000 раз меньше НМЦК`,
      impact: null,
      ref: "421/пр, приложение 6: «Сметная стоимость, тыс. руб.»",
    });
  }
  const m = (value: number): number => round2(value * scale);
  const tol = (value: number): number => Math.max(1, Math.abs(value) * 0.001, unit === 1000 || scale === 1000 ? 25 : 0);

  const amountOf = (number: number): number | null => {
    const found = chapterAmount(ssr, number);
    return found === null ? null : m(found);
  };

  // --- главы: итог против суммы строк ---
  for (const chapter of ssr.chapters) {
    if (chapter.stated === null || chapter.lines.length === 0) continue;
    const stated = m(chapter.stated);
    const lines = m(chapter.linesTotal);
    if (Math.abs(stated - lines) > tol(stated) * Math.max(1, Math.sqrt(chapter.lines.length))) {
      findings.push({
        type: "CHAPTER_SUM",
        severity: "WARNING",
        message: `Глава ${String(chapter.number)}: «Итого по главе» ${rub(stated)}, а строки главы дают ${rub(lines)} (разница ${signedRub(lines - stated)})`,
        impact: null,
        ref: "421/пр, п. 141, 143",
      });
    }
  }

  // --- итоги по группам глав: против суммы глав ---
  const chapterSumTo = (to: number): { value: number; known: number } => {
    let value = 0;
    let known = 0;
    for (let number = 1; number <= to; number += 1) {
      const amount = amountOf(number);
      if (amount !== null) {
        value += amount;
        known += 1;
      }
    }
    return { value: round2(value), known };
  };
  const groupStated = (id: SsrGroupId): number | null => {
    const found = ssr.groups.find((group) => group.id === id);
    return found === undefined ? null : m(found.stated);
  };
  const sum1to12Stated = groupStated("1-12");
  const sum1to12Computed = chapterSumTo(12);
  for (const norm of SSR.groupTotals) {
    const stated = groupStated(norm.id);
    if (stated === null) continue;
    const computed = chapterSumTo(norm.to);
    if (computed.known === 0) continue;
    if (Math.abs(stated - computed.value) > tol(stated) * 2) {
      findings.push({
        type: "GROUP_SUM",
        severity: "WARNING",
        message: `«${norm.label}»: ${rub(stated)}, а сумма итогов глав ${rub(computed.value)} (разница ${signedRub(computed.value - stated)})`,
        impact: null,
        ref: SSR.groupTotalsCitation.ref,
      });
    }
  }

  // База резерва — итог глав 1-12: напечатанный, иначе сумма глав.
  const base1to12 = sum1to12Stated ?? (sum1to12Computed.known > 0 ? sum1to12Computed.value : null);

  // --- ставки заказчика ---
  const reservePercent = ssr.reserve?.percent ?? null;
  const inflationIndex = ssr.inflation?.index ?? null;
  const vatPercentCustomer = ssr.vat?.percent ?? null;
  const effectiveVat = vatPercentCustomer ?? ctx.vatPercent;
  const gross = (1 + (reservePercent ?? 0) / 100) * (inflationIndex ?? 1) * (1 + effectiveVat / 100);

  // --- резерв: предел по назначению и база ---
  if (ssr.reserve !== null && reservePercent !== null) {
    const limit = reserveLimitPercent(ctx.purpose.value);
    const rate = reserveRate(ctx.purpose.value);
    if (reservePercent > limit + 1e-9) {
      const certainly = ctx.purpose.basis !== "DEFAULT" || reservePercent > 3 + 1e-9;
      // При неизвестном назначении 3 % допустимы для производственного и линейного объекта: просим проверить.
      const impact = base1to12 === null ? null : -round2(((reservePercent - limit) / 100) * base1to12 * (inflationIndex ?? 1) * (1 + effectiveVat / 100));
      const fitsHigher = reservePercent <= 3 + 1e-9 && ctx.purpose.basis === "DEFAULT";
      findings.push({
        type: "RESERVE_PERCENT",
        severity: certainly ? "WARNING" : "INFO",
        message: fitsHigher
          ? `Резерв на непредвиденные ${pct(reservePercent)}: больше 2 % для непроизводственных объектов, но в пределах 3 % для производственных и линейных. Назначение объекта не указано — уточните (п. 179 421/пр)`
          : `Резерв на непредвиденные ${pct(reservePercent)} выше предела ${pct(limit)} (${rate.label}; п. 179 421/пр)${impact === null ? "" : `: превышение ${rub(impact)} в цене с индексом и НДС`}`,
        impact: certainly ? impact : null,
        ref: rate.citation.ref,
      });
    }
    if (ssr.reserve.amount !== null && base1to12 !== null) {
      const expected = round2((base1to12 * reservePercent) / 100);
      const actual = m(ssr.reserve.amount);
      if (Math.abs(expected - actual) > tol(expected) * 2) {
        // Какую базу взял заказчик: ищем среди итогов глав 1-7, 1-8, 1-9.
        const named = SSR.groupTotals
          .filter((group) => group.id !== "1-12")
          .map((group) => ({ group, stated: groupStated(group.id) ?? (chapterSumTo(group.to).known > 0 ? chapterSumTo(group.to).value : null) }))
          .find((item) => item.stated !== null && Math.abs(round2(((item.stated as number) * reservePercent) / 100) - actual) <= tol(actual) * 2);
        findings.push({
          type: "RESERVE_BASE",
          severity: "WARNING",
          message:
            `Резерв ${rub(actual)} не равен ${pct(reservePercent)} от итога глав 1-12 (${rub(base1to12)}) = ${rub(expected)}` +
            (named === undefined ? "" : `: цифра сходится с ${pct(reservePercent)} от «${named.group.label.toLowerCase()}» (${rub(named.stated as number)}) — база занижена, п. 179 требует итог глав 1-12`),
          impact: round2((expected - actual) * (inflationIndex ?? 1) * (1 + effectiveVat / 100)),
          ref: SSR.reserve.citations[0]?.ref ?? "421/пр, п. 179",
        });
      }
    }
  }

  // --- индекс прогнозной инфляции ---
  const customerPeriod = ssr.inflation?.period ?? null;
  const ourForCustomer: InflationResult | null =
    customerPeriod === null
      ? ctx.ourInflation
      : computeForecastInflation({ period: { kind: "DATES", start: `${customerPeriod.start}-01`, end: `${customerPeriod.end}-01` }, priceDate: ctx.priceDate, today: ctx.today });
  // База инфляции, НДС и итога — итог с резервом, как его напечатал заказчик: ошибка резерва уже названа выше и здесь не повторяется.
  const baseForInflation: number | null =
    ssr.afterReserve !== null
      ? m(ssr.afterReserve.amount)
      : base1to12 === null
        ? null
        : ssr.reserve?.amount !== null && ssr.reserve?.amount !== undefined
          ? round2(base1to12 + m(ssr.reserve.amount))
          : round2(base1to12 * (1 + (reservePercent ?? 0) / 100));
  if (inflationIndex !== null && ourForCustomer !== null && ourForCustomer.applied) {
    const diff = ourForCustomer.index - inflationIndex;
    const where = customerPeriod === null ? "по срокам из блока «Условия работ»" : `за период заказчика (${ssr.inflation?.periodText ?? periodText(ourForCustomer) ?? ""})`;
    const impact = baseForInflation === null ? null : round2(baseForInflation * diff * (1 + effectiveVat / 100));
    if (Math.abs(diff) > 0.005) {
      findings.push({
        type: "INFLATION_INDEX",
        severity: "WARNING",
        message:
          `Индекс прогнозной инфляции у заказчика ${num4(inflationIndex)}, наш ${num4(ourForCustomer.index)} ${where} (${ourForCustomer.formula ?? ""}): расхождение ${num4(Math.abs(diff))}` +
          (impact === null ? "" : `, ${signedRub(impact)} в цене с НДС`),
        impact,
        ref: "841/пр, п. 22 (подп. «б»), 23",
      });
    } else {
      findings.push({
        type: "INFLATION_INDEX",
        severity: "INFO",
        message: `Индекс прогнозной инфляции ${num4(inflationIndex)} сходится с нашим ${num4(ourForCustomer.index)} ${where} (допуск 0,005; формула: ${ourForCustomer.formula ?? ""})`,
        impact: null,
        ref: "841/пр, п. 22 (подп. «б»), 23",
      });
    }
  } else if (inflationIndex !== null && (ourForCustomer === null || !ourForCustomer.applied)) {
    findings.push({
      type: "INFLATION_INDEX",
      severity: "INFO",
      message: `Индекс прогнозной инфляции у заказчика ${num4(inflationIndex)}; проверить нечем: ${ourForCustomer?.reason ?? "в блоке «Условия работ» не указаны сроки работ, а у заказчика период не назван месяцами"}`,
      impact: null,
      ref: "841/пр, п. 22 (подп. «б»), 23",
    });
  } else if (ssr.inflation === null && ctx.ourInflation !== null && ctx.ourInflation.applied) {
    const impact = baseForInflation === null ? null : round2(baseForInflation * (ctx.ourInflation.index - 1) * (1 + effectiveVat / 100));
    findings.push({
      type: "INFLATION_MISSING",
      severity: "WARNING",
      message: `В расчёте заказчика нет прогнозной инфляции, а работы идут в прогнозном уровне цен: наш индекс ${num4(ctx.ourInflation.index)} (${ctx.ourInflation.formula ?? ""})${impact === null ? "" : `, ${signedRub(impact)} в цене с НДС`}. НМЦК определяется с применением индексов-дефляторов (841/пр, п. 8)`,
      impact,
      ref: "841/пр, п. 8 (подп. «б»), 22 (подп. «б»)",
    });
  }

  if (ssr.inflation !== null && inflationIndex !== null && ssr.inflation.amount !== null && baseForInflation !== null) {
    const expected = round2(baseForInflation * (inflationIndex - 1));
    const actual = m(ssr.inflation.amount);
    if (Math.abs(expected - actual) > tol(actual) * 2) {
      findings.push({
        type: "INFLATION_ARITHMETIC",
        severity: "WARNING",
        message: `Сумма инфляции ${rub(actual)} не равна итогу с резервом (${rub(baseForInflation)}) × (${num4(inflationIndex)} − 1) = ${rub(expected)} (разница ${signedRub(expected - actual)})`,
        impact: round2((expected - actual) * (1 + effectiveVat / 100)),
        ref: "841/пр, п. 22 (подп. «б»)",
      });
    }
  }

  // --- НДС ---
  if (ssr.vat !== null) {
    if (vatPercentCustomer !== null && Math.abs(vatPercentCustomer - ctx.vatPercent) > 1e-9) {
      const baseVat = (baseForInflation ?? 0) * (inflationIndex ?? 1);
      const impact = baseForInflation === null ? null : round2(((ctx.vatPercent - vatPercentCustomer) / 100) * baseVat);
      findings.push({
        type: "VAT_RATE",
        severity: "WARNING",
        message: `НДС ${pct(vatPercentCustomer)} вместо ${pct(ctx.vatPercent)}${impact === null ? "" : `: ${signedRub(impact)}`}. Ставка — по законодательству (п. 180 421/пр; 841/пр, п. 3)`,
        impact,
        ref: "421/пр, п. 180-181",
      });
    }
    if (ssr.vat.amount !== null && vatPercentCustomer !== null && baseForInflation !== null) {
      const baseVat = ssr.inflation?.amount !== null && ssr.inflation?.amount !== undefined
        ? baseForInflation + m(ssr.inflation.amount)
        : baseForInflation * (inflationIndex ?? 1);
      const candidates = [baseVat, baseForInflation, base1to12 ?? baseForInflation];
      const actual = m(ssr.vat.amount);
      const fits = candidates.some((candidate) => Math.abs(round2((candidate * vatPercentCustomer) / 100) - actual) <= tol(actual) * 2);
      if (!fits) {
        const expected = round2((baseVat * vatPercentCustomer) / 100);
        findings.push({
          type: "VAT_ARITHMETIC",
          severity: "WARNING",
          message: `Сумма НДС ${rub(actual)} не равна ${pct(vatPercentCustomer)} от итога с резервом и инфляцией (${rub(baseVat)}) = ${rub(expected)} (разница ${signedRub(expected - actual)}; п. 181 421/пр)`,
          impact: round2(expected - actual),
          ref: "421/пр, п. 181",
        });
      }
    }
  }

  // --- итог всего расчёта ---
  if (ssr.total !== null && baseForInflation !== null) {
    const afterInflation = ssr.inflation?.amount !== null && ssr.inflation?.amount !== undefined ? baseForInflation + m(ssr.inflation.amount) : baseForInflation * (inflationIndex ?? 1);
    const vatAmount = ssr.vat?.amount !== null && ssr.vat?.amount !== undefined ? m(ssr.vat.amount) : round2((afterInflation * effectiveVat) / 100);
    const expectedWith = afterInflation + vatAmount;
    const stated = m(ssr.total.amount);
    const matchesWith = Math.abs(stated - expectedWith) <= Math.max(tol(stated) * 2, 5);
    const matchesWithout = Math.abs(stated - afterInflation) <= Math.max(tol(stated) * 2, 5);
    const matchesBase = Math.abs(stated - baseForInflation) <= Math.max(tol(stated) * 2, 5);
    const matches = ssr.total.withVat === true ? matchesWith : ssr.total.withVat === false ? matchesWithout : matchesWith || matchesWithout || matchesBase;
    if (!matches) {
      const expected = ssr.total.withVat === false ? afterInflation : expectedWith;
      findings.push({
        type: "TOTAL_ARITHMETIC",
        severity: "WARNING",
        message: `Итог расчёта ${rub(stated)} не сходится с цепочкой «итог глав 1-12 → резерв → инфляция${ssr.total.withVat === false ? "" : " → НДС"}» = ${rub(expected)} (разница ${signedRub(expected - stated)})`,
        impact: round2(expected - stated),
        ref: "421/пр, п. 142-143, 179-181",
      });
    }
  }

  // --- затраты заказчика в цене контракта ---
  const chapters10to12 = [10, 11, 12].map((number) => ({ number, amount: amountOf(number) }));
  const known10to12 = chapters10to12.filter((item) => item.amount !== null && item.amount > 0);
  const customerLinesInCh9 = (ssr.chapters.find((chapter) => chapter.number === 9)?.lines ?? []).filter((line) => CUSTOMER_LINE_RE.test(line.name));
  const scopeAmount = round2(known10to12.reduce((sum, item) => sum + (item.amount as number), 0) + customerLinesInCh9.reduce((sum, line) => sum + m(line.amount), 0));
  if (scopeAmount > 0) {
    const parts = [
      ...known10to12.map((item) => `глава ${String(item.number)} ${rub(item.amount as number)}`),
      ...customerLinesInCh9.map((line) => `«${line.name.length > 50 ? `${line.name.slice(0, 50)}…` : line.name}» (глава 9) ${rub(m(line.amount))}`),
    ].join(", ");
    const grossScope = round2(scopeAmount * gross);
    const nmc = ctx.nmc;
    const total = ssr.total === null ? null : m(ssr.total.amount);
    // Что с чем сравнивается: НМЦК против итога ССР целиком и против итога без затрат заказчика.
    const comparableIncl = total !== null && ssr.total?.withVat !== false ? total : null;
    if (nmc !== null && comparableIncl !== null) {
      const withScope = ctx.nmcIncludesVat ? comparableIncl : comparableIncl / (1 + effectiveVat / 100);
      const withoutScope = withScope - (ctx.nmcIncludesVat ? grossScope : scopeAmount * (1 + (reservePercent ?? 0) / 100) * (inflationIndex ?? 1));
      const dIncl = Math.abs(nmc - withScope);
      const dExcl = Math.abs(nmc - withoutScope);
      if (dIncl <= dExcl && dIncl / nmc <= 0.02) {
        findings.push({
          type: "CUSTOMER_SCOPE",
          severity: "WARNING",
          message: `НМЦК ${rub(nmc)} равна итогу ССР целиком (${rub(withScope)}), то есть включает затраты заказчика: ${parts}. В цену контракта подряда они не входят (841/пр, п. 21; 421/пр, п. 162, 170, 171): подрядчик получит НМЦК меньше на ${rub(grossScope)} с резервом, инфляцией и НДС, чем объявлено`,
          impact: -grossScope,
          ref: "841/пр, п. 21; 421/пр, п. 162, 170, 171",
        });
      } else if (dExcl < dIncl && dExcl / nmc <= 0.02) {
        findings.push({
          type: "CUSTOMER_SCOPE",
          severity: "INFO",
          message: `В ССР есть затраты заказчика (${parts}), в НМЦК ${rub(nmc)} они не вошли: НМЦК сходится с итогом без них (${rub(withoutScope)}). Так и должно быть (841/пр, п. 21)`,
          impact: null,
          ref: "841/пр, п. 21; 421/пр, п. 162, 170, 171",
        });
      } else {
        findings.push({
          type: "CUSTOMER_SCOPE",
          severity: "INFO",
          message: `В ССР есть затраты заказчика (${parts}); входят ли они в НМЦК ${rub(nmc)}, определить нельзя: НМЦК не сходится ни с итогом ССР (${rub(withScope)}), ни с итогом без этих затрат (${rub(withoutScope)}). Проверьте по расчёту НМЦК заказчика (841/пр, приложение 4)`,
          impact: null,
          ref: "841/пр, п. 21; 421/пр, п. 162, 170, 171",
        });
      }
    } else {
      findings.push({
        type: "CUSTOMER_SCOPE",
        severity: "INFO",
        message: `В ССР есть затраты заказчика (${parts}): в цену контракта подряда они не входят (841/пр, п. 21). Сверить с НМЦК нельзя: ${nmc === null ? "НМЦК не объявлена" : "итог расчёта заказчика не прочитан"}`,
        impact: null,
        ref: "841/пр, п. 21; 421/пр, п. 162, 170, 171",
      });
    }
  }

  // --- сравнение по строкам с нашим расчётом ---
  const rows: SsrCompareRow[] = [];
  if (ctx.ourSsr !== null && ctx.ourSsr !== undefined && ctx.ourSsr.status === "COMPUTED") {
    const sumChapters = (from: number, to: number): number | null => {
      let found = false;
      let total = 0;
      for (let number = from; number <= to; number += 1) {
        const amount = amountOf(number);
        if (amount !== null) {
          found = true;
          total += amount;
        }
      }
      return found ? round2(total) : null;
    };
    const winterLines = (ssr.chapters.find((chapter) => chapter.number === 9)?.lines ?? []).filter((line) => /зимн/iu.test(line.name));
    const customer: Record<SsrContractRowId, number | null> = {
      LOCAL: sumChapters(2, 7),
      TEMPORARY: amountOf(8),
      WINTER: winterLines.length === 0 ? null : round2(winterLines.reduce((sum, line) => sum + m(line.amount), 0)),
      RESERVE: ssr.reserve === null ? null : ssr.reserve.amount !== null ? m(ssr.reserve.amount) : base1to12 === null || reservePercent === null ? null : round2((base1to12 * reservePercent) / 100),
      INFLATION:
        ssr.inflation === null
          ? null
          : ssr.inflation.amount !== null
            ? m(ssr.inflation.amount)
            : baseForInflation === null || inflationIndex === null
              ? null
              : round2(baseForInflation * (inflationIndex - 1)),
      VAT: ssr.vat === null || ssr.vat.amount === null ? null : m(ssr.vat.amount),
    };
    for (const row of ctx.ourSsr.nmc.rows) {
      const theirs = customer[row.id];
      rows.push({
        id: row.id,
        label: row.label,
        ours: row.amount,
        customer: theirs,
        diff: theirs === null ? null : round2(row.amount - theirs),
      });
    }
  }

  const warnings = findings.filter((finding) => finding.severity === "WARNING").length;
  const conclusion =
    warnings === 0
      ? "Расчёт заказчика сходится: арифметика глав, резерв, инфляция и НДС в пределах норм"
      : `Замечаний: ${String(warnings)}. Влияние каждой находки на НМЦК указано рядом с ней (плюс — НМЦК занижена, минус — завышена); находки пересекаются и в одну сумму не складываются`;

  return {
    documentName: ssr.documentName,
    estimateName: ssr.estimateName,
    findings,
    warnings,
    customer: {
      chaptersTotal: base1to12,
      reservePercent,
      inflationIndex,
      vatPercent: vatPercentCustomer,
      total: ssr.total === null ? null : m(ssr.total.amount),
      unitMultiplier: unit === 1000 || scale === 1000 ? 1000 : 1,
    },
    ourInflation: ourForCustomer,
    inflationPeriod: ssr.inflation?.periodText ?? (ourForCustomer === null ? null : periodText(ourForCustomer)),
    rows,
    conclusion,
  };
}

/** Заголовки для списка находок. */
export const SSR_FINDING_TITLES: Readonly<Record<SsrAuditFindingType, string>> = {
  CHAPTER_SUM: "Итог главы против строк",
  GROUP_SUM: "Итоги по главам",
  RESERVE_PERCENT: "Процент непредвиденных",
  RESERVE_BASE: "База резерва",
  INFLATION_INDEX: "Индекс прогнозной инфляции",
  INFLATION_MISSING: "Прогнозная инфляция не применена",
  INFLATION_ARITHMETIC: "Сумма инфляции",
  VAT_RATE: "Ставка НДС",
  VAT_ARITHMETIC: "Сумма НДС",
  TOTAL_ARITHMETIC: "Итог расчёта",
  CUSTOMER_SCOPE: "Затраты заказчика в цене контракта",
  UNIT_ASSUMED: "Единицы суммы",
  NMCK_FUTURE_ACTUAL_INDEX: "Фактическая инфляция за месяц, которого ещё нет в статистике",
  NMCK_MONTHLY_INDEX: "Месячный индекс выше прогноза",
  NMCK_FORECAST_INDEX: "Годовой индекс прогнозной инфляции",
  NMCK_LSR_LABEL: "«Цена по ЛСР» на сумме с индексами",
  NMCK_LIMIT_UNEVEN: "Лимит по приложениям сметы контракта",
};
