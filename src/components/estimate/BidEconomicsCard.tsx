"use client";

import { useMemo, useState } from "react";

import { AppliedNormatives } from "@/components/estimate/AppliedNormatives";
import { Badge } from "@/components/ui/primitives";
import type { TaxSystem } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import {
  computeBidEconomics,
  SAFETY_MARGIN_CAP,
  type BidEconomics,
  type BidFlag,
  type ComparisonBand,
  type PriceVerdict,
} from "@/domain/estimate/bidEconomics";
import type { SsrResult } from "@/domain/estimate/ssr";
import type { EstimateDocument } from "@/domain/estimate/types";
import type { VatStatus } from "@/domain/estimate/vatStatus";
import { cn } from "@/lib/cn";

/**
 * Цена участия по индексной смете.
 *
 * Сама смета отвечает «сколько это стоит по нормам и текущим ценам Минстроя».
 * Человеку нужен следующий шаг: какую цену подавать и до какого снижения закупка
 * остаётся выгодной. Блок стоит над сметой, потому что это ответ, ради которого
 * смету и считали, — а сама смета ниже служит его основанием.
 *
 * Все числа считает `computeBidEconomics`, модель здесь не участвует. Допущения
 * (НМЦК с НДС, какая доля накладных тратится) показаны рядом и переключаются: от
 * них границы зависят сильнее всего, и человек обязан видеть, на чём они стоят.
 */

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub = (value: number | null): string => (value === null ? "—" : `${RUB.format(Math.round(value))} ₽`);
const percent = (value: number | null, digits = 1): string =>
  value === null ? "—" : `${value.toFixed(digits).replace(".", ",")} %`;

const BAND_TEXT: Record<ComparisonBand, { label: string; tone: "olive" | "mustard" | "brick" | "neutral" }> = {
  ABOVE_ESTIMATE: { label: "НМЦК выше расчёта", tone: "olive" },
  NEAR_ESTIMATE: { label: "НМЦК на уровне расчёта", tone: "neutral" },
  BELOW_ESTIMATE: { label: "НМЦК ниже расчёта", tone: "mustard" },
  BELOW_COST: { label: "НМЦК ниже себестоимости", tone: "brick" },
  INCOMPLETE: { label: "Расчёт неполный", tone: "mustard" },
  NO_NMC: { label: "Цена не объявлена", tone: "neutral" },
};

/** Запас прочности: «+25,0 %»; у границы поиска — «более +500 %», а не ложно точная цифра. */
const safetyText = (value: number | null): string => {
  if (value === null) return "—";
  if (value >= SAFETY_MARGIN_CAP) return `более +${String(SAFETY_MARGIN_CAP)} %`;
  return value > 0 ? `+${percent(value)}` : percent(0);
};

const ANTI_DUMPING_HINT =
  "44-ФЗ, ст. 37: при снижении цены на 25 % и более от НМЦК обеспечение исполнения контракта увеличивается в 1,5 раза (при НМЦК до 15 млн ₽ можно подтвердить добросовестность исполненными контрактами). Сверьте с актуальной редакцией закона.";

/** Откуда известно про НДС в цене: подпись рядом с переключателем. */
function vatBasisText(vat: VatStatus): string {
  if (vat.conflict) return "в документации встречаются оба варианта — проверьте вручную";
  switch (vat.basis) {
    case "DOCUMENT":
      return `из документации: «${vat.quote ?? ""}»${vat.documentName === null ? "" : ` (${vat.documentName})`}`;
    case "LAW_44":
      return "по 44-ФЗ цена контракта включает налоги — допущение, в документации прямо не указано";
    case "ASSUMPTION":
      return "⚠ НДС в документации не определён, принято «с НДС» — проверьте";
  }
}

const VERDICT_TEXT: Record<PriceVerdict, string> = {
  OK: "выгодно",
  BELOW_TARGET_MARGIN: "маржа ниже цели",
  LOSS: "убыток",
};

const TAX_TEXT: Record<BidEconomics["taxKind"], string> = {
  OSNO: "ОСНО: НДС к вычету, налог на прибыль 20 %",
  USN_INCOME: "УСН «доходы» 6 %, НДС поставщиков не возвращается",
  USN_INCOME_EXPENSES: "УСН «доходы минус расходы» 15 % (не меньше 1 % с выручки)",
  PATENT_AS_USN_INCOME: "патент — посчитан как УСН «доходы» 6 %",
};

const SEVERITY_ORDER: Record<BidFlag["severity"], number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };

