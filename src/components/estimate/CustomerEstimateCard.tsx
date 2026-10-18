"use client";

import { useMemo } from "react";

import {
  compareWithCustomerEstimate,
  BASE_PRICES_TEXT,
  describeComparisonEstimate,
  lsrRowDetails,
  lsrRowNote,
  rowDroppedNote,
  rowNote,
  SECTION_VERDICT_NOTE,
  type ComparisonRow,
  type LsrComparisonRow,
  type SectionVerdict,
  verificationLines,
  type TotalComparison,
} from "@/domain/estimate/customerComparison";
import type { CustomerEstimate } from "@/domain/estimate/customerEstimate";
import type { LsrSourceInfo } from "@/domain/estimate/customerLsrSet";
import type { EstimateDocument, VolumeFinding } from "@/domain/estimate/types";
import { cn } from "@/lib/cn";

/**
 * Сравнение нашего расчёта со сметой заказчика по разделам.
 *
 * Итог «у заказчика 5 млн, у нас 6,2 млн» говорит, что расхождение есть, но не
 * где. Таблица по разделам показывает, что именно заказчик заложил меньше текущих
 * цен — туда и смотреть, когда решаешь, какую цену подавать.
 *
 * Все числа считает `compareWithCustomerEstimate`, разделы и суммы заказчика
 * прочитаны из документации кодом (`parseCustomerEstimates`), модель здесь не
 * участвует. Если итог сметы не сошёлся с разделами, блок говорит об этом прямо:
 * сумма могла быть прочитана не из той колонки.
 */

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub = (value: number | null): string => (value === null ? "—" : `${RUB.format(Math.round(value))} ₽`);
const signedRub = (value: number | null): string => {
  if (value === null) return "—";
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${RUB.format(Math.abs(rounded))} ₽`;
};
const signedPercent = (value: number | null): string => {
  if (value === null) return "—";
  const text = Math.abs(value).toFixed(1).replace(".", ",");
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text} %`;
};

const VERDICT_TONE: Record<SectionVerdict, string> = {
  CLOSE: "text-muted-foreground",
  OURS_HIGHER: "text-brick-fg",
  OURS_LOWER: "text-olive-fg",
  MISSING_IN_OURS: "text-mustard-fg",
};

/** Сколько участвующих смет перечисляем; остальные — «и ещё N». */
const SHOWN_ESTIMATES = 5;

export interface CustomerEstimateCardProps {
  readonly document: EstimateDocument;
  readonly estimates: readonly CustomerEstimate[];
  /**
   * Локальные сметы заказчика, по которым построена ведомость (без повторов между документами). Есть —
   * ниже таблицы по разделам стоит сравнение по каждой ЛСР.
   */
  readonly lsrs?: readonly LsrSourceInfo[];
  /**
   * Расхождения объёмов ведомости со сметой заказчика. Это сверка цифр, а не денег,
   * и на суммы в таблице она не влияет; выводится в том же блоке, чтобы расхождение
   * по деньгам и по объёмам читались вместе.
   */
  readonly volumeFindings?: readonly VolumeFinding[];
}

