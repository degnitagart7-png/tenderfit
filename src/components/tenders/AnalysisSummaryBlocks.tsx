"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import type { ConsolidatedAnalysis } from "@/domain/analysisConsolidation";
import {
  compactRub,
  cutLabel,
  formatDayMonth,
  priceCushion,
  shortDocName,
  type ClarifyDeadline,
  type PriceCushion,
} from "@/domain/analysisDigest";
import type { MoneyOutlook } from "@/domain/moneyOutlook";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/utils/format";

/**
 * Итог глубокого анализа над списком выводов: противоречия между документами
 * (`analysisConsolidation.ts`) и блок «Деньги» (`moneyOutlook.ts`).
 *
 * Список выводов отвечал на «что написано в документах», а подрядчик решает
 * «участвовать ли и за сколько». Поэтому сверху: противоречия с тем, что считать
 * верным, вопросы заказчику (их можно скопировать в запрос на разъяснения) и деньги —
 * обеспечения, запас по цене при снижении, зима, оплата. Суть в двух-трёх
 * предложениях стоит у решения в шапке панели, а не здесь.
 *
 * Подробности раскрываются по клику: заголовок и одна строка смысла видны всегда.
 */

const rub = (value: number): string => formatCurrency(value);
const pct = (share: number): string => `${(share * 100).toFixed(share * 100 < 10 ? 1 : 0).replace(".", ",")} %`;

/** Сколько противоречий видно сразу: остальные — по кнопке. */
const CONFLICTS_VISIBLE = 3;

/** «Уточнить у заказчика: …» в начале решения лишнее — метка «Уточнить» уже сказала это. */
const CLARIFY_PREFIX = /^\s*уточнить у заказчика\s*[:—-]?\s*/iu;