export interface BidEconomicsCardProps {
  readonly document: EstimateDocument;
  readonly nmc: number | null;
  readonly billItems: number;
  readonly droppedPositions: number;
  readonly assumedPercent: number;
  readonly unpricedResources: number;
  readonly taxSystem: TaxSystem;
  readonly minMarginPercent: number;
  /** Закон закупки: для 44-ФЗ таблица отмечает снижение от 25 % (антидемпинг). */
  readonly law?: TenderLaw;
  /** Что документация говорит про НДС в цене. Нет — «с НДС» как допущение. */
  readonly vat?: VatStatus;
  /** Сводный расчёт: НМЦК сравнивается с нашей оценкой цены контракта, а не со сметой. */
  readonly ssr?: SsrResult | null;
}

/**
 * Шкала цены: от нуля до НМЦК тремя зонами.
 *
 * Пять отдельных цифр («безубыточная», «минимальная», «допустимое снижение»…)
 * заставляют читателя самому раскладывать их по оси. Здесь они уже разложены:
 * красная зона — убыток, золотая — прибыль есть, но ниже вашей маржи, зелёная —
 * цена, при которой участие выгодно. Подписи с суммами — под шкалой, а не
 * поверх неё: близкие значения иначе наезжали бы друг на друга.
 */
function PriceScale({
  nmc,
  breakEven,
  minPrice,
}: {
  nmc: number;
  breakEven: number;
  minPrice: number;
}) {
  const pct = (value: number) => Math.max(0, Math.min(100, (value / nmc) * 100));
  const loss = pct(breakEven);
  const lowMargin = Math.max(loss, pct(minPrice));
  return (
    <div data-testid="price-scale" className="space-y-3">
      <div
        className="flex h-3.5 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`Шкала цены от 0 до НМЦК ${rub(nmc)}: убыток до ${rub(breakEven)}, ниже вашей маржи до ${rub(minPrice)}, выгодно от ${rub(minPrice)}`}
      >
        <span className="bg-brick" style={{ width: `${loss}%` }} />
        <span className="bg-mustard" style={{ width: `${lowMargin - loss}%` }} />
        <span className="flex-1 bg-olive" />
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
        {[
          { bar: "bg-brick", label: "Убыток", value: `до ${rub(breakEven)}` },
          { bar: "bg-mustard", label: "Ниже вашей маржи", value: `до ${rub(minPrice)}` },
          { bar: "bg-olive", label: "Выгодно", value: `от ${rub(minPrice)} до НМЦК` },
        ].map((zone) => (
          <div key={zone.label} className="flex gap-2.5">
            <span className={cn("mt-1 h-9 w-[3px] shrink-0 rounded-full", zone.bar)} aria-hidden />
            <div>
              <dt className="text-[13px] text-muted-foreground">{zone.label}</dt>
              <dd className="text-[15px] font-semibold tabular-nums text-foreground">{zone.value}</dd>
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}

function FlagList({ flags }: { flags: readonly { code: string; severity: string; message: string }[] }) {
  return (
    <ul className="space-y-1.5 text-[14px] leading-relaxed">
      {flags.map((flag) => (
        <li
          key={flag.code}
          className={cn(
            flag.severity === "CRITICAL" && "font-medium text-brick-fg",
            flag.severity === "HIGH" && "text-brick-fg",
            flag.severity === "MEDIUM" && "text-mustard-fg",
            flag.severity === "INFO" && "text-muted-foreground",
          )}
        >
          {flag.message}
        </li>
      ))}
    </ul>
  );
}

export function BidEconomicsCard(props: BidEconomicsCardProps) {
  const detectedVat = props.vat?.includesVat ?? true;
  // Выбор человека хранится отдельно от найденного в документах: пока он не
  // трогал переключатель, значение следует за документацией, даже если оно
  // появилось позже первого показа.
  const [vatChoice, setVatChoice] = useState<boolean | null>(null);
  const nmcIncludesVat = vatChoice ?? detectedVat;
  const [overheadRealization, setOverheadRealization] = useState(1);
  const vatOverridden = props.vat !== undefined && nmcIncludesVat !== props.vat.includesVat;

  const economics = useMemo(
    () =>
      computeBidEconomics({
        document: props.document,
        nmc: props.nmc,
        billItems: props.billItems,
        droppedPositions: props.droppedPositions,
        assumedPercent: props.assumedPercent,
        unpricedResources: props.unpricedResources,
        company: { taxSystem: props.taxSystem, minMarginPercent: props.minMarginPercent },
        nmcIncludesVat,
        overheadRealization,
        law: props.law,
        ssr: props.ssr ?? null,
        // Основание описывает то, что нашли в документах: после ручной смены
        // переключателя оно уже не про текущее значение, и пометка остаётся общей.
        ...(props.vat !== undefined && !vatOverridden
          ? { vatBasis: props.vat.basis, vatQuote: props.vat.quote, vatConflict: props.vat.conflict }
          : {}),
      }),
    [props, nmcIncludesVat, overheadRealization, vatOverridden],
  );

  if (economics.status === "EMPTY") {
    return (
      <section className="rounded-md border border-border p-3" aria-label="Цена участия">
        <h3 className="text-sm font-semibold">Цена участия</h3>
        <p className="mt-1 text-sm text-muted-foreground">{economics.flags[0]?.message}</p>
      </section>
    );
  }

  const band = BAND_TEXT[economics.band];
  const flags = [...economics.flags].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Цена участия">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Цена участия по смете</h3>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={band.tone}>{band.label}</Badge>
          <Badge tone={economics.confidence.score >= 75 ? "olive" : economics.confidence.score >= 50 ? "mustard" : "brick"}>
            Надёжность расчёта {economics.confidence.score}
          </Badge>
        </div>
      </div>

      {economics.nmc !== null &&
        economics.nmc > 0 &&
        economics.breakEvenPrice !== null &&
        economics.minAcceptablePrice !== null && (
          <PriceScale
            nmc={economics.nmc}
            breakEven={economics.breakEvenPrice}
            minPrice={economics.minAcceptablePrice}
          />
        )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
        <Figure label="НМЦК" value={rub(economics.nmc)} hint={economics.ratioToEstimate === null ? undefined : `${economics.ratioToEstimate.toFixed(2).replace(".", ",")} от ${economics.ssr === null ? "расчёта" : "нашей оценки НМЦК"}`} />
        <Figure label="Безубыточная цена" value={rub(economics.breakEvenPrice)} hint="прибыль после налогов = 0" />
        <Figure
          label="Минимальная цена"
          value={rub(economics.minAcceptablePrice)}
          hint={`маржа ${percent(economics.minMarginPercent, 0)} — минимум из профиля`}
          strong
        />
        <Figure
          label="Допустимое снижение"
          value={economics.maxReductionPercent === null ? "—" : percent(economics.maxReductionPercent)}
          hint="от НМЦК до минимальной цены"
          strong
        />
        <Figure
          label="Запас прочности при НМЦК"
          value={safetyText(economics.safetyMarginPercent)}
          hint="на столько могут вырасти затраты до нулевой прибыли"
        />
      </dl>

      {flags.length > 0 && (
        <div className="space-y-2" data-testid="bid-flags">
          {/*
            Пояснений бывает до десятка абзацев подряд — стена текста над таблицей.
            На виду два самых важных (список уже упорядочен по тяжести), остальные —
            под спойлером: они нужны тем, кто проверяет расчёт, а не каждому читателю.
          */}
          <FlagList flags={flags.slice(0, 2)} />
          {flags.length > 2 && (
            <details>
              <summary className="cursor-pointer text-[13.5px] text-accent-fg">
                Ещё пояснения: {flags.length - 2}
              </summary>
              <div className="mt-2">
                <FlagList flags={flags.slice(2)} />
              </div>
            </details>
          )}
        </div>
      )}

      {economics.priceTable.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-[14px] tabular-nums">
            <caption className="pb-2 text-left text-[15px] font-semibold tracking-tight text-foreground">
              Что останется компании при разной цене
            </caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Цена</th>
                <th className="py-2 pr-3 text-right font-medium">Выручка</th>
                <th className="py-2 pr-3 text-right font-medium">Затраты</th>
                <th className="py-2 pr-3 text-right font-medium">Налог</th>
                <th className="py-2 pr-3 text-right font-medium">Прибыль</th>
                <th className="py-2 pr-3 text-right font-medium">Маржа</th>
                <th
                  className="py-2 pr-3 text-right font-medium"
                  title="На сколько процентов могут вырасти затраты при этой цене до нулевой прибыли"
                >
                  Запас
                </th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {economics.priceTable.map((row) => (
                <tr key={row.percentOfNmc} className="border-t border-border">
                  <td className="py-2.5 pr-3">
                    {row.percentOfNmc} % · {rub(row.price)}
                  </td>
                  <td className="py-2.5 pr-3 text-right">{rub(row.revenue)}</td>
                  <td className="py-2.5 pr-3 text-right">{rub(row.cost)}</td>
                  <td className="py-2.5 pr-3 text-right">{rub(row.tax)}</td>
                  <td className={cn("py-2.5 pr-3 text-right", row.profit < 0 && "text-brick-fg")}>{rub(row.profit)}</td>
                  <td className="py-2.5 pr-3 text-right">{percent(row.marginPercent)}</td>
                  <td className={cn("py-2.5 pr-3 text-right", row.safetyMarginPercent <= 0 && "text-brick-fg")}>
                    {safetyText(row.safetyMarginPercent)}
                  </td>
                  <td
                    className={cn(
                      "py-2.5 font-medium",
                      row.verdict === "OK" && "text-olive-fg",
                      row.verdict === "BELOW_TARGET_MARGIN" && "text-mustard-fg",
                      row.verdict === "LOSS" && "text-brick-fg",
                    )}
                  >
                    {VERDICT_TEXT[row.verdict]}
                    {row.antiDumping && (
                      <span
                        className="ml-2 cursor-help font-normal text-mustard-fg before:mr-2 before:content-['·']"
                        title={ANTI_DUMPING_HINT}
                      >
                        антидемпинг
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {economics.stress.length > 0 && (
        <details className="rounded-md border border-border/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Если затраты окажутся выше расчёта
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Цена</th>
                  <th className="py-1 pr-3 text-right font-normal">Затраты как в расчёте</th>
                  <th className="py-1 pr-3 text-right font-normal">+10 %</th>
                  <th className="py-1 text-right font-normal">+20 %</th>
                </tr>
              </thead>
              <tbody>
                {[100, 90, 80].map((share) => {
                  const cells = economics.stress.filter((cell) => cell.percentOfNmc === share);
                  return (
                    <tr key={share} className="border-t border-border/60">
                      <td className="py-2.5 pr-3">{share} % НМЦК</td>
                      {cells.map((cell) => (
                        <td
                          key={cell.costOverrunPercent}
                          className={cn("py-1 pr-3 text-right", cell.profit < 0 && "text-brick-fg")}
                        >
                          {rub(cell.profit)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-muted-foreground">Прибыль после налогов при перерасходе затрат.</p>
          </div>
        </details>
      )}

      <details className="rounded-md border border-border/60 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">На чём стоят эти числа</summary>
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p>
            Себестоимость {rub(economics.basis.cost)} = прямые затраты {rub(economics.basis.directCost)} + накладные{" "}
            {rub(economics.basis.overhead * economics.assumptions.overheadRealization)}
            {economics.basis.limitedCosts > 0 && ` + лимитированные ${rub(economics.basis.limitedCosts)}`}
            {economics.basis.nonDeductibleVat > 0 && ` + НДС на материалы ${rub(economics.basis.nonDeductibleVat)}`}. Сметная
            прибыль {rub(economics.basis.estimatedProfit)} — это норматив, а не ваши затраты: в себестоимость она не входит.
          </p>
          <p>Налоги: {TAX_TEXT[economics.taxKind]}. Страховые взносы и вычеты не учтены.</p>
          {props.document.appliedNormatives !== undefined && props.document.appliedNormatives.length > 0 && (
            <div data-testid="bid-normatives">
              <p className="font-medium text-foreground">Нормативы, по которым начислено сверх норм</p>
              <AppliedNormatives normatives={props.document.appliedNormatives} compact />
            </div>
          )}
          {economics.confidence.reasons.length > 0 && (
            <p>Надёжность расчёта: {economics.confidence.reasons.join("; ")}.</p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-foreground">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={nmcIncludesVat}
                onChange={(e) => setVatChoice(e.target.checked)}
                className="h-4 w-4 accent-[rgb(var(--accent))]"
              />
              НМЦК с НДС
            </label>
            {props.vat !== undefined && (
              <span className="text-xs text-muted-foreground" data-testid="vat-basis">
                {vatBasisText(props.vat)}
                {vatOverridden && " · значение изменено вами"}
              </span>
            )}
            <label className="flex items-center gap-2">
              Накладные тратятся на
              <select
                className="rounded-full border border-border bg-panel px-2 py-0.5"
                value={overheadRealization}
                onChange={(e) => setOverheadRealization(Number(e.target.value))}
                aria-label="Доля накладных, которая тратится"
              >
                {[1, 0.8, 0.6, 0.5].map((value) => (
                  <option key={value} value={value}>
                    {Math.round(value * 100)} %
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs">
            Расчёт информационный: смета по ФСНБ-2022 и текущим ценам Минстроя показывает порядок затрат, а не ваши
            реальные цены поставщиков и субподрядчиков. Для решения о цене проверьте крупные статьи.
          </p>
        </div>
      </details>
    </section>
  );
}

function Figure({ label, value, hint, strong = false }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn(strong ? "text-base font-semibold" : "font-medium")}>{value}</dd>
      {hint !== undefined && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}
