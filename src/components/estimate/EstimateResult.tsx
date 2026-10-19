"use client";

import { useMemo, useState } from "react";
import { Download, FileSpreadsheet } from "lucide-react";

import { Badge, Button } from "@/components/ui/primitives";
import { toBillOfWorkCsv } from "@/domain/estimate/export";
import { toLocalEstimateFormCsv } from "@/domain/estimate/exportForm";
import type {
  EstimateDocument,
  EstimateGap,
  EstimateLine,
  VolumeFinding,
  VolumeSource,
} from "@/domain/estimate/types";
import { describeEstimateMethod } from "@/domain/estimate/bimMethod";
import { volumeSourceLine } from "@/domain/estimate/volumeSource";
import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import {
  computeAssurance,
  droppingGaps,
  type EstimateAssurance,
} from "@/domain/estimate/assurance";
import { formatNumber } from "@/utils/format";
import type { TaxSystem } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import type { VatStatus } from "@/domain/estimate/vatStatus";
import { Fold } from "@/components/ui/Fold";
import { AppliedNormatives } from "@/components/estimate/AppliedNormatives";
import { BillTable } from "@/components/estimate/BillTable";
import type { BillEditor } from "@/hooks/useBillEdits";
import { BidEconomicsCard } from "@/components/estimate/BidEconomicsCard";
import { SsrBlock } from "@/components/estimate/SsrBlock";
import type { SsrAuditReport } from "@/domain/estimate/customerSsrAudit";
import type { SsrNmcComparison, SsrResult } from "@/domain/estimate/ssr";
import type { LsrSourceInfo } from "@/domain/estimate/customerLsrSet";
import { CustomerEstimateCard } from "@/components/estimate/CustomerEstimateCard";
import { EstimateConfidenceNote } from "@/components/estimate/EstimateConfidenceNote";
import { computeEstimateConfidence } from "@/domain/estimate/estimateConfidence";
import { LocalEstimateFormView } from "@/components/estimate/LocalEstimateFormView";
import type { EstimateBillSnapshot } from "@/domain/estimate/billReview";
import { describePriceZoneBasis } from "@/domain/estimate/priceZoneResolve";
import type { CustomerEstimate } from "@/domain/estimate/customerEstimate";
import { noVolumesNoticeFor } from "@/domain/estimate/noVolumes";

/**
 * Результат расчёта сметы: итоги, честность расчёта и выгрузки.
 *
 * Первым делом показывается не сумма, а доля допущений. Смета, в которой две
 * трети стоимости держатся на резервных нормативах, и смета, посчитанная по
 * справочникам, отличаются одной строкой отчёта — и пользователь обязан видеть
 * эту строку раньше, чем итог: иначе он унесёт число, не зная его цены.
 *
 * Рядом с процентом стоят его расшифровка, список позиций и то, что в расчёт не
 * вошло. Процент сам по себе не проверяем: непонятно ни что именно приняли на
 * веру, ни какая часть ведомости осталась непосчитанной, — а смета без этих
 * позиций выглядит ровно как полная.
 *
 * Отвергнутые строки ведомости показываются здесь же. Их не видно в смете — их
 * там и нет, — но именно они объясняют, почему смета вышла меньше ожидаемой.
 */

export interface EstimateResultData {
  readonly document: EstimateDocument;
  readonly rejected: readonly RejectedBillRow[];
  readonly documentsWithoutBill: readonly string[];
  /** Документы и файлы архивов, которые модель не читала как не содержащие объёмов. */
  readonly skippedNoVolumes?: readonly { readonly name: string }[];
  readonly billItems: number;
  /**
   * Откуда взяты объёмы расчёта. Нет у расчётов, посчитанных до приоритета
   * источников: тогда строка в карточке не показывается.
   */
  readonly volumeSource?: VolumeSource | null;
  /** Расхождения объёмов ведомости и сметы заказчика: на сумму не влияют. */
  readonly volumeFindings?: readonly VolumeFinding[];
  /**
   * Ведомость, как она ушла в расчёт, и сведения о подборе норм. Есть у расчётов нового воркера:
   * по ней строится таблица «Ведомость и нормы» и идёт пересчёт после правок. Нет — правок нет.
   */
  readonly bill?: EstimateBillSnapshot;
}

