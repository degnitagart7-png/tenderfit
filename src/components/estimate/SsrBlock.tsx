"use client";

import { SSR } from "@/domain/estimate/ssrNormatives";
import type { SsrAuditReport } from "@/domain/estimate/customerSsrAudit";
import type { SsrNmcComparison, SsrResult } from "@/domain/estimate/ssr";
import { inflationLine, moneyText, nmcHeadline, signedPercentText, ssrTableRows } from "@/domain/estimate/ssrText";
import { cn } from "@/lib/cn";

/**
 * Сводный расчёт и цена контракта.
 *
 * Наша локальная смета оформлена как сводный сметный расчёт (421/пр, глава IX): главы, итоги по главам
 * 1-7, 1-8, 1-9, 1-12, резерв на непредвиденные, НДС. Затем — «наша оценка НМЦК»: цена контракта подрядчика
 * по 841/пр (главы подрядчика, резерв, прогнозная инфляция, НДС). Её и сравнивают с НМЦК закупки, а не с
 * голой сметой: НМЦК по 44-ФЗ строится именно так. Главы заказчика (10-12) не оцениваются и в цену
 * контракта не входят — об этом сказано в самом блоке.
 */

const TONE = (diff: number | null): string =>
  diff === null || diff === 0 ? "text-muted-foreground" : diff > 0 ? "text-olive-fg" : "text-brick-fg";

export interface SsrBlockProps {
  readonly result: SsrResult;
  readonly comparison: SsrNmcComparison | null;
  /** Аудиты ССР заказчика: из первого берутся значения заказчика по строкам. */
  readonly audits?: readonly SsrAuditReport[];
}