/** Находки сверки объёмов: расхождение цифр и работы ведомости, которых нет в смете заказчика. */
function VolumeFindings({ findings }: { findings: readonly VolumeFinding[] }) {
  if (findings.length === 0) return null;
  const only = findings.filter((finding) => finding.kind === "BILL_ONLY");
  const differences = findings.filter((finding) => finding.kind !== "BILL_ONLY");
  return (
    <div className="space-y-2 text-sm">
      {differences.length > 0 && (
        <div className="space-y-1" data-testid="volume-findings">
          <p className="font-medium text-mustard-fg">
            Объёмы ведомости расходятся со сметой заказчика: {differences.length}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {differences.map((finding, index) => (
              <li key={`${finding.workName}-${String(index)}`}>{finding.message}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            На сумму расчёта не влияет: проверьте, какая из двух цифр верна.
          </p>
        </div>
      )}
      {only.length > 0 && (
        <div className="space-y-1" data-testid="volume-findings-bill-only">
          <p className="font-medium text-mustard-fg">
            Работы ведомости, которых нет в смете заказчика: {only.length}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {only.map((finding, index) => (
              <li key={`${finding.workName}-${String(index)}`}>{finding.message}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Расчёт идёт по смете заказчика, поэтому этих работ в нём нет: возможно, заказчик их забыл, а включить в цену
            придётся вам.
          </p>
        </div>
      )}
    </div>
  );
}

export function CustomerEstimateCard({ document, estimates, lsrs, volumeFindings }: CustomerEstimateCardProps) {
  const comparison = useMemo(() => compareWithCustomerEstimate(document, estimates, lsrs ?? []), [document, estimates, lsrs]);
  const findings = volumeFindings ?? [];

  if (comparison.status === "NO_CUSTOMER_ESTIMATE") {
    return (
      <section className="rounded-md border border-border p-3" aria-label="Сравнение со сметой заказчика">
        <h3 className="text-sm font-semibold">Сравнение со сметой заказчика</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Смета заказчика в документации не найдена — сравнивать не с чем.
        </p>
        <LsrTable rows={comparison.perLsr ?? []} total={comparison.perLsrTotal ?? null} />
        <VolumeFindings findings={findings} />
      </section>
    );
  }

  const verification = verificationLines(comparison.estimates);

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Сравнение со сметой заказчика">
      <h3 className="text-sm font-semibold">Сравнение со сметой заказчика</h3>

      <div className="space-y-1 text-sm">
        {comparison.estimates.length > 0 && (
          <>
            <p className="text-muted-foreground">Прочитаны сметы заказчика:</p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {comparison.estimates.slice(0, SHOWN_ESTIMATES).map((info, index) => (
                <li key={`${info.documentName}-${info.estimateName ?? ""}-${String(index)}`}>
                  {describeComparisonEstimate(info)}
                </li>
              ))}
              {comparison.estimates.length > SHOWN_ESTIMATES && (
                <li className="list-none">и ещё {comparison.estimates.length - SHOWN_ESTIMATES}</li>
              )}
            </ul>
          </>
        )}
        {comparison.baseEstimates.length > 0 && (
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">
              Не сравниваются (базисные цены): {comparison.baseEstimates.length}
            </summary>
            <p className="mt-1 text-xs">Они {BASE_PRICES_TEXT}.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              {comparison.baseEstimates.map((info, index) => (
                <li key={`${info.documentName}-${info.estimateName ?? ""}-${String(index)}`}>
                  {describeComparisonEstimate(info)}
                </li>
              ))}
            </ul>
          </details>
        )}
        {verification.length > 0 && (
          <div data-testid="verification">
            {verification.map((line) => (
              <p key={line.text} className={line.ok ? "text-olive-fg" : "text-mustard-fg"}>
                {line.text}
              </p>
            ))}
          </div>
        )}
      </div>

      {comparison.status === "BASE_PRICES_ONLY" && (
        <p className="text-sm text-mustard-fg">Смета заказчика {BASE_PRICES_TEXT}.</p>
      )}

      {comparison.status === "NO_SECTIONS" && (
        <p className="text-sm text-muted-foreground">
          В смете заказчика найдены только итоги, разделов нет — сравнивать по разделам нечего.
        </p>
      )}

      {comparison.status === "LEGACY_ESTIMATE" && (
        <>
          <p className="text-sm text-mustard-fg">
            Смета посчитана до появления сравнения по разделам — пересчитайте, чтобы увидеть разбивку. Пока можно
            сравнить только итоги.
          </p>
          {comparison.overall !== null && <OverallLine total={comparison.overall} />}
        </>
      )}

      {comparison.status === "NO_OUR_SECTIONS" && (
        <>
          <p className="text-sm text-muted-foreground">
            В документах, по которым считались объёмы, разделов нет — сравниваем только итоги.
          </p>
          {comparison.overall !== null && <OverallLine total={comparison.overall} />}
        </>
      )}

      {comparison.status === "OK" && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="pb-1 text-left text-muted-foreground">
                Разделы без НДС: прямые затраты, накладные и сметная прибыль
              </caption>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Раздел</th>
                  <th className="py-1 pr-3 text-right font-normal">У заказчика</th>
                  <th className="py-1 pr-3 text-right font-normal">У нас</th>
                  <th className="py-1 pr-3 text-right font-normal">Разница</th>
                  <th className="py-1 pr-3 text-right font-normal">%</th>
                  <th className="py-1 font-normal">Пометка</th>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((row, index) => (
                  <Row key={`${row.title}-${String(index)}`} row={row} />
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="py-1 pr-3">Итого по сопоставленным разделам</td>
                  <td className="py-1 pr-3 text-right">{rub(comparison.matchedCustomer)}</td>
                  <td className="py-1 pr-3 text-right">{rub(comparison.matchedOurs)}</td>
                  <td className="py-1 pr-3 text-right">{signedRub(comparison.diff)}</td>
                  <td className="py-1 pr-3 text-right">{signedPercent(comparison.diffPercent)}</td>
                  <td className={cn("py-1", comparison.verdict !== null && VERDICT_TONE[comparison.verdict])}>
                    {comparison.verdict === null ? "разделы не сопоставились" : SECTION_VERDICT_NOTE[comparison.verdict]}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {comparison.droppedPositions > 0 && (
            <p className="text-xs text-muted-foreground">
              В нашем расчёте не посчитано позиций: {comparison.droppedPositions}. Часть разницы может быть из-за
              этого.
            </p>
          )}
          {comparison.coverage !== null && (
            <p className="text-xs text-muted-foreground">
              Сопоставлено {Math.round(comparison.coverage * 100)} % суммы разделов заказчика.
            </p>
          )}

          {comparison.customerOnly.length > 0 && (
            <details className="rounded-md border border-border/60 px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Разделы заказчика без наших позиций</summary>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                {comparison.customerOnly.map((row, index) => (
                  <li key={`${row.title}-${String(index)}`}>
                    {row.title}: {rub(row.customerAmount)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {comparison.unmatchedOurs.count > 0 && (
            <details className="rounded-md border border-border/60 px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">
                Наши позиции вне разделов заказчика: {comparison.unmatchedOurs.count} на{" "}
                {rub(comparison.unmatchedOurs.amount)}
              </summary>
              <p className="mt-2 text-sm text-muted-foreground">
                Позиции, раздел которых в документации не найден или не совпал с разделами сметы заказчика: в таблицу
                выше они не входят.
              </p>
            </details>
          )}
        </>
      )}

      <LsrTable rows={comparison.perLsr ?? []} total={comparison.perLsrTotal ?? null} />

      <VolumeFindings findings={findings} />
    </section>
  );
}

/** Сравнение по каждой локальной смете заказчика: у заказчика / у нас / разница / %. */
function LsrTable({ rows, total }: { rows: readonly LsrComparisonRow[]; total: TotalComparison | null }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto" data-testid="lsr-comparison">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="pb-1 text-left text-muted-foreground">
          По каждой локальной смете заказчика, без НДС: прямые затраты, накладные и сметная прибыль
        </caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-3 font-normal">Смета</th>
            <th className="py-1 pr-3 text-right font-normal">У заказчика</th>
            <th className="py-1 pr-3 text-right font-normal">У нас</th>
            <th className="py-1 pr-3 text-right font-normal">Разница</th>
            <th className="py-1 pr-3 text-right font-normal">%</th>
            <th className="py-1 font-normal">Пометка</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.title}-${String(index)}`} className="border-t border-border/60">
              <td className="py-1 pr-3">{row.title}</td>
              <td className="py-1 pr-3 text-right">{rub(row.customerAmount)}</td>
              <td className="py-1 pr-3 text-right">{rub(row.ourAmount)}</td>
              <td className="py-1 pr-3 text-right">{signedRub(row.diff)}</td>
              <td className="py-1 pr-3 text-right">{signedPercent(row.diffPercent)}</td>
              <td className={cn("py-1", VERDICT_TONE[row.verdict])}>
                {lsrRowNote(row)}
                {lsrRowDetails(row).map((line) => (
                  <span key={line} className="block text-xs text-muted-foreground">
                    {line}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
        {total !== null && (
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="py-1 pr-3">Итого по сметам</td>
              <td className="py-1 pr-3 text-right">{rub(total.customerAmount)}</td>
              <td className="py-1 pr-3 text-right">{rub(total.ourAmount)}</td>
              <td className="py-1 pr-3 text-right">{signedRub(total.diff)}</td>
              <td className="py-1 pr-3 text-right">{signedPercent(total.diffPercent)}</td>
              <td className={cn("py-1", VERDICT_TONE[total.verdict])}>{SECTION_VERDICT_NOTE[total.verdict]}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function OverallLine({ total }: { total: TotalComparison }) {
  return (
    <p className="text-sm" data-testid="overall">
      Сумма разделов заказчика {rub(total.customerAmount)} · наш расчёт {rub(total.ourAmount)} · разница{" "}
      {signedRub(total.diff)} ({signedPercent(total.diffPercent)}) —{" "}
      <span className={VERDICT_TONE[total.verdict]}>{SECTION_VERDICT_NOTE[total.verdict]}</span>
    </p>
  );
}

function Row({ row }: { row: ComparisonRow }) {
  const dropped = rowDroppedNote(row);
  return (
    <tr className="border-t border-border/60">
      <td className="py-1 pr-3">{row.title}</td>
      <td className="py-1 pr-3 text-right">{rub(row.customerAmount)}</td>
      <td className="py-1 pr-3 text-right">{rub(row.ourAmount)}</td>
      <td className="py-1 pr-3 text-right">{signedRub(row.diff)}</td>
      <td className="py-1 pr-3 text-right">{signedPercent(row.diffPercent)}</td>
      <td className={cn("py-1", VERDICT_TONE[row.verdict])}>
        {rowNote(row)}
        {dropped !== null && <span className="block text-xs text-muted-foreground">{dropped}</span>}
      </td>
    </tr>
  );
}