/** Что нужно блоку «Цена участия»: цена заказчика и налоговый режим компании. */
export interface EstimateBidContext {
  readonly nmc: number | null;
  readonly taxSystem: TaxSystem;
  readonly minMarginPercent: number;
  /** Закон закупки: для 44-ФЗ таблица цен отмечает антидемпинговое снижение. */
  readonly law?: TenderLaw;
  /** Что документация говорит про НДС в цене: от этого зависит начальное значение переключателя. */
  readonly vat?: VatStatus;
}

/** Сводный расчёт поверх сметы: наш ССР, сравнение с НМЦК и аудиты ССР заказчика (строки заказчика берутся оттуда). */
export interface EstimateSsrContext {
  readonly result: SsrResult;
  readonly comparison: SsrNmcComparison | null;
  readonly audits?: readonly SsrAuditReport[];
}

export function EstimateResult({
  data,
  regNumber,
  bid,
  customerEstimates,
  customerLsrs,
  editor,
  ssr,
}: {
  data: EstimateResultData;
  /**
   * Правка ведомости: таблица «Ведомость и нормы» и пересчёт. Нет — результат только читается.
   * `data` при этом — показанный расчёт (`editor.effective`): итоги, цена участия и выгрузки идут по нему.
   */
  editor?: BillEditor | null;
  regNumber: string;
  /**
   * Сметы заказчика, прочитанные из документации. Нет — блока сравнения нет;
   * пустой массив — блок говорит, что сравнивать не с чем.
   */
  customerEstimates?: readonly CustomerEstimate[];
  /** Локальные сметы заказчика, по которым построена ведомость: сравнение по каждой ЛСР. */
  customerLsrs?: readonly LsrSourceInfo[];
  /** Нет — блок цены не показывается (например, смета загружена без закупки). */
  bid?: EstimateBidContext;
  /**
   * Сводный расчёт и «наша оценка НМЦК». Есть — блок «Сводный расчёт и цена контракта» стоит над ценой
   * участия, а НМЦК сравнивается с ценой контракта, а не с голой сметой. Нет — как раньше.
   */
  ssr?: EstimateSsrContext | null;
}) {
  const [busy, setBusy] = useState<"csv" | "vor" | "xlsx" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { document, rejected } = data;
  // Один объект на документ: экранная форма пересобирается только при новом расчёте, а не при каждой перерисовке карточки.
  const lsrInput = useMemo(() => formInput(document, regNumber), [document, regNumber]);
  const assurance = computeAssurance(document, { volumeSource: data.volumeSource ?? null });
  const confidence = computeEstimateConfidence({ document, volumeSource: data.volumeSource ?? null, customerLsrs });
  const dropped = droppingGaps(document);
  // Ни позиций, ни источника объёмов: смета пуста не из-за сбоя, а потому что в документах нет объёмов.
  const noVolumes = noVolumesNoticeFor(data);
  const generatedAt = new Date(document.generatedAt);

  const download = (bytes: BlobPart, fileName: string, type: string): void => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = window.document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    // Ссылку на объект отпускаем руками: иначе файл держится в памяти вкладки.
    URL.revokeObjectURL(url);
  };

  const saveCsv = (kind: "csv" | "vor"): void => {
    setBusy(kind);
    setError(null);
    try {
      const { estimateFileName } = requireNames();
      if (kind === "vor") {
        download(
          toBillOfWorkCsv(document),
          `Ведомость объёмов ${regNumber}.csv`,
          "text/csv;charset=utf-8",
        );
      } else {
        download(
          toLocalEstimateFormCsv(formInput(document, regNumber)),
          estimateFileName(regNumber, generatedAt, "csv"),
          "text/csv;charset=utf-8",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось собрать файл");
    } finally {
      setBusy(null);
    }
  };

  const saveXlsx = async (): Promise<void> => {
    setBusy("xlsx");
    setError(null);
    try {
      const { buildEstimateWorkbook, estimateFileName } = await import(
        "@/domain/estimate/exportXlsx"
      );
      const bytes = await buildEstimateWorkbook({
        ...formInput(document, regNumber),
        confidence:
          confidence.level === "unknown"
            ? null
            : {
                title: confidence.title,
                explanation: confidence.explanation,
                ...(confidence.range === undefined ? {} : { rangeText: confidence.range.text }),
              },
      });
      download(
        bytes,
        estimateFileName(regNumber, generatedAt, "xlsx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось собрать книгу");
    } finally {
      setBusy(null);
    }
  };

  const lostCount = assurance.droppedPositions + assurance.unpricedResources + (assurance.projectMaterialGaps ?? 0);
  const hasAssumptions =
    assurance.assumptions.length > 0 ||
    assurance.indexedPrices !== undefined ||
    assurance.unappliedNormatives !== undefined;
  const assumedText = `${assurance.assumedPercent.toFixed(1).replace(".", ",")} %`;

  return (
    <div className="space-y-2">
      {noVolumes !== null && (
        <div
          role="status"
          data-testid="no-volumes"
          className="rounded-md border border-mustard-line bg-mustard-subtle px-4 py-3 text-mustard-fg"
        >
          <p className="text-[15px] font-semibold">{noVolumes.title}</p>
          <p className="mt-1 text-[14px]">{noVolumes.found}</p>
          {noVolumes.action !== "" && <p className="mt-2 text-[14px] font-medium">{noVolumes.action}</p>}
          <p className="mt-2 text-[13px]">Сумма ниже — не оценка объекта: без объёмов расчёту нечего считать.</p>
        </div>
      )}

      {/* Итог: одна цифра и то, на чём она держится. Всё остальное — в разделах ниже. */}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-muted-foreground">Стоимость СМР</p>
          <p className="mt-1 text-[32px] font-semibold leading-none tracking-tight tabular-nums">
            {formatNumber(document.totals.workCost)} ₽
          </p>
          <p className="mt-2 text-[14px] text-muted-foreground">
            с НДС {formatNumber(document.totals.total)} ₽
          </p>
          <EstimateConfidenceNote confidence={confidence} />
          {document.totals.customerPricedCount != null && document.totals.customerPricedCount > 0 && (
            <p className="mt-1 text-[13.5px] text-muted-foreground" data-testid="customer-priced">
              в т.ч. по ценам заказчика: {formatNumber(document.totals.customerPriced ?? 0)} ₽ (
              {formatNumber(document.totals.customerPricedCount)}{" "}
              {positionsWord(document.totals.customerPricedCount)}) — не проверено нашими ценами
            </p>
          )}
          {document.totals.ownPricedCount != null && document.totals.ownPricedCount > 0 && (
            <p className="mt-1 text-[13.5px] text-muted-foreground" data-testid="own-priced">
              в т.ч. по вашим ценам: {formatNumber(document.totals.ownPriced ?? 0)} ₽ (
              {formatNumber(document.totals.ownPricedCount)} {positionsWord(document.totals.ownPricedCount)}) — цены указали вы
            </p>
          )}
          <p className="mt-1 text-[13.5px] text-muted-foreground" data-testid="price-level">
            Цены: {document.priceZone}, {document.period}
            {document.priceZoneChoice != null &&
              ` — ${describePriceZoneBasis(document.priceZoneChoice)}`}
          </p>
          <MethodNote document={document} />
        </div>

        <div className="flex flex-col items-start gap-3 sm:items-end">
          <Badge tone={assurance.assumedPercent > 20 ? "brick" : "neutral"}>
            Допущений {assumedText}
          </Badge>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void saveXlsx()} disabled={busy !== null}>
              <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />
              {busy === "xlsx" ? "Собираем книгу..." : "Скачать Excel"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => saveCsv("csv")} disabled={busy !== null}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Смета CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => saveCsv("vor")} disabled={busy !== null}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Ведомость CSV
            </Button>
          </div>
        </div>
      </div>

      {lostCount > 0 && (
        <p className="border-l-[3px] border-mustard pl-3 text-[14px] text-foreground">
          <span className="font-medium">В расчёт вошло не всё.</span>{" "}
          <span className="text-muted-foreground">
            Итог занижен на вес позиций без цены или объёма — подробности в разделе «Допущения и пробелы».
          </span>
        </p>
      )}

      {error !== null && <p className="text-sm text-brick-fg">{error}</p>}

      {data.documentsWithoutBill.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Ведомости не нашлось в документах:{" "}
          {data.documentsWithoutBill.join(", ")}.
        </p>
      )}

      <div className="!mt-6 divide-y divide-border border-y border-border">
        {/* Тот же документ и те же реквизиты, что в скачиваемых файлах: экран и выгрузка показывают одни строки. */}
        <Fold
          title="Смета по форме 421/пр — как в ГРАНД-Смете"
          summary="Позиции с элементами ОТ, ЭМ, ОТм, М, НР, СП и итогами — тот же вид, что в файле Excel"
          testId="lsr-form-fold"
        >
          <LocalEstimateFormView input={lsrInput} />
        </Fold>

        {ssr != null && (
          <Fold title="Сводный расчёт НМЦК" summary="Резерв, инфляция и НДС — из чего складывается цена контракта">
            <SsrBlock result={ssr.result} comparison={ssr.comparison} audits={ssr.audits} />
          </Fold>
        )}

        {bid !== undefined && (
          <Fold
            title="Цена участия"
            summary="Безубыточная цена, допустимое снижение и запас прочности"
            defaultOpen
          >
            <BidEconomicsCard
              document={document}
              nmc={bid.nmc}
              billItems={data.billItems}
              droppedPositions={assurance.droppedPositions}
              assumedPercent={assurance.assumedPercent}
              unpricedResources={assurance.unpricedResources}
              taxSystem={bid.taxSystem}
              minMarginPercent={bid.minMarginPercent}
              law={bid.law}
              vat={bid.vat}
              ssr={ssr?.result ?? null}
            />
          </Fold>
        )}

        {customerEstimates !== undefined && (
          <Fold title="Смета заказчика" summary="Где наша смета расходится со сметой в документации">
            <CustomerEstimateCard
              document={document}
              estimates={customerEstimates}
              lsrs={customerLsrs}
              volumeFindings={data.volumeFindings}
            />
          </Fold>
        )}

        <Fold
          title="Ведомость и нормы"
          summary={`Позиций: ${String(data.billItems)} · для проверки сметчиком: нормы, объёмы, цены`}
          testId="bill-fold"
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[14px] sm:grid-cols-4">
            <Metric label="Позиций" value={String(data.billItems)} />
            <Metric label="Прямые затраты" value={`${formatNumber(document.totals.directCost)} ₽`} />
            <Metric label="Накладные расходы" value={`${formatNumber(document.totals.overheadCost)} ₽`} />
            <Metric label="Сметная прибыль" value={`${formatNumber(document.totals.profitCost)} ₽`} />
          </dl>
          {editor?.available === true && data.bill !== undefined ? (
            <BillTable editor={editor} />
          ) : (
            <>
              {editor !== undefined && editor !== null && (
                <p className="text-sm text-muted-foreground" data-testid="edit-unavailable">
                  Править ведомость можно после нового расчёта: эта смета посчитана до появления правок.
                </p>
              )}
              <Positions document={document} />
            </>
          )}
          {/* При правке отклонённые строки живут в «Не вошло в расчёт» таблицы — со своими кнопками. */}
          {rejected.length > 0 && editor?.available !== true && <RejectedRows rejected={rejected} />}
        </Fold>

        {(hasAssumptions || lostCount > 0 || data.volumeSource != null || (document.appliedNormatives?.length ?? 0) > 0) && (
          <Fold
            title="Допущения и пробелы"
            summary={
              lostCount > 0
                ? `Доля допущений ${assumedText} · в расчёт вошло не всё`
                : `Доля допущений ${assumedText} · откуда взяты объёмы и нормативы`
            }
            defaultOpen={lostCount > 0}
            tone={lostCount > 0 ? "warn" : undefined}
          >
            {lostCount > 0 && (
              <LostFromCalculation
                droppedPositions={assurance.droppedPositions}
                unpricedResources={assurance.unpricedResources}
                projectMaterialGaps={assurance.projectMaterialGaps ?? 0}
                dropped={dropped}
                gaps={document.gaps}
              />
            )}

            {data.volumeSource != null && (
              <div className="text-[14px]" data-testid="volume-source">
                <p className="font-medium text-foreground">{volumeSourceLine(data.volumeSource)}</p>
                {data.volumeSource.level !== "BILL" && (
                  <p className="mt-1 text-muted-foreground">{data.volumeSource.note}</p>
                )}
                {(data.volumeSource.details ?? []).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[13.5px] text-accent-fg">
                      Подробнее: откуда взята каждая смета ({(data.volumeSource.details ?? []).length})
                    </summary>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted-foreground" data-testid="volume-source-details">
                      {(data.volumeSource.details ?? []).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {hasAssumptions ? <Assumptions assurance={assurance} /> : null}

            {document.appliedNormatives !== undefined && document.appliedNormatives.length > 0 ? (
              <details className="rounded-md border border-border/60 px-3 py-2" data-testid="normatives-block">
                <summary className="cursor-pointer text-sm font-medium">Нормативы сверх норм: условия работ, зимнее, временные здания</summary>
                <div className="mt-2 text-sm text-muted-foreground">
                  <AppliedNormatives normatives={document.appliedNormatives} />
                </div>
              </details>
            ) : null}
          </Fold>
        )}
      </div>
    </div>
  );
}

/** Метод расчёта и, для базисно-индексного, чем считали: индексы письма, объект, оговорка про ТЕР. */
function MethodNote({ document }: { document: EstimateDocument }) {
  const method = describeEstimateMethod(document);
  return (
    <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground" data-testid="estimate-method-note">
      <p className="font-medium text-foreground">{method.title}</p>
      {method.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/**
 * Расшифровка доли допущений.
 *
 * Процент без перечня — это вердикт без основания. Здесь напечатано каждое
 * допущение домена отдельно: сколько стоимости на нём держится и какую долю
 * СМР оно занимает. Свёрнуто, потому что читать это нужно не каждый раз, а
 * когда процент большой или когда смету проверяют.
 */
function Assumptions({ assurance }: { assurance: EstimateAssurance }) {
  return (
    <details className="rounded-md border border-border/60 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        Из чего сложилась доля допущений
      </summary>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {assurance.assumptions.map((assumption) => (
          <li key={assumption.kind}>
            {`${assumption.message} — ${assumption.percent
              .toFixed(1)
              .replace(".", ",")} % (${formatNumber(assumption.cost)} ₽)`}
          </li>
        ))}
        {(assurance.unappliedNormatives ?? []).map((item) => (
          <li key={`unapplied-${item.code}`} data-testid="unapplied-normative">
            {`Не начислено из-за неизвестных данных: ${item.message}`}
          </li>
        ))}
        {assurance.indexedPrices !== undefined ? (
          <li key="indexed-prices">
            {`Не допущение: ${assurance.indexedPrices.message} — ${assurance.indexedPrices.percent
              .toFixed(1)
              .replace(".", ",")} % (${formatNumber(assurance.indexedPrices.cost)} ₽)`}
          </li>
        ) : null}
      </ul>
    </details>
  );
}

/**
 * То, чего в расчёте нет вовсе, и то, что посчитано нулём.
 *
 * Отдельный блок и отдельный цвет: доля допущений говорит о стоимости, которая
 * в документе есть, но опирается на приближение, а выпавшая позиция не даёт
 * стоимости ни в каком виде. Итог с ней занижен, и по сумме этого не видно —
 * поэтому блок предупреждающий, а не нейтральный.
 *
 * Остальные пробелы (цена не найдена, расход «по проекту», расхождение часов)
 * позиции не роняют, но объясняют, откуда взялись нули, и лежат под тем же
 * заголовком свёрнутыми.
 */
function LostFromCalculation({
  droppedPositions,
  unpricedResources,
  projectMaterialGaps,
  dropped,
  gaps,
}: {
  droppedPositions: number;
  unpricedResources: number;
  projectMaterialGaps: number;
  dropped: readonly EstimateGap[];
  gaps: readonly EstimateGap[];
}) {
  const counts: string[] = [];
  if (droppedPositions > 0) {
    counts.push(`Позиций без расчёта: ${String(droppedPositions)}`);
  }
  if (unpricedResources > 0) {
    counts.push(`Ресурсных строк без цены: ${String(unpricedResources)}`);
  }
  if (projectMaterialGaps > 0) {
    counts.push(`Материалов «по проекту» без количества и цены: ${String(projectMaterialGaps)}`);
  }
  const rest = gaps.filter((gap) => !dropped.includes(gap));

  return (
    <div className="rounded-md border border-mustard-line bg-mustard-subtle px-3 py-2">
      <p className="text-sm font-medium text-mustard-fg">
        В расчёт вошло не всё
      </p>
      <p className="text-sm text-mustard-fg">{counts.join(" · ")}</p>
      <ul className="mt-1 space-y-1 text-xs text-mustard-fg">
        {dropped.map((gap, index) => (
          <li key={`${gap.kind}-${String(index)}`}>· {gap.message}</li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-mustard-fg">
        Итог занижен на вес этих позиций: стоимости, которой в документе нет,
        расчёт не возвращает.
      </p>
      {rest.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium text-mustard-fg">
            Остальные пробелы расчёта: {String(rest.length)}
          </summary>
          <ul className="mt-1 space-y-1 text-xs text-mustard-fg">
            {rest.map((gap, index) => (
              <li key={`${gap.kind}-${String(index)}`}>· {gap.message}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Позиции сметы с кодом нормы и книгой.
 *
 * Код напечатан вместе с книгой, потому что один и тот же код в четырёх книгах
 * означает четыре разные работы: «ГЭСН 01-01-001-01» — это драглайн, а
 * «ГЭСНм 01-01-001-01» — токарный станок. Без книги строку нельзя найти в
 * справочнике, а значит нельзя и проверить.
 *
 * Строка поставки печатается как «ФСБЦ <код ресурса>»: у неё нет нормы, а есть
 * код справочника цен, и подписать её «ГЭСН» значило бы назвать источник,
 * которого у этой стоимости нет.
 */
function Positions({ document }: { document: EstimateDocument }) {
  const total = document.sections.reduce(
    (sum, section) => sum + section.lines.length,
    0,
  );
  if (total === 0) return null;

  return (
    <details className="rounded-md border border-border/60 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        {`Позиции сметы: ${String(total)}`}
      </summary>
      {document.sections.map((section) => (
        <div key={section.title} className="mt-2">
          <p className="text-xs font-medium text-muted-foreground">
            {section.title}
          </p>
          <ul className="mt-1 space-y-1 text-sm">
            {section.lines.map((line) => (
              <li
                key={line.itemId}
                className="flex flex-wrap justify-between gap-2"
              >
                <span>
                  {line.priceSource === "CUSTOMER_PRICE"
                    ? `${line.normName} · ${formatNumber(line.billQuantity)} ${line.billUnit} · по цене заказчика — не проверено нашими ценами`
                    : line.priceSource === "FGIS_SERVICE"
                      ? `${line.normName} · ${formatNumber(line.billQuantity)} ${line.billUnit} · ${line.priceNote ?? "цена ФГИС ЦС"}`
                      : line.priceSource === "OWN_PRICE"
                        ? `${line.normName} · ${formatNumber(line.billQuantity)} ${line.billUnit} · ${line.priceNote ?? "своя цена"}`
                        : `${line.normBaseType} ${line.normCode} · ${line.normName} · ${formatNumber(line.billQuantity)} ${line.billUnit}`}
                </span>
                <span className="num">{`${formatNumber(lineTotal(line))} ₽`}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

/** «1 позиция», «2 позиции», «5 позиций». */
function positionsWord(count: number): string {
  const last = count % 10;
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) return "позиций";
  if (last === 1) return "позиция";
  if (last >= 2 && last <= 4) return "позиции";
  return "позиций";
}

/**
 * Стоимость позиции: прямые затраты плюс накладные расходы и сметная прибыль.
 *
 * То же, что печатают выгрузки, — иначе число на экране и число в файле
 * расходятся, и сметчик не понимает, какое из них верное. НДС сюда не входит:
 * он начисляется на итог документа, а не на позицию.
 */
function lineTotal(line: EstimateLine): number {
  return line.directCost + line.overheadCost + line.profitCost;
}

/**
 * Строки ведомости, не подтверждённые документом.
 *
 * Показываются свёрнутыми и с причинами: список нужен, чтобы понять, почему
 * смета меньше ожидаемой, а не чтобы читать его целиком.
 */
function RejectedRows({
  rejected,
}: {
  rejected: readonly RejectedBillRow[];
}) {
  const byReason = new Map<string, number>();
  for (const item of rejected) {
    byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  }

  return (
    <details className="rounded-md border border-border/60 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        Не вошло в ведомость: {rejected.length}
      </summary>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {[...byReason].map(([reason, count]) => (
          <li key={reason}>
            {reasonLabels[reason] ?? reason}: {count}
          </li>
        ))}
      </ul>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        {rejected.slice(0, 8).map((item, index) => (
          <li key={`${item.reason}-${String(index)}`}>· {item.message}</li>
        ))}
      </ul>
    </details>
  );
}

const reasonLabels: Record<string, string> = {
  EMPTY_NAME: "без наименования работы",
  BAD_QUANTITY: "объём не число",
  UNKNOWN_UNIT: "единица не распознана",
  MONEY_NOT_WORK: "сумма, а не работа",
  QUOTE_NOT_FOUND: "цитаты нет в документе",
  QUANTITY_QUOTE_NOT_FOUND: "фрагмента с объёмом нет в документе",
  QUANTITY_NOT_IN_QUOTE: "объём не виден в цитате",
  ANCHORS_TOO_FAR: "наименование и объём из разных мест",
  DUPLICATE: "повтор",
  NOT_WORK: "таблица не из работ (машины, кадры, СИЗ, график)",
  WHOLE_WORK: "объём задан всей работой (1 усл. ед.)",
  DUPLICATE_POSITION: "дубль позиции после распознавания",
  LOWER_SOURCE: "объём есть в источнике выше по приоритету",
};

/** Реквизиты формы: то, что известно расчёту, без ручного ввода. */
function formInput(document: EstimateDocument, regNumber: string) {
  return {
    document,
    number: regNumber,
    constructionName: document.title,
    objectName: document.title,
    basis: "Ведомость объёмов работ, извлечённая из документации закупки",
  };
}

/** Имя файла собирается тем же модулем, что и книга: одно правило на оба. */
function requireNames() {
  return {
    estimateFileName: (
      regNumber: string,
      generatedAt: Date,
      extension: "csv" | "xlsx",
    ): string => {
      const safe = regNumber.replace(/[\\/:"*?<>|]/g, "");
      const date = generatedAt.toISOString().slice(0, 10);
      return `Смета ${safe} от ${date}.${extension}`;
    },
  };
}
