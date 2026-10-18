"use client";

import type { RerankVerdict } from "@/domain/searchAssist";
import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { TenderRow } from "@/domain/filtering";
import type { SortField } from "@/domain/filtering";
import type { FreshnessLayer } from "@/domain/lastSearch";
import { isCriticalDeadline } from "@/domain/scoring";
import { isPricePublished } from "@/domain/priceVisibility";
import {
  conditionFlags,
  deadlineCountdown,
  moneyTerms,
  type CountdownTone,
} from "@/domain/tenderFacts";
import { formatDate, formatDateTime, formatTenderPrice, pluralRu } from "@/utils/format";
import {
  dataSourceLabels,
  documentOnlyMatchLabel,
  freshnessLayerLabels,
  lawLabels,
  pipelineLabels,
  placingWayLabels,
} from "@/lib/labels";
import { VerdictScore, verdictScoreTitle } from "@/components/tenders/VerdictScore";
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
   * Складывается из релевантности запросу и соответствия профилю компании. Показываем именно его:
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

/** Подписи оценок модели: коротко, чтобы строка не росла. */
const MODEL_FIT_LABELS: Record<RerankVerdict["fit"], { text: string; tone: string }> = {
  yes: { text: "подходит", tone: "text-olive-fg" },
  maybe: { text: "возможно", tone: "text-mustard-fg" },
  no: { text: "не подходит", tone: "text-brick-fg" },
};

/*
  Плотная таблица «терминального» вида: table-fixed с фиксированными ширинами,
  суммарно 948px, а с колонкой «Приоритет» — 1060px. Раньше было 1158 и 1270:
  вердикт и Fit занимали по отдельной колонке в начале, а «Главный риск» ещё
  126px; теперь вердикт и число соответствия — одна узкая колонка «Оценка» в
  конце, а риска в таблице нет.

  Ширины подобраны по фактическому контенту, а не на глаз: каждая равна самому
  широкому значению колонки плюс padding ячейки. «Оценка»: самая длинная
  подпись («Не подходит», ~76px при 12.5px) плюс padding пилюли и ячейки.
  Цена вылезала бы в соседнюю ячейку, если сузить её «красиво».

  Столько всё равно помещается не в каждое окно: под таблицу остаётся вьюпорт
  минус ~324px (сайдбар, padding 2×28, полоса прокрутки). Обёртка именно
  прокручивается, а не обрезает: с `overflow-hidden` на ноутбуке 1280px правые
  колонки были недостижимы вообще — ни мышью, ни с клавиатуры, ни
  скринридером.

  Числа, даты и номера — моноширинным (.num).
*/
/** Тон обратного отсчёта: те же пороги, что у риски строки и блока «Срочно». */
const COUNTDOWN_TONE: Record<CountdownTone, string> = {
  danger: "text-brick-fg font-medium",
  warning: "text-mustard-fg",
  neutral: "text-faint",
  closed: "text-faint line-through decoration-faint/60",
};

/*
  Колонки второго плана (`secondary`) прячутся уже `lg`: на телефоне и планшете
  таблица и так прокручивается, и до срока подачи с ценой приходилось листать
  через заказчика. Заказчик в этом случае переезжает строкой под название —
  информация не теряется, меняется только место.
*/
interface Column {
  field: SortField | null;
  label: string;
  width: number;
  hint?: string;
  secondary?: boolean;
  /** Название для скринридера в «Сортировать по …», если подпись заголовка не склоняется. */
  sortName?: string;
}

