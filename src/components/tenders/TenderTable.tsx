"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { TenderRow } from "@/domain/filtering";
import type { SortField } from "@/domain/filtering";
import type { FreshnessLayer } from "@/domain/lastSearch";
import { isCriticalDeadline } from "@/domain/scoring";
import { isPricePublished } from "@/domain/priceVisibility";
import { VerdictBadge, FitScore } from "@/components/analysis";
import { formatDate, formatDateTime, formatTenderPrice, pluralRu } from "@/utils/format";
import {
  dataSourceLabels,
  documentOnlyMatchLabel,
  freshnessLayerLabels,
  lawLabels,
  pipelineLabels,
  placingWayLabels,
} from "@/lib/labels";
import { cn } from "@/lib/cn";

/**
 * Слой свежести строки и размер её слоя.
 *
 * Передаётся отдельно от строк и только при порядке «свежесть + фит»: таблица
 * не знает, как выбран порядок, и не должна угадывать слои сама — иначе
 * разделители появились бы и над выдачей, отсортированной по цене.
 */
export interface FreshnessCell {
  layer: FreshnessLayer;
  /** Сколько закупок в слое при текущих фильтрах — не только на этой странице. */
  total: number;
  /** Метка прогона; есть только у слоя последнего поиска. */
  stamp: string | null;
}

/**
 * Подпись разделителя слоя.
 *
 * Время прогона печатается только у последнего поиска: у «на этой неделе» и
 * «раньше» одной общей даты нет, а выдуманная дата в заголовке группы была бы
 * ложью. Число закупок в слое объясняет, почему ниже идут совсем другие сроки.
 */
function separatorLabel(cell: FreshnessCell): string {
  const name = freshnessLayerLabels[cell.layer];
  const when =
    cell.layer === "LAST_RUN" && cell.stamp !== null ? ` ${formatDateTime(cell.stamp)}` : "";
  const count = pluralRu(cell.total, ["закупка", "закупки", "закупок"]);
  return `${name}${when} — ${cell.total} ${count}`;
}

/**
 * Что нашлось в закупке при текущем запросе.
 *
 * Передаётся отдельно от строк и только при активном поиске: без запроса
 * объяснять нечего, а таблица обязана выглядеть ровно так же, как раньше.
 */
export interface RowSearchInfo {
  /** Фрагмент текста вокруг совпадения — как сниппет в выдаче Контур.Закупок. */
  snippet: string | null;
  /**
   * Приоритет выдачи — то, по чему строки реально упорядочены.
   *
   * Складывается из релевантности запросу и Fit Score. Показываем именно его:
   * колонка, отсортированная по одному числу, а напечатанная другим, выглядит
   * сломанной, даже если второе число «правильнее».
   */
  priority: number;
  /** Балл релевантности 0..100 — часть приоритета, объясняющая совпадение слов. */
  relevanceScore: number;
  /** Готовые фразы «почему эта закупка в выдаче», от самой важной к менее. */
  reasons: string[];
  /**
   * Совпадение найдено только в тексте документации.
   *
   * Помечается отдельно: извещение на двести страниц содержит почти любое
   * слово, поэтому такое совпадение слабее найденного в названии, и разница
   * обязана быть видна.
   */
  documentOnly: boolean;
}