export function ConsolidationBlock({
  consolidation,
  showSummary = true,
  clarifyBy = null,
}: {
  consolidation: ConsolidatedAnalysis | null;
  /** Итог по документации; панель показывает его у решения и отключает здесь. */
  showSummary?: boolean;
  /** До какого числа подать запрос на разъяснения: считается от окончания подачи. */
  clarifyBy?: ClarifyDeadline | null;
}) {
  const [copied, setCopied] = useState(false);
  const [allConflicts, setAllConflicts] = useState(false);
  if (consolidation === null) return null;
  const { summary, conflicts, questions } = consolidation;
  const hasSummary = showSummary && summary !== "";
  if (!hasSummary && conflicts.length === 0 && questions.length === 0) return null;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(questions.map((q, i) => `${String(i + 1)}. ${q}`).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const hidden = allConflicts ? 0 : Math.max(0, conflicts.length - CONFLICTS_VISIBLE);
  const shownConflicts = hidden > 0 ? conflicts.slice(0, CONFLICTS_VISIBLE) : conflicts;

  return (
    <section className="space-y-6" aria-label="Итог по документации" data-testid="consolidation-block">
      {hasSummary && (
        <div className="rounded-card border border-accent-line bg-accent-subtle px-4 py-3">
          <h3 className="text-[15px] font-semibold text-foreground">Итог по всей документации</h3>
          <p className="mt-1 text-[14.5px] leading-relaxed text-foreground">{summary}</p>
        </div>
      )}

      {conflicts.length > 0 && (
        <div id="analysis-conflicts" className="scroll-mt-24">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
            Документы противоречат друг другу
            <span className="num ml-2 text-[13px] font-normal text-faint">{conflicts.length}</span>
          </h3>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {shownConflicts.map((conflict, index) => {
              const resolution = conflict.resolution.replace(CLARIFY_PREFIX, "").trim();
              return (
                <li key={`${conflict.topic}-${String(index)}`} className="space-y-1.5 py-3">
                  <p className="text-[15px] font-medium text-foreground">{conflict.topic}</p>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {conflict.values.map((v, i) => (
                      <li key={`${v.source}-${String(i)}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="min-w-0 break-words text-foreground">{v.value}</span>
                        {v.source !== "" && (
                          <span className="text-[12.5px] text-faint">
                            <span aria-hidden>· </span>
                            <span title={v.source}>{shortDocName(v.source)}</span>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {resolution !== "" && (
                    <p className="flex items-start gap-2 text-[13.5px] leading-snug text-foreground">
                      <span
                        className={cn(
                          "shrink-0 font-medium",
                          conflict.needs_question ? "text-mustard-fg" : "text-olive-fg",
                        )}
                      >
                        {conflict.needs_question ? "Уточнить:" : "Верно:"}
                      </span>
                      <span className="min-w-0 break-words">{resolution}</span>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setAllConflicts(true)}
              className="mt-2 text-[13.5px] text-accent-fg underline underline-offset-2 hover:no-underline"
            >
              Показать ещё {hidden}
            </button>
          )}
        </div>
      )}

      {questions.length > 0 && (
        <div id="analysis-questions" className="scroll-mt-24">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
              Вопросы заказчику
              <span className="num ml-2 text-[13px] font-normal text-faint">{questions.length}</span>
              {clarifyBy !== null && (
                <span
                  className={cn(
                    "ml-3 text-[13px] font-medium",
                    clarifyBy.passed || clarifyBy.daysLeft <= 1 ? "text-brick-fg" : "text-muted-foreground",
                  )}
                >
                  {clarifyBy.passed ? "срок запроса прошёл" : `отправить до ${formatDayMonth(clarifyBy.date)}`}
                </span>
              )}
            </h3>
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              {copied ? "Скопировано" : "Скопировать"}
            </button>
          </div>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-foreground">
            {questions.map((q, i) => (
              <li key={`${String(i)}-${q.slice(0, 20)}`}>{q}</li>
            ))}
          </ol>
          <p className="mt-1 text-[12.5px] text-faint">
            Запрос на разъяснения подаётся на площадке не позднее чем за три дня до окончания подачи заявок.
          </p>
        </div>
      )}
    </section>
  );
}

/** Шкала снижения цены на аукционе: дальше этого порога смотреть незачем — обычно роняют на 5–25 %. */
const CUSHION_SCALE = 0.3;

/** Горизонтальная шкала 0…30 % снижения: прибыль, накладные, убыток — тремя участками. */
function CushionBar({ cushion }: { cushion: PriceCushion }) {
  const profit = Math.min(cushion.profitShare, CUSHION_SCALE);
  const breakEven = Math.min(cushion.breakEvenShare, CUSHION_SCALE);
  const at = (share: number): string => `${String((share / CUSHION_SCALE) * 100)}%`;
  // Подпись порога не должна вылезать за края шкалы на телефоне.
  const labelAt = (share: number): string =>
    `${String(Math.min(92, Math.max(8, (share / CUSHION_SCALE) * 100)))}%`;
  const label = `Без убытка до ${cutLabel(cushion.breakEvenShare)}, прибыль сохраняется до ${cutLabel(cushion.profitShare)}`;
  return (
    <div className="mt-2" data-testid="cushion-bar">
      <div role="img" aria-label={label} className="flex h-3 overflow-hidden rounded-full bg-brick/30">
        <div className="bg-olive" style={{ width: at(profit) }} />
        <div className="bg-mustard" style={{ width: at(Math.max(0, breakEven - profit)) }} />
      </div>
      <div className="num relative mt-1 h-4 text-[12px] text-faint" aria-hidden>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: labelAt(profit) }}>
          {cutLabel(cushion.profitShare)}
        </span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: labelAt(breakEven) }}>
          {cutLabel(cushion.breakEvenShare)}
        </span>
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-olive" aria-hidden />
          прибыль
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-mustard" aria-hidden />
          за счёт накладных
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-brick/40" aria-hidden />
          убыток
        </li>
        <li className="text-faint">шкала: снижение цены 0…30 %</li>
      </ul>
    </div>
  );
}

/** Большое число без коробки: значение крупно, подпись мелко. */
function BigNumber({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <p className="num text-[26px] font-semibold leading-none tracking-tight text-foreground">{value}</p>
      <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{label}</p>
    </div>
  );
}

export function MoneyBlock({ outlook, price }: { outlook: MoneyOutlook; price: number | null }) {
  const { securities, frozenPeak, margin, winter, advancePercent, paymentDays } = outlook;
  const cushion = price !== null ? priceCushion(margin) : null;
  const bigNumbers: { value: string; label: string }[] = [];
  if (frozenPeak !== null) bigNumbers.push({ value: compactRub(frozenPeak), label: "заморозится до этой суммы" });
  if (advancePercent !== null) {
    bigNumbers.push({
      value: advancePercent > 0 ? `${String(advancePercent).replace(".", ",")} %` : "нет",
      label: "аванс",
    });
  }
  if (paymentDays !== null) bigNumbers.push({ value: `${String(paymentDays)} дн.`, label: "оплата после приёмки" });

  return (
    <section className="space-y-4" aria-label="Деньги" data-testid="money-block">
      <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Деньги</h3>

      {bigNumbers.length > 0 && (
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          {bigNumbers.map((item) => (
            <BigNumber key={item.label} value={item.value} label={item.label} />
          ))}
        </div>
      )}
      {advancePercent === 0 && (
        <p className="text-sm text-muted-foreground">Аванса нет: работы — на свои деньги до оплаты.</p>
      )}

      {securities.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-[13.5px] text-accent-fg underline underline-offset-2 hover:no-underline [&::-webkit-details-marker]:hidden">
            Обеспечения по видам
          </summary>
          <p className="mt-2 text-sm font-medium text-foreground">Что заморозится</p>
          <ul className="mt-1 divide-y divide-border border-y border-border text-sm">
            {securities.map((line) => (
              <li key={line.kind} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
                <span className="text-foreground">
                  {line.label}
                  {line.percent !== null && <span className="text-faint"> · {String(line.percent).replace(".", ",")} %</span>}
                </span>
                <span className="num font-medium text-foreground">{line.amount === null ? "—" : rub(line.amount)}</span>
                <span className="w-full text-[12.5px] text-faint">{line.period}</span>
              </li>
            ))}
          </ul>
          {frozenPeak !== null && (
            <p className="mt-1.5 text-sm text-muted-foreground">
              Одновременно может быть заморожено до <span className="num font-medium text-foreground">{rub(frozenPeak)}</span>.
              Вместо денег можно дать банковскую гарантию — она стоит процент от суммы за срок действия.
            </p>
          )}
        </details>
      )}

      {margin !== null && price !== null && cushion !== null && (
        <div>
          <p className="text-sm font-medium text-foreground">Запас по цене при снижении на аукционе</p>
          <CushionBar cushion={cushion} />
          <p className="mt-2 text-sm text-foreground">
            Снижение до {cutLabel(cushion.profitShare)} — в пределах сметной прибыли, до {cutLabel(cushion.breakEvenShare)} —
            за счёт накладных, глубже — убыток по смете заказчика.
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            В смете заказчика сметная прибыль — {rub(margin.profit)} ({pct(margin.profit / margin.base)}), накладные —{" "}
            {rub(margin.overhead)} ({pct(margin.overhead / margin.base)}).
          </p>
          <details className="group mt-2">
            <summary className="cursor-pointer list-none text-[13.5px] text-accent-fg underline underline-offset-2 hover:no-underline [&::-webkit-details-marker]:hidden">
              Подробно по шагам снижения
            </summary>
            <ul className="mt-1 divide-y divide-border border-y border-border text-sm">
              {margin.scenarios.map((s) => (
                <li key={s.reduction} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                  <span className="w-24 shrink-0 text-foreground">−{Math.round(s.reduction * 100)} %</span>
                  <span className="num w-36 shrink-0 text-foreground">{rub(s.price)}</span>
                  <span className={s.profitLeft >= 0 ? "text-muted-foreground" : s.overheadLeft >= 0 ? "text-mustard-fg" : "text-brick-fg"}>
                    {s.note}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[12.5px] text-faint">
              Расчёт по смете заказчика: ваши фактические затраты могут быть ниже или выше сметных.
            </p>
          </details>
        </div>
      )}

      {winter !== null && (
        <p
          className={cn(
            "border-l-[3px] pl-3 text-sm",
            winter.included === null ? "border-mustard text-mustard-fg" : "border-border-strong text-muted-foreground",
          )}
        >
          Работы приходятся на зиму ({winter.months.join(", ")}).{" "}
          {winter.included === null
            ? "Зимнее удорожание в смете заказчика не начислено — работа зимой обойдётся дороже сметы: заложите это в цену или задайте вопрос заказчику."
            : `Зимнее удорожание в смете заказчика начислено: ${String(winter.included.percent).replace(".", ",")} %.`}
        </p>
      )}

    </section>
  );
}

/** Подписи к выводу сводки: откуда он и что говорит закон. */
export function FindingProvenance({
  sources,
  legalNote,
}: {
  sources?: readonly string[];
  legalNote?: string | null;
}) {
  return (
    <>
      {legalNote ? (
        <p className="mt-2 rounded-md border border-mustard-line bg-mustard-subtle px-3 py-2 text-[13px] leading-snug text-mustard-fg">
          {legalNote}
        </p>
      ) : null}
      {sources && sources.length > 0 ? (
        <p className="mt-1 text-[12.5px] text-faint">Документы: {sources.join("; ")}</p>
      ) : null}
    </>
  );
}