const columns: Column[] = [
  // 308 = предмет плюс чипы закона и способа размещения строкой под названием.
  // Не шире: на экране 1280px под таблицу остаётся 956px, и при 328 колонка
  // «Оценка» уезжала за край на 12px (замер 07.10.2026).
  { field: "subject", label: "Предмет закупки", width: 308 },
  { field: null, label: "Заказчик", width: 160, secondary: true },
  // 148: самая длинная цена в выдаче — «10 732 968,85 ₽», 116px. При 92px
  // цена вылезала в соседнюю ячейку: whitespace-nowrap не даёт ей перенестись,
  // а обрезки у этой ячейки нет. Запас сверх измеренного — на суммы в
  // миллиарды с копейками, которых в текущей выдаче не оказалось.
  // Под ценой — обеспечение заявки, контракта и аванс: сколько денег закупка
  // заморозит, видно до открытия карточки.
  { field: "price", label: "НМЦК", width: 148, hint: "Начальная цена; ниже — обеспечение заявки, контракта и аванс. Подчёркнутое пунктиром найдено в документации — наведите, чтобы увидеть фразу" },
  // «Подача до» печатает и обратный отсчёт («осталось 2 дня») — дату
  // приходится пересчитывать в голове, а срок решает, успеете ли подготовиться.
  { field: "submissionEnd", label: "Подача до", width: 104 },
  // 120: самый длинный статус — «Готовим заявку», ~100px при 15px.
  { field: null, label: "Статус", width: 120, secondary: true },
  // Вердикт и число соответствия — в одной узкой колонке в самом конце: глаз
  // сначала читает, что за закупка, а оценка — итог строки.
  {
    field: "fitScore",
    label: "Оценка",
    sortName: "оценке",
    width: 108,
    hint: "Подходит ли закупка вашей компании: слово и число от 0 до 100. Наведите на оценку, чтобы увидеть полное название.",
  },
];

/**
 * Колонка приоритета выдачи: добавляется только при активном поиске.
 *
 * Названа приоритетом, а не релевантностью, потому что строки упорядочивает не
 * одно совпадение слов, а сумма совпадения и соответствия профилю. Число в колонке — то же
 * самое, по которому выдача отсортирована: расхождение между напечатанным и
 * ключом сортировки читалось бы как поломка таблицы.
 */
const relevanceColumn: Column = {
  field: "relevance",
  label: "Приоритет",
  // 112: заголовок со стрелкой сортировки занимает 109px.
  width: 112,
  hint: "Насколько закупка подходит под запрос: совпадение слов (60%) и соответствие вашей компании (40%). Наведите на число, чтобы увидеть причины.",
};

/** Срочная строка помечена оранжевой риской у левого края первой ячейки. */
function UrgentBar() {
  return <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" aria-hidden />;
}