/*
  Плотная таблица «терминального» вида: table-fixed с фиксированными ширинами,
  суммарно 1158px, а с колонкой «Приоритет» — 1270px.

  Ширины подобраны по фактическому контенту, а не на глаз: каждая равна самому
  широкому значению колонки плюс padding ячейки. До этого набор был «красивый»,
  но неверный — вердикт обрезался во всех строках, цена вылезала в соседнюю
  ячейку, а Fit держал 116px под шкалу-трек, которую давно не рисует.

  Столько всё равно помещается не в каждое окно: под таблицу остаётся вьюпорт
  минус ~324px (сайдбар 248, padding 2×28, полоса прокрутки), поэтому целиком
  она видна с ~1490px, а при активном поиске — с ~1600px. Замерено, не выведено:
  на 1492px обёртка даёт ровно 1168px и скролла уже нет.

  Обёртка именно прокручивается, а не обрезает: с `overflow-hidden` на ноутбуке
  1280px колонка «Статус» была недостижима вообще — ни мышью, ни с клавиатуры,
  ни скринридером.

  Числа, даты и номера — моноширинным (.num).
*/
const columns: { field: SortField | null; label: string; width: number; hint?: string }[] = [
  // 136 = самая длинная короткая подпись («Не подходит», 111px) + padding ячейки.
  // При 112px обрезался каждый вердикт в таблице.
  { field: null, label: "Вердикт", width: 136 },
  // 64, а не 116: ширина под шкалу-трек осталась от версии, где FitScore рисовал
  // полосу. Сейчас это просто число в пилюле — ему хватает 31px, остальные 85
  // были мёртвой шириной и отнимали место у цены.
  { field: "fitScore", label: "Fit", width: 64 },
  // 328 = прежние 240 плюс 88px колонки «Закон», которая уехала чипами в эту же
  // ячейку: как в референсе, закон и способ размещения живут строкой чипов под
  // названием, а не отдельной колонкой в восемь символов шириной.
  { field: "subject", label: "Предмет закупки", width: 328 },
  { field: null, label: "Заказчик", width: 160 },
  // 148: самая длинная цена в выдаче — «10 732 968,85 ₽», 116px. При 92px
  // цена вылезала в соседнюю ячейку: whitespace-nowrap не даёт ей перенестись,
  // а обрезки у этой ячейки нет. Запас сверх измеренного — на суммы в
  // миллиарды с копейками, которых в текущей выдаче не оказалось.
  { field: "price", label: "НМЦК", width: 148 },
  { field: "submissionEnd", label: "Подача до", width: 104 },
  // 126 оставлено как было: заголовок «ГЛАВНЫЙ РИСК» длинный, а замерить его
  // отдельно не удалось — сужать колонку «на глаз» значит поставить на неё
  // ту же ошибку, из-за которой обрезался вердикт.
  { field: null, label: "Главный риск", width: 126 },
  { field: null, label: "Статус", width: 92 },
];

/**
 * Колонка приоритета выдачи: добавляется только при активном поиске.
 *
 * Названа приоритетом, а не релевантностью, потому что строки упорядочивает не
 * одно совпадение слов, а сумма совпадения и Fit Score. Число в колонке — то же
 * самое, по которому выдача отсортирована: расхождение между напечатанным и
 * ключом сортировки читалось бы как поломка таблицы.
 */
const relevanceColumn = {
  field: "relevance" as SortField,
  label: "Приоритет",
  // 112: заголовок со стрелкой сортировки занимает 109px.
  width: 112,
  hint: "Насколько закупка подходит под запрос: совпадение слов (60%) и Fit Score (40%). Наведите на число, чтобы увидеть причины.",
};

function topRisk(row: TenderRow): string {
  const risks = row.analysis.contractRisks;
  if (risks.length > 0) {
    const worst = [...risks].sort(
      (a, b) =>
        ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(a.severity) -
        ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(b.severity),
    )[0];
    return worst ? worst.title : "—";
  }
  const blocker = row.analysis.hardBlockers[0];
  return blocker ? blocker.reason : "—";
}

