"use client";

import { useState } from "react";
import { Download, FileSpreadsheet } from "lucide-react";

import { Badge, Button, Card } from "@/components/ui/primitives";
import { toBillOfWorkCsv } from "@/domain/estimate/export";
import { toLocalEstimateFormCsv } from "@/domain/estimate/exportForm";
import type {
  EstimateDocument,
  EstimateGap,
  EstimateLine,
} from "@/domain/estimate/types";
import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import {
  computeAssurance,
  droppingGaps,
  type EstimateAssurance,
} from "@/domain/estimate/assurance";
import { formatNumber } from "@/utils/format";

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
  readonly billItems: number;
}

export function EstimateResult({
  data,
  regNumber,
}: {
  data: EstimateResultData;
  regNumber: string;
}) {
  const [busy, setBusy] = useState<"csv" | "vor" | "xlsx" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { document, rejected } = data;
  const assurance = computeAssurance(document);
  const dropped = droppingGaps(document);
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
      const bytes = await buildEstimateWorkbook(formInput(document, regNumber));
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

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Стоимость СМР</p>
          <p className="text-2xl font-semibold">
            {formatNumber(document.totals.workCost)} ₽
          </p>
          <p className="text-sm text-muted-foreground">
            с НДС {formatNumber(document.totals.total)} ₽
          </p>
        </div>
        <Badge tone={assurance.assumedPercent > 20 ? "brick" : "neutral"}>
          Допущений {assurance.assumedPercent.toFixed(1).replace(".", ",")} %
        </Badge>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Metric label="Позиций" value={String(data.billItems)} />
        <Metric
          label="Прямые затраты"
          value={`${formatNumber(document.totals.directCost)} ₽`}
        />
        <Metric
          label="Накладные расходы"
          value={`${formatNumber(document.totals.overheadCost)} ₽`}
        />
        <Metric
          label="Сметная прибыль"
          value={`${formatNumber(document.totals.profitCost)} ₽`}
        />
      </dl>

      {assurance.assumptions.length > 0 ? <Assumptions assurance={assurance} /> : null}

      {assurance.droppedPositions > 0 || assurance.unpricedResources > 0 ? (
        <LostFromCalculation
          droppedPositions={assurance.droppedPositions}
          unpricedResources={assurance.unpricedResources}
          dropped={dropped}
          gaps={document.gaps}
        />
      ) : null}

      <Positions document={document} />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void saveXlsx()} disabled={busy !== null}>
          <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />
          {busy === "xlsx" ? "Собираем книгу..." : "Скачать Excel"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => saveCsv("csv")}
          disabled={busy !== null}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Смета CSV
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => saveCsv("vor")}
          disabled={busy !== null}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Ведомость CSV
        </Button>
      </div>

      {error !== null && <p className="text-sm text-brick-fg">{error}</p>}

      {data.documentsWithoutBill.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Ведомости не нашлось в документах:{" "}
          {data.documentsWithoutBill.join(", ")}.
        </p>
      )}

      {rejected.length > 0 && <RejectedRows rejected={rejected} />}
    </Card>
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
  dropped,
  gaps,
}: {
  droppedPositions: number;
  unpricedResources: number;
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
                  {`${line.normBaseType} ${line.normCode} · ${line.normName} · ${formatNumber(line.billQuantity)} ${line.billUnit}`}
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