export function TenderTable({
  rows,
  sortField,
  sortDir,
  onSort,
  searchInfo,
  modelNotes,
  freshnessInfo,
  rowNotes,
  newIds,
  footer,
  onOpen,
}: {
  rows: TenderRow[];
  sortField: SortField;
  sortDir: "asc" | "desc";
  onSort: (field: SortField) => void;
  /** Результаты поиска по `tender.id`; отсутствует, когда запроса нет. */
  searchInfo?: Map<string, RowSearchInfo>;
  /** Оценки модели по смыслу, по идентификатору закупки: только когда человек их запросил. */
  modelNotes?: Record<string, RerankVerdict> | null;
  /** Слои свежести по `tender.id`; отсутствует, когда порядок не по свежести. */
  freshnessInfo?: Map<string, FreshnessCell>;
  /**
   * Пометки строк по `tender.id`: почему строка показана, хотя обычная выдача
   * её бы скрыла (результат последнего поиска вне профиля).
   */
  rowNotes?: Map<string, string>;
  /** Закупки, которых человек ещё не видел: появились после его прошлого визита или в этом поиске. */
  newIds?: ReadonlySet<string>;
  /**
   * Подвал карточки — страницы и размер страницы.
   *
   * Принимается пропом, а не рисуется отдельным блоком под таблицей: подвал
   * обязан лежать внутри той же карточки (так он выглядит частью таблицы),
   * но снаружи прокручиваемой области — иначе он уезжает вбок вместе с
   * колонками.
   */
  footer?: ReactNode;
  /**
   * Перехват открытия карточки. Нет — строка ведёт на страницу закупки; есть —
   * вызывается вместо перехода (демо-лента для гостя показывает предложение
   * зарегистрироваться, а не форму входа с пустым «next»).
   */
  onOpen?: (row: TenderRow) => void;
}) {
  // Релевантность показываем, только когда она хоть у кого-то не нулевая:
  // колонка сплошных нулей не объясняет порядок, а путает.
  const hasRelevance =
    searchInfo !== undefined &&
    rows.some((row) => (searchInfo.get(row.tender.id)?.relevanceScore ?? 0) > 0);

  const withRelevance = hasRelevance
    ? columns.map((c) => (c.label === "Предмет закупки" ? [relevanceColumn, c] : [c])).flat()
    : columns;
  const visibleColumns = withRelevance;

  // С колонкой «Приоритет» таблица шире на 112px и на ноутбуке 1280px
  // уводила «Оценку» за край. Статус воронки при этом прячется до 1440px:
  // он же виден в «Мои закупки», а оценка нужна в каждой строке.
  const statusHidden = hasRelevance ? "max-[1439px]:hidden" : "max-lg:hidden";

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
                className={cn(
                  "py-4 text-[12.5px] font-semibold uppercase tracking-[0.07em] text-faint whitespace-nowrap overflow-hidden",
                  c.label === "Оценка" ? "px-2" : "px-3",
                  c.secondary && (c.label === "Статус" ? statusHidden : "max-lg:hidden"),
                )}
              >
                {c.field ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => onSort(c.field as SortField)}
                    aria-label={`Сортировать по ${c.sortName ?? c.label}`}
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
            const countdown = deadlineCountdown(row.tender.deadlines.submissionEnd);
            const terms = moneyTerms(row.tender);
            const flags = conditionFlags(row.tender);
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
                  приёмом, каким референс отмечает выбранные строки. Риска
                  стоит на первой ячейке строки. Цвет здесь не единственный
                  носитель смысла: в колонке «Подача до» у этих же строк
                  напечатано «ещё N часов».
                */}
                {hasRelevance && (
                  <td className="relative px-3 py-4 overflow-hidden">
                    {critical && <UrgentBar />}
                    <span
                      className="num block text-foreground"
                      // Число без расшифровки выглядит произвольным: подсказка
                      // показывает обе его половины и причины совпадения.
                      title={
                        info === undefined
                          ? undefined
                          : [
                              `Совпадение с запросом: ${info.relevanceScore} из 100`,
                              `Соответствие компании: ${row.analysis.fitScore}`,
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
                <td className="relative px-3 py-4 overflow-hidden">
                  {critical && !hasRelevance && <UrgentBar />}
                  {/* Предмет — главный текст строки: крупнее остальной таблицы и
                      в две строки, как в референсе, где название занимает
                      половину ширины таблицы, а не четверть. */}
                  <Link
                    href={`/tenders/${row.tender.id}`}
                    className="font-medium text-foreground hover:text-accent-fg line-clamp-2 text-[16px] leading-snug"
                    onClick={
                      onOpen === undefined
                        ? undefined
                        : (event) => {
                            event.preventDefault();
                            onOpen(row);
                          }
                    }
                  >
                    {newIds?.has(row.tender.id) === true && (
                      <span
                        className="mr-2 inline-flex items-center gap-1 align-[2px] text-[12px] font-semibold uppercase tracking-wide text-accent-fg"
                        data-testid="row-new"
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
                        Новая
                      </span>
                    )}
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
                  {rowNotes?.get(row.tender.id) !== undefined && (
                    <p className="mt-1" data-testid="row-note">
                      <span className="inline-flex max-w-full items-center rounded-full border border-accent-line bg-accent-subtle px-2 py-0.5 text-[12px] leading-snug text-accent-fg">
                        {rowNotes.get(row.tender.id)}
                      </span>
                    </p>
                  )}
                  {modelNotes?.[row.tender.id] !== undefined && (
                    <p
                      className="mt-1 text-[12.5px] leading-snug text-muted-foreground"
                      data-testid="model-note"
                    >
                      <span className="text-faint">Модель: </span>
                      <span
                        className={`font-medium ${MODEL_FIT_LABELS[modelNotes[row.tender.id]!.fit].tone}`}
                      >
                        {MODEL_FIT_LABELS[modelNotes[row.tender.id]!.fit].text}
                      </span>
                      {modelNotes[row.tender.id]!.reason !== "" && ` — ${modelNotes[row.tender.id]!.reason}`}
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
                  {/* Метки закупки — обычный текст через разделители, без рамок: рамка
                      вокруг каждого слова превращала строку в ряд одинаковых коробочек. */}
                  <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-faint">
                    <span className="num truncate">
                      № {row.tender.regNumber}
                    </span>
                    {/* Закон и способ размещения были отдельной колонкой в 88px:
                        всё её содержимое — эти два чипа. Здесь они рядом с
                        названием, как в референсе, а 88px отданы предмету. */}
                    <span
                      className="shrink-0"
                      title={`Закон: ${lawLabels[row.tender.law]}`}
                    >
                      {lawLabels[row.tender.law]}
                    </span>
                    <span
                      className="max-w-[180px] truncate"
                      title={placingWayLabels[row.tender.placingWay]}
                    >
                      {placingWayLabels[row.tender.placingWay]}
                    </span>
                    {/*
                      Площадка-источник. Подписи — в `dataSourceLabels`, сам
                      перечень площадок — в каталоге `src/domain/sources.ts`.
                    */}
                    <span
                      className="shrink-0"
                      title={`Источник данных: ${dataSourceLabels[row.tender.dataSource]}`}
                    >
                      {dataSourceLabels[row.tender.dataSource]}
                    </span>
                    {/* Условия участия: СМП и нацрежим сужают круг участников
                        и подсвечены золотом — это то, из-за чего заявку
                        отклоняют без рассмотрения. Остальное — справочно. */}
                    {flags.map((flag) => (
                      <span
                        key={flag.label}
                        title={flag.hint}
                        className={cn(
                          "shrink-0",
                          flag.restrictive && "font-semibold text-mustard-fg",
                        )}
                      >
                        {flag.label}
                      </span>
                    ))}
                  </p>
                  {/* Ниже lg колонка «Заказчик» скрыта — заказчик здесь. */}
                  <p
                    className="mt-1 truncate text-[12.5px] text-muted-foreground lg:hidden"
                    title={row.tender.customerName}
                  >
                    {row.tender.customerName}
                    {row.tender.region && (
                      <span className="text-faint"> · {row.tender.region}</span>
                    )}
                  </p>
                </td>
                <td className="px-3 py-4 overflow-hidden max-lg:hidden">
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
                  {terms.length > 0 && (
                    <dl className="mt-1.5 space-y-0.5 text-[12px] leading-4" data-testid="money-terms">
                      {terms.map((term) => (
                        <div key={term.label} className="flex justify-between gap-2">
                          <dt className="text-faint">{term.label}</dt>
                          {/* Пунктир — значение найдено в тексте документации,
                              а не в реквизитах площадки; цитата в подсказке. */}
                          <dd
                            className={cn(
                              "num text-muted-foreground",
                              term.quote !== null &&
                                "cursor-help underline decoration-dotted decoration-faint underline-offset-2",
                            )}
                            title={
                              term.quote !== null
                                ? `Из документации: «${term.quote}»`
                                : undefined
                            }
                          >
                            {term.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </td>
                <td className="px-3 py-4 whitespace-nowrap">
                  <span className={cn("num block", critical ? "text-brick-fg font-medium" : "text-muted-foreground")}>
                    {formatDate(row.tender.deadlines.submissionEnd)}
                  </span>
                  {countdown && (
                    <span
                      className={cn("block text-[12.5px]", COUNTDOWN_TONE[countdown.tone])}
                      data-testid="deadline-countdown"
                    >
                      {countdown.text}
                    </span>
                  )}
                </td>
                <td className={cn("px-3 py-4 overflow-hidden", statusHidden)}>
                  <span className="text-muted-foreground block truncate">
                    {pipelineLabels[row.pipelineStatus]}
                  </span>
                </td>
                <td
                  className="px-2 py-4"
                  title={verdictScoreTitle(row.analysis.verdict, row.analysis.fitScore)}
                >
                  <VerdictScore verdict={row.analysis.verdict} fitScore={row.analysis.fitScore} />
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