export function TenderTable({
  rows,
  sortField,
  sortDir,
  onSort,
  searchInfo,
  freshnessInfo,
  footer,
}: {
  rows: TenderRow[];
  sortField: SortField;
  sortDir: "asc" | "desc";
  onSort: (field: SortField) => void;
  /** Результаты поиска по `tender.id`; отсутствует, когда запроса нет. */
  searchInfo?: Map<string, RowSearchInfo>;
  /** Слои свежести по `tender.id`; отсутствует, когда порядок не по свежести. */
  freshnessInfo?: Map<string, FreshnessCell>;
  /**
   * Подвал карточки — страницы и размер страницы.
   *
   * Принимается пропом, а не рисуется отдельным блоком под таблицей: подвал
   * обязан лежать внутри той же карточки (так он выглядит частью таблицы),
   * но снаружи прокручиваемой области — иначе он уезжает вбок вместе с
   * колонками.
   */
  footer?: ReactNode;
}) {
  // Колонка «Главный риск» имеет смысл только когда риск есть хотя бы у одной
  // строкой выдачи: страница прочерков не несёт информации и съедает ширину.
  const hasAnyRisk = rows.some((row) => topRisk(row) !== "—");
  // Релевантность показываем, только когда она хоть у кого-то не нулевая:
  // колонка сплошных нулей не объясняет порядок, а путает.
  const hasRelevance =
    searchInfo !== undefined &&
    rows.some((row) => (searchInfo.get(row.tender.id)?.relevanceScore ?? 0) > 0);

  const withRelevance = hasRelevance
    ? columns.map((c) => (c.label === "Предмет закупки" ? [relevanceColumn, c] : [c])).flat()
    : columns;
  const visibleColumns = hasAnyRisk
    ? withRelevance
    : withRelevance.filter((c) => c.label !== "Главный риск");

  return (
    /*
      Карточка целиком: прокручивается только область таблицы, подвал со
      страницами остаётся на месте. Если положить подвал внутрь прокрутки, он
      уезжал бы вбок вместе с колонками.
    */
    <div className="card overflow-hidden">
      {/* tabIndex/role/aria-label — требование WCAG 2.1.1 к прокручиваемой
          области: до правых колонок нужно добираться и с клавиатуры, а не
          только колесом или тачпадом. */}
      <div
        className="scroll-hint-x overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Таблица закупок"
      >
      <table className="w-full table-fixed text-[15px] leading-tight">
        <thead>
          <tr className="border-b border-border bg-panel-raised text-left">
            {visibleColumns.map((c) => (
              <th
                key={c.label}
                style={{ width: c.width }}
                title={c.hint}
                className="px-3 py-4 text-[12.5px] font-semibold uppercase tracking-[0.07em] text-faint whitespace-nowrap overflow-hidden"
              >
                {c.field ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => onSort(c.field as SortField)}
                    aria-label={`Сортировать по ${c.label}`}
                  >
                    {c.label}
                    {sortField === c.field ? (
                      sortDir === "asc" ? (
                        <ArrowUp className="h-3 w-3 text-accent" strokeWidth={2} />
                      ) : (
                        <ArrowDown className="h-3 w-3 text-accent" strokeWidth={2} />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 text-faint" strokeWidth={2} />
                    )}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const critical = isCriticalDeadline(row.tender.deadlines.submissionEnd);
            const info = searchInfo?.get(row.tender.id);
            const pricePublished = isPricePublished(row.tender);
            /*
              Разделитель слоя рисуется там, где слой сменился: строки приходят
              уже упорядоченными по слоям, поэтому достаточно сравнения с
              предыдущей строкой. На следующей странице сравнивать не с чем, и
              разделитель повторяется — это правильно: читатель обязан видеть,
              в каком слое продолжение списка.
            */
            const cell = freshnessInfo?.get(row.tender.id);
            const previousLayer =
              i > 0 ? freshnessInfo?.get(rows[i - 1]!.tender.id)?.layer : undefined;
            const separator =
              cell !== undefined && (i === 0 || previousLayer !== cell.layer) ? cell : null;
            return (
              <Fragment key={row.tender.id}>
                {separator && (
                  <tr className="border-y border-border bg-panel-raised">
                    <td
                      colSpan={visibleColumns.length}
                      className="px-3 py-2 text-[12.5px] font-semibold uppercase tracking-[0.07em] text-faint"
                    >
                      {separatorLabel(separator)}
                    </td>
                  </tr>
                )}
                <tr
                  style={{ animationDelay: `${Math.min(i, 14) * 50}ms` }}
                  className="row-in border-b border-border last:border-0 hover:bg-panel-raised/60 transition-colors align-top"
                >
                {/*
                  Срочные строки помечены оранжевой риской слева — тем же
                  приёмом, каким референс отмечает выбранные строки. Цвет здесь
                  не единственный носитель смысла: в колонке «Подача до» у этих
                  же строк напечатано «< 24 ч».
                */}
                <td className="relative px-3 py-4 overflow-hidden">
                  {critical && (
                    <span
                      className="absolute inset-y-0 left-0 w-[3px] bg-accent"
                      aria-hidden
                    />
                  )}
                  <VerdictBadge verdict={row.analysis.verdict} short />
                </td>
                <td className="px-3 py-4">
                  <FitScore value={row.analysis.fitScore} size="md" />
                </td>
                {hasRelevance && (
                  <td className="px-3 py-4 overflow-hidden">
                    <span
                      className="num block text-foreground"
                      // Число без расшифровки выглядит произвольным: подсказка
                      // показывает обе его половины и причины совпадения.
                      title={
                        info === undefined
                          ? undefined
                          : [
                              `Совпадение с запросом: ${info.relevanceScore} из 100`,
                              `Fit Score: ${row.analysis.fitScore}`,
                              `Приоритет: ${info.priority}`,
                              ...info.reasons,
                            ].join(" · ")
                      }
                    >
                      {info?.priority ?? 0}
                    </span>
                    <span className="block truncate text-[12.5px] text-faint">
                      {info?.reasons[0] ?? "—"}
                    </span>
                  </td>
                )}
                <td className="px-3 py-4 overflow-hidden">
                  {/* Предмет — главный текст строки: крупнее остальной таблицы и
                      в две строки, как в референсе, где название занимает
                      половину ширины таблицы, а не четверть. */}
                  <Link
                    href={`/tenders/${row.tender.id}`}
                    className="font-medium text-foreground hover:text-accent-fg line-clamp-2 text-[16px] leading-snug"
                  >
                    {row.tender.subject}
                  </Link>
                  {/* Сниппет: фрагмент текста вокруг совпадения. Без него строка,
                      найденная по слову из спецификации или документации,
                      выглядит как ошибка — в названии-то слова нет. */}
                  {info?.snippet && (
                    <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
                      {info.snippet}
                    </p>
                  )}
                  {info?.documentOnly && (
                    <p
                      className="mt-0.5 text-[10px] text-faint"
                      title="Слово из запроса встретилось только в тексте документации закупки"
                    >
                      {documentOnlyMatchLabel}
                    </p>
                  )}
                  <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="num truncate text-[12.5px] text-faint">
                      № {row.tender.regNumber}
                    </span>
                    {/* Закон и способ размещения были отдельной колонкой в 88px:
                        всё её содержимое — эти два чипа. Здесь они рядом с
                        названием, как в референсе, а 88px отданы предмету. */}
                    <span
                      className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-faint"
                      title={`Закон: ${lawLabels[row.tender.law]}`}
                    >
                      {lawLabels[row.tender.law]}
                    </span>
                    <span
                      className="max-w-[180px] truncate rounded border border-border px-1 text-[10px] leading-4 text-faint"
                      title={placingWayLabels[row.tender.placingWay]}
                    >
                      {placingWayLabels[row.tender.placingWay]}
                    </span>
                    {/*
                      Площадка-источник. Подписи — в `dataSourceLabels`, сам
                      перечень площадок — в каталоге `src/domain/sources.ts`.
                    */}
                    <span
                      className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-faint"
                      title={`Источник данных: ${dataSourceLabels[row.tender.dataSource]}`}
                    >
                      {dataSourceLabels[row.tender.dataSource]}
                    </span>
                  </p>
                </td>
                <td className="px-3 py-4 overflow-hidden">
                  {/* line-clamp без block: утилиты обрезки сами задают display,
                      а block его перебивает и текст печатается целиком. */}
                  <span
                    className="text-muted-foreground line-clamp-1"
                    title={row.tender.customerName}
                  >
                    {row.tender.customerName}
                  </span>
                  <span
                    className="text-[12.5px] text-faint block truncate"
                    title={row.tender.region}
                  >
                    {row.tender.region}
                  </span>
                </td>
                <td className="px-3 py-4 whitespace-nowrap">
                  {/* Цена показывается в валюте закупки: коммерческие торги
                      объявляют в долларах и юанях, и знак «₽» рядом с такой
                      суммой — прямая дезинформация. */}
                  <span
                    className={cn(
                      "block",
                      pricePublished
                        ? "num text-foreground"
                        : "text-[12.5px] text-muted-foreground",
                    )}
                    title={
                      pricePublished
                        ? undefined
                        : "Площадка не опубликовала цену: запросы цен и запросы предложений публикуются без НМЦ"
                    }
                  >
                    {formatTenderPrice(
                      row.tender.financial.price,
                      row.tender.financial.currency,
                    )}
                  </span>
                </td>
                <td className="px-3 py-4 whitespace-nowrap">
                  <span className={cn("num block", critical ? "text-brick-fg font-medium" : "text-muted-foreground")}>
                    {formatDate(row.tender.deadlines.submissionEnd)}
                  </span>
                  {critical && (
                    <span className="num text-[12.5px] text-brick-fg">&lt; 24 ч</span>
                  )}
                </td>
                {hasAnyRisk && (
                  <td className="px-3 py-4 overflow-hidden">
                    <span
                      className="text-muted-foreground line-clamp-1"
                      title={topRisk(row)}
                    >
                      {topRisk(row)}
                    </span>
                  </td>
                )}
                <td className="px-3 py-4 overflow-hidden">
                  <span className="text-muted-foreground block truncate">
                    {pipelineLabels[row.pipelineStatus]}
                  </span>
                  <span className="num text-[12.5px] text-faint block truncate">
                    {formatDate(row.analysis.analyzedAt)}
                  </span>
                </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
      {footer && (
        <div className="border-t border-border bg-panel px-4 py-3">{footer}</div>
      )}
    </div>
  );
}