export function SsrBlock({ result, comparison, audits = [] }: SsrBlockProps) {
  if (result.status === "EMPTY") {
    return (
      <section className="rounded-md border border-border p-3" aria-label="Сводный расчёт и цена контракта" data-testid="ssr-block">
        <h3 className="text-sm font-semibold">Сводный расчёт и цена контракта</h3>
        <p className="mt-1 text-sm text-muted-foreground">Смета пуста: сводный расчёт строить не из чего.</p>
      </section>
    );
  }
  const withRows = audits.find((audit) => audit.rows.length > 0);
  const customerRows = new Map((withRows?.rows ?? []).map((row) => [row.id, row] as const));
  const tableRows = ssrTableRows(result);

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Сводный расчёт и цена контракта" data-testid="ssr-block">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Сводный расчёт и цена контракта</h3>
        <p className="text-sm" data-testid="ssr-headline">
          {nmcHeadline(result, comparison)}
        </p>
        {comparison !== null && (
          <p className={cn("text-xs", comparison.diff > 0 ? "text-brick-fg" : "text-olive-fg")} data-testid="ssr-diff">
            {comparison.diff === 0
              ? "Наша оценка совпала с НМЦК"
              : comparison.diff < 0
                ? `НМЦК выше нашей оценки на ${moneyText(Math.abs(comparison.diff))} ₽: есть запас`
                : `НМЦК ниже нашей оценки на ${moneyText(Math.abs(comparison.diff))} ₽: закупка недооценена заказчиком`}
            {" · "}
            {signedPercentText(comparison.diffPercent)}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          НМЦК по 44-ФЗ складывается из глав сводного сметного расчёта, резерва на непредвиденные, прогнозной инфляции и НДС
          (421/пр, гл. IX; 841/пр, п. 21-23); сравнение идёт с ценой контракта, а не с голой сметой.
        </p>
      </div>

      <div className="overflow-x-auto" data-testid="ssr-rows">
        <table className="w-full min-w-[520px] text-sm">
          <caption className="pb-1 text-left text-muted-foreground">Наша оценка НМЦК по строкам</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal">Строка</th>
              <th className="py-1 pr-3 text-right font-normal">У нас, ₽</th>
              {withRows !== undefined && <th className="py-1 pr-3 text-right font-normal">У заказчика, ₽</th>}
              {withRows !== undefined && <th className="py-1 pr-3 text-right font-normal">Разница, ₽</th>}
              <th className="py-1 font-normal">Основание</th>
            </tr>
          </thead>
          <tbody>
            {result.nmc.rows.map((row) => {
              const theirs = customerRows.get(row.id);
              return (
                <tr key={row.id} className="border-t border-border/60" data-testid={`ssr-row-${row.id}`}>
                  <td className="py-1 pr-3">{row.label}</td>
                  <td className="py-1 pr-3 text-right">{moneyText(row.amount)}</td>
                  {withRows !== undefined && (
                    <td className="py-1 pr-3 text-right">{theirs?.customer === null || theirs === undefined ? "—" : moneyText(theirs.customer)}</td>
                  )}
                  {withRows !== undefined && (
                    <td className={cn("py-1 pr-3 text-right", TONE(theirs?.diff === undefined || theirs.diff === null ? null : -theirs.diff))}>
                      {theirs?.diff === undefined || theirs.diff === null ? "—" : `${theirs.diff > 0 ? "+" : theirs.diff < 0 ? "−" : ""}${moneyText(Math.abs(theirs.diff))}`}
                    </td>
                  )}
                  <td className="py-1 text-xs text-muted-foreground">{row.note}</td>
                </tr>
              );
            })}
            <tr className="border-t border-border font-medium">
              <td className="py-1 pr-3">Без НДС</td>
              <td className="py-1 pr-3 text-right">{moneyText(result.nmc.beforeVat)}</td>
              {withRows !== undefined && <td />}
              {withRows !== undefined && <td />}
              <td />
            </tr>
            <tr className="font-medium">
              <td className="py-1 pr-3">Наша оценка НМЦК с НДС</td>
              <td className="py-1 pr-3 text-right" data-testid="ssr-total">
                {moneyText(result.nmc.total)}
              </td>
              {withRows !== undefined && <td />}
              {withRows !== undefined && <td />}
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="ssr-inflation">
        {inflationLine(result)}
      </p>

      <details className="rounded-md border border-border/60 px-3 py-2" data-testid="ssr-chapters">
        <summary className="cursor-pointer text-sm font-medium">Главы и итоги сводного расчёта (текущие цены)</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-normal">Глава, итог</th>
                <th className="py-1 pr-3 text-right font-normal">Всего, ₽</th>
                <th className="py-1 font-normal">Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, index) => (
                <tr
                  key={`${row.kind}-${String(index)}`}
                  className={cn("border-t border-border/60", row.kind !== "chapter" && "font-medium", row.kind === "chapter" && row.amount === null && "text-muted-foreground")}
                >
                  <td className="py-1 pr-3">{row.label}</td>
                  <td className="py-1 pr-3 text-right">{row.amount === null ? "не оценивалась" : moneyText(row.amount)}</td>
                  <td className="py-1 text-xs text-muted-foreground">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Главы 10-12 — затраты заказчика (строительный контроль и служба заказчика, эксплуатационные кадры, изыскания, проектирование,
          экспертиза, авторский надзор): в цену подрядного контракта не входят (841/пр, п. 21; 421/пр, п. 162, 170, 171). Все наши строки —
          в графе «строительные работы» (графа 4): разбивки на монтаж и оборудование в ведомости нет.
        </p>
      </details>

      {result.assumptions.length > 0 && (
        <ul className="space-y-1 text-xs text-mustard-fg" data-testid="ssr-assumptions">
          {result.assumptions
            .filter((assumption) => assumption.affectsPrice)
            .map((assumption) => (
              <li key={assumption.code}>Допущение: {assumption.text}</li>
            ))}
        </ul>
      )}

      <details className="rounded-md border border-border/60 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">На чём это стоит</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>
            Резерв на непредвиденные: {String(result.reserve.percent)} % от итога глав 1-12 — {result.purpose.label.toLowerCase()} (
            {result.reserve.ref}); {result.purpose.note}. {SSR.reserve.repairNote}
          </li>
          <li>{SSR.vat.rateNote}</li>
          {SSR.contract.includes.map((item) => (
            <li key={item.citation.ref + item.text}>
              {item.text} ({item.citation.ref})
            </li>
          ))}
          {SSR.contract.excludes.map((item) => (
            <li key={item.citation.ref + item.text}>
              Не входит: {item.text} ({item.citation.ref})
            </li>
          ))}
          <li>{SSR.contract.reserveNote}</li>
          {result.assumptions
            .filter((assumption) => !assumption.affectsPrice)
            .map((assumption) => (
              <li key={assumption.code}>{assumption.text}</li>
            ))}
        </ul>
      </details>
    </section>
  );
}
