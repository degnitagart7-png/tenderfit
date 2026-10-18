import { auditCustomerNmck, parseCustomerNmck } from "@/domain/estimate/customerNmck";
import { auditCustomerSsr, type SsrAuditReport } from "@/domain/estimate/customerSsrAudit";
import type { DocumentText } from "@/domain/estimate/customerEstimate";
import { parseCustomerSsr, type CustomerSsr } from "@/domain/estimate/customerSsr";
import { computeForecastInflation } from "@/domain/estimate/forecastInflation";
import { resolveSsrPeriod, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { buildSsr, compareSsrWithNmc, resolvePurpose, type SsrNmcComparison, type SsrPurpose, type SsrResult } from "@/domain/estimate/ssr";
import type { EstimateDocument } from "@/domain/estimate/types";

/**
 * Слой сводного расчёта поверх готовой сметы: наш ССР и «наша оценка НМЦК», сравнение с НМЦК закупки,
 * ССР заказчика из документации и его аудит. Одна функция на карточку, на цену участия и на отчёт Word,
 * чтобы экран и файл показывали одни и те же числа.
 *
 * Ничего не пишет и не читает извне: смета, выбор пользователя и тексты документов — на входе.
 */

export interface SsrLayerInput {
  /** Посчитанная смета; null — сметы нет, остаётся только разбор и аудит ССР заказчика. */
  readonly estimate: EstimateDocument | null;
  readonly options: EstimateOptions;
  /** НМЦК закупки, ₽; null — не объявлена. */
  readonly nmc: number | null;
  readonly nmcIncludesVat: boolean;
  /** ISO-дата определения НМЦК: дата публикации извещения. */
  readonly priceDate: string | null;
  /** ISO-дата «сегодня». */
  readonly today: string;
  readonly documents: readonly DocumentText[];
  /** Ставка НДС для аудита, когда сметы нет; по умолчанию 22. */
  readonly vatPercent?: number;
}

export interface SsrLayer {
  readonly purpose: SsrPurpose;
  /** Наш ССР; null — сметы нет. */
  readonly ssr: SsrResult | null;
  readonly comparison: SsrNmcComparison | null;
  /** ССР заказчика, найденные в документах; пусто — ССР в документации нет. */
  readonly customer: readonly CustomerSsr[];
  readonly audits: readonly SsrAuditReport[];
}

export const DEFAULT_VAT_PERCENT = 22;

/** Смета посчитана и имеет ту форму, из которой строится ССР (старые задания и заглушки могли её не иметь). */
function usable(estimate: EstimateDocument | null): estimate is EstimateDocument {
  return estimate !== null && estimate.totals !== undefined && estimate.parameters !== undefined && Array.isArray(estimate.sections);
}

export function computeSsrLayer(input: SsrLayerInput): SsrLayer {
  const purpose = resolvePurpose(input.options.ssr?.purpose ?? null, input.options.workKind);
  const period = resolveSsrPeriod(input.options);

  const estimate = usable(input.estimate) ? input.estimate : null;
  let ssr: SsrResult | null = null;
  if (estimate !== null) {
    try {
      ssr = buildSsr({
        document: estimate,
        purpose: input.options.ssr?.purpose ?? null,
        workKind: input.options.workKind,
        period,
        priceDate: input.priceDate,
        today: input.today,
      });
    } catch {
      // Сводный расчёт — надстройка над сметой: сбой в нём не должен ронять карточку закупки. Смета без ССР показывается как прежде.
      ssr = null;
    }
  }
  const comparison = ssr === null ? null : compareSsrWithNmc(ssr, input.nmc, input.nmcIncludesVat);

  const customer = parseCustomerSsr(input.documents);
  const vatPercent = estimate?.parameters.vatPercent ?? input.vatPercent ?? DEFAULT_VAT_PERCENT;
  const ourInflation = ssr?.nmc.inflation ?? computeForecastInflation({ period, priceDate: input.priceDate, today: input.today });
  const audits: SsrAuditReport[] = customer.map((item) =>
    auditCustomerSsr(item, {
      purpose,
      vatPercent,
      nmc: input.nmc,
      nmcIncludesVat: input.nmcIncludesVat,
      ourInflation,
      priceDate: input.priceDate,
      today: input.today,
      ourSsr: ssr,
    }),
  );

  // Расчёт НМЦК заказчика (приложение 2 к 841/пр) и проекты смет контракта из «Обоснования НМЦК»: свои проверки, тот же вид отчёта.
  const nmck = parseCustomerNmck(input.documents);
  if (nmck !== null) audits.push(auditCustomerNmck(nmck, { today: input.today }));

  return { purpose, ssr, comparison, customer, audits };
}
