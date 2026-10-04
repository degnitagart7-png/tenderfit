"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import type { SearchProfile } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import { TENDER_LAWS } from "@/domain/enums";
import type { SortField, TenderFilters as Filters } from "@/domain/filtering";
import {
  buildTextQuery,
  countRowsByLaw,
  defaultFilters,
  paginate,
  searchRows,
  sortSearched,
} from "@/domain/filtering";
import { freshnessContextOf, groupByFreshness } from "@/domain/lastSearch";
import {
  filtersFromSearchParams,
  filtersToSearchParams,
} from "@/domain/filterUrl";
import { buildSnippetCorpus, snippetForMatch, snippetIsRedundant } from "@/domain/textSearch";
import {
  autoAppliedProfile,
  filtersFromSearchProfile,
} from "@/domain/searchProfileFilters";
import { profileDescribesSubject } from "@/domain/emptyCompanyProfile";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { activeFilterChips } from "@/lib/filterChips";
import { searchEmptyLabel } from "@/lib/labels";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { useTenderData } from "@/hooks/useTenderData";
import { LawSwitcher } from "@/components/tenders/LawSwitcher";
import { TenderFiltersPanel } from "@/components/tenders/TenderFiltersPanel";
import {
  TenderTable,
  type FreshnessCell,
  type RowSearchInfo,
} from "@/components/tenders/TenderTable";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Stat,
  StatStrip,
} from "@/components/ui/primitives";
import { isCriticalDeadline } from "@/domain/scoring";

/**
 * Чем объясняется порядок выдачи.
 *
 * Подпись была захардкожена и всегда утверждала «отсортировано по тому,
 * насколько закупка подходит компании», хотя по умолчанию лента сортируется по
 * свежести, а при нажатии на заголовок колонки — по цене, сроку или названию.
 * Из-за этого закупка с Fit 73 стояла на 24-м месте под строками с Fit 64, и
 * порядок выглядел сломанным.
 */
const sortExplanations: Record<SortField, string> = {
  freshness: "сначала найденные последним поиском",
  relevance: "сначала самые подходящие под запрос",
  fitScore: "отсортировано по тому, насколько закупка подходит компании",
  price: "отсортировано по НМЦК",
  submissionEnd: "отсортировано по сроку подачи",
  subject: "отсортировано по названию",
  analyzedAt: "отсортировано по дате разбора",
};

export function TendersView() {
  const { rows, loading, error, reload } = useTenderData();
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [searchProfiles, setSearchProfiles] = useState<SearchProfile[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  /*
    URL читается один раз после монтирования, и до применения прочитанного
    запись в адрес запрещена. Флаг держим в состоянии, а не в ref: ref
    меняется синхронно, и эффект записи успевал отработать в том же коммите —
    ещё со старыми фильтрами. Он стирал параметры из адреса, а на следующем
    коммите `window.location.search` оказывался не обновлён (предыдущий
    `router.replace` в полёте), эффект решал «адрес уже правильный» и не
    возвращал параметры обратно. Открытие ссылки `?q=…` приводило к выдаче
    без адреса.
  */
  const [urlApplied, setUrlApplied] = useState(false);
  /** Имя профиля, который лента применила сама; null — фильтры задал человек. */
  const [appliedProfileName, setAppliedProfileName] = useState<string | null>(null);
  /** Профиль применился, но не дал ни строки — лента откатилась к полной. */
  const [emptyProfileName, setEmptyProfileName] = useState<string | null>(null);

  useEffect(() => {
    const enabled = searchProfileRepository.getAll().filter((p) => p.enabled);
    setSearchProfiles(enabled);
    const params = new URLSearchParams(window.location.search);
    if (params.toString() !== "") {
      setFilters(filtersFromSearchParams(params));
    } else {
      /*
        Своего адреса нет — открыли ленту с меню. Применяем профиль поиска:
        человек уже сказал, что ищет, и показывать вместо этого всё подряд
        значит игнорировать настройку. Ограничения при этом видны чипами и
        снимаются одним нажатием, так что скрытой фильтрации не возникает.
      */
      const auto = autoAppliedProfile(enabled);
      if (auto) {
        setAppliedProfileName(auto.name);
        setFilters((f) => ({ ...f, ...filtersFromSearchProfile(auto) }));
      }
    }
    // Оба обновления попадают в один коммит: эффект записи впервые отработает
    // уже с фильтрами из адреса и не сделает лишней навигации.
    setUrlApplied(true);
  }, []);

  // Ссылка на выдачу воспроизводима: фильтры живут в адресной строке.
  useEffect(() => {
    if (!urlApplied) return;
    const query = filtersToSearchParams(filters).toString();
    const target = query !== "" ? `${pathname}?${query}` : pathname;
    const current = `${pathname}${window.location.search}`;
    if (target !== current) router.replace(target, { scroll: false });
  }, [filters, pathname, router, urlApplied]);

  const regions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.tender.region))).sort(),
    [rows],
  );

  // Площадки показываем только те, что реально есть в выдаче: пустой фильтр
  // «Контур.Закупки» при неподключённом API только путал бы пользователя.
  const sources = useMemo(
    () => Array.from(new Set(rows.map((r) => r.tender.dataSource))).sort(),
    [rows],
  );

  // Запрос разбирается один раз на фильтр-объект: он нужен и ленте (отбор),
  // и таблице (сниппет), и подписи пустой выдачи.
  const textQuery = useMemo(() => buildTextQuery(filters), [filters]);
  const hits = useMemo(() => searchRows(rows, filters), [rows, filters]);

  // Счётчики переключателя закона: сколько закупок даст каждый закон при
  // остальных текущих фильтрах. Сам закон в расчёте не участвует — иначе
  // переключатель показывал бы нули у соседних законов и переставал бы быть подсказкой.
  const lawCounts = useMemo(() => countRowsByLaw(rows, filters), [rows, filters]);

  // Показываем законы, которые есть в данных, плюс уже выбранные: спрятать
  // действующий фильтр значило бы рисовать «Все» при работающем ограничении.
  const lawOptions = useMemo<TenderLaw[]>(() => {
    const present = new Set(rows.map((r) => r.tender.law));
    return TENDER_LAWS.filter((law) => present.has(law) || filters.laws.includes(law));
  }, [rows, filters.laws]);

  /*
    Порядок выдачи выводится, а не хранится в фильтрах.

    Как только задан запрос, выдачу определяет релевантность: ни Fit Score, ни
    свежесть не знают про совпадение слов и поставили бы выше закупку, где
    нужного слова нет вовсе. Осознанный выбор пользователя (цена, срок,
    название) при этом не перебивается — подменяется только порядок по умолчанию.

    Держать это в состоянии означало бы помнить, кто и когда переключил поле:
    снятие чипа поиска, применение профиля и «Сбросить» оставляли бы сортировку
    «по релевантности» при пустом запросе, и стрелка указывала бы на колонку,
    которой в таблице уже нет.
  */
  const effectiveSortField: SortField =
    (filters.sortField === "fitScore" || filters.sortField === "freshness") &&
    textQuery !== null
      ? "relevance"
      : filters.sortField === "relevance" && textQuery === null
        ? "fitScore"
        : filters.sortField;

  /*
    Момент «сейчас» и штамп последней партии считаются один раз на выдачу: и
    сортировка, и разделители в таблице обязаны видеть одно и то же состояние,
    иначе строка могла бы попасть в слой «Новые» по одному расчёту и в «Раньше»
    по другому.
  */
  const freshness = useMemo(() => freshnessContextOf(rows), [rows]);

  const sorted = useMemo(
    () => sortSearched(hits, effectiveSortField, filters.sortDir, freshness),
    [hits, effectiveSortField, filters.sortDir, freshness],
  );
  const page = useMemo(
    () => paginate(sorted, filters.page, filters.pageSize),
    [sorted, filters.page, filters.pageSize],
  );
  const pageRows = useMemo(() => page.items.map((hit) => hit.row), [page.items]);

  /*
    Слои считаются по всей отфильтрованной выдаче, а не по видимой странице:
    разделитель утверждает «Новые · последний поиск — 12 закупок», и это число
    обязано оставаться верным, когда пользователь долистал до второй страницы.
    Сам разделитель рисуется только там, где слой действительно начинается, —
    таблицу сравнивает соседние строки.

    При другом порядке выдача не разбита на слои, и подписи были бы ложью:
    строки перемешаны по цене, а текст утверждал бы, что сверху новые.
  */
  const freshnessInfo = useMemo<Map<string, FreshnessCell> | undefined>(() => {
    if (effectiveSortField !== "freshness") return undefined;
    const groups = groupByFreshness(
      sorted.map((hit) => hit.row),
      freshness,
    );
    const info = new Map<string, FreshnessCell>();
    for (const group of groups) {
      for (const row of group.rows) {
        info.set(row.tender.id, {
          layer: group.layer,
          total: group.rows.length,
          stamp: group.stamp,
        });
      }
    }
    return info;
  }, [effectiveSortField, sorted, freshness]);

  /*
    Сниппет считается только для видимой страницы: он нужен на экране, а не в
    адресной строке, и строить его для пятисот закупок ради десяти строк —
    лишняя работа на каждое нажатие клавиши.

    Корпус для сниппета уже поискового: заказчик, номер извещения и адрес в
    поиске участвуют, но в таблице у них свои колонки, и повторять их под
    предметом закупки значит превратить подсказку в шум.
  */
  const searchInfo = useMemo<Map<string, RowSearchInfo> | undefined>(() => {
    if (textQuery === null) return undefined;
    const info = new Map<string, RowSearchInfo>();
    for (const hit of page.items) {
      const { match, relevance, row, combined } = hit;
      const snippet = snippetForMatch(buildSnippetCorpus(row.tender), match, textQuery.query);
      info.set(row.tender.id, {
        // Совпадение в коротком названии даёт сниппет, равный самому названию:
        // печатать его второй раз — шум, а не подсказка.
        snippet: snippetIsRedundant(snippet, row.tender.subject) ? null : snippet,
        priority: combined,
        relevanceScore: relevance.score,
        reasons: relevance.reasons.map((reason) => reason.label),
        // Совпадение только в документации помечается отдельно: извещение на
        // двести страниц содержит почти любое слово, и эта разница обязана быть видна.
        documentOnly: match.scopes.length === 1 && match.scopes[0] === "documents",
      });
    }
    return info;
  }, [page.items, textQuery]);

  /*
    Свой запрос заменяет слова профиля.

    Строка поиска и ключевые слова профиля — альтернативы («или»), поэтому
    профиль, оставшийся под ногами, разбавлял бы любой запрос: с профилем
    «ноутбуки» человек печатал «принтер» и получал принтеры вместе с
    ноутбуками. Именно так выглядело «ищу юриспруденцию, а выходят чужие
    услуги».

    Снимаются только слова. Регионы, цены и закон профиля остаются: они видны
    чипами и снимаются по одному, а «Сбросить всё» убирает их разом.
  */
  const patch = (p: Partial<Filters>) => {
    const typing = p.search !== undefined && p.search !== filters.search;
    if (typing && appliedProfileName !== null && filters.searchKeywords.length > 0) {
      setAppliedProfileName(null);
      setFilters((f) => ({ ...f, ...p, searchKeywords: [] }));
      return;
    }
    setFilters((f) => ({ ...f, ...p }));
  };

  /*
    Профиль применился, но не совпал ни с одной закупкой — откатываемся к
    полной ленте.

    Пустой экран при первом открытии хуже, чем неотфильтрованный список:
    человек не отличит «по вашим условиям ничего нет» от «сервис сломался».
    Замер на живых данных показал ровно этот случай — демонстрационный профиль
    «Компьютеры и оргтехника (Москва)» давал 0 из 173. Откат касается только
    профиля, применённого лентой самостоятельно: фильтры, заданные человеком,
    не трогаем — пустая выдача там его собственный осознанный результат.
  */
  useEffect(() => {
    if (appliedProfileName === null || loading || page.total > 0) return;
    setEmptyProfileName(appliedProfileName);
    setAppliedProfileName(null);
    setFilters({ ...defaultFilters });
  }, [appliedProfileName, loading, page.total]);

  /*
    Заполнен ли профиль настолько, чтобы соответствие что-то означало. Читаем
    один раз при монтировании: профиль правят на другом экране, и между
    переходами компонент пересоздаётся.
  */
  const [subjectKnown, setSubjectKnown] = useState(true);
  useEffect(() => {
    setSubjectKnown(profileDescribesSubject(companyProfileRepository.get()));
  }, []);

  const chips = useMemo(() => activeFilterChips(filters), [filters]);

  /*
    Сводка по отфильтрованной выдаче: сколько закупок каждого вердикта и
    сколько закрывается в ближайшие сутки.

    Считается по всем найденным, а не по видимой странице: «рекомендовано 12»
    на первой странице и «рекомендовано 3» на второй читалось бы как сбой.
    Смысл полосы — сразу ответить «есть ли тут вообще что брать», не листая
    таблицу.
  */
  const summary = useMemo(() => {
    let recommended = 0;
    let manual = 0;
    let rejected = 0;
    let urgent = 0;
    for (const hit of hits) {
      const verdict = hit.row.analysis.verdict;
      if (verdict === "RECOMMENDED") recommended += 1;
      else if (verdict === "MANUAL_REVIEW") manual += 1;
      else rejected += 1;
      if (isCriticalDeadline(hit.row.tender.deadlines.submissionEnd)) urgent += 1;
    }
    return { recommended, manual, rejected, urgent };
  }, [hits]);

  const onSort = (field: SortField) =>
    setFilters((f) => ({
      ...f,
      sortField: field,
      // Сравниваем с выводимым полем, а не с хранимым: стрелка в заголовке
      // нарисована по нему, и клик по ней обязан менять направление.
      sortDir: field === effectiveSortField && f.sortDir === "desc" ? "asc" : "desc",
      page: 1,
    }));

  const applyProfile = (id: string) => {
    const sp = searchProfiles.find((p) => p.id === id);
    if (!sp) return;
    setAppliedProfileName(sp.name);
    setFilters((f) => ({ ...f, ...filtersFromSearchProfile(sp) }));
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">
            Закупки
          </h1>
          <p className="muted mt-1">
            {loading
              ? "Загрузка…"
              : `Найдено ${page.total} из ${rows.length} — ${sortExplanations[effectiveSortField]}`}
          </p>
        </div>
        {/*
          Вход на страницу своей закупки: из меню она убрана (это не ежедневное
          действие), но остаться недостижимой не может — иначе добавленные
          вручную закупки нечем пополнить.
        */}
        <Link
          href="/tenders/import"
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-accent-strong px-[18px] py-2.5 text-sm font-medium text-white shadow-[0_1px_2px_rgb(28_25_23_/_0.12)] transition-colors hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent/35 focus:ring-offset-1"
        >
          <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
          Добавить свою
        </Link>
      </div>

      {/* Сводка по выдаче: что вообще лежит за текущими фильтрами. */}
      <StatStrip>
        <Stat
          label="Рекомендовано"
          value={summary.recommended}
          hint="можно подавать"
        />
        <Stat
          label="Нужна проверка"
          value={summary.manual}
          hint="решает человек"
        />
        <Stat label="Не подходит" value={summary.rejected} hint="есть блокеры" />
        <Stat
          label="Закрывается < 24 ч"
          value={summary.urgent}
          hint="из найденных"
          delta={summary.urgent > 0 ? "срочно" : undefined}
          deltaTone={summary.urgent > 0 ? "down" : "neutral"}
        />
      </StatStrip>

      <LawSwitcher
        selected={filters.laws}
        counts={lawCounts}
        laws={lawOptions}
        onChange={(laws) => patch({ laws, page: 1 })}
      />

      {/*
        Лента применила профиль поиска сама — об этом надо сказать прямо.
        Иначе короткий список выглядит как «закупок нет», хотя на самом деле
        действует настройка из раздела «Что ищем».
      */}
      {/*
        Профиль не заполнен — сортировка по соответствию ничего не значит.

        Молчать об этом нельзя: список выглядит ранжированным, и человек
        читает верхние строки как «самое подходящее мне», хотя подбору не с чем
        сравнивать. Раньше вопрос не возникал — анкета открывалась заполненной
        вымышленной компанией, и соответствие считалось её, а не вашему.
      */}
      {!subjectKnown && (
        <p className="muted">
          Профиль компании пока пуст, поэтому соответствие не считается — лента
          показана целиком, по свежести.{" "}
          <Link href="/settings/profile" className="text-accent-fg hover:underline">
            Заполнить профиль
          </Link>
        </p>
      )}

      {appliedProfileName !== null && chips.length > 0 && (
        <p className="muted">
          Показаны закупки по профилю «{appliedProfileName}».{" "}
          <button
            type="button"
            className="text-accent-fg hover:underline"
            onClick={() => {
              setAppliedProfileName(null);
              setFilters({ ...defaultFilters });
            }}
          >
            Показать все
          </button>
        </p>
      )}

      {emptyProfileName !== null && (
        <p className="muted">
          По профилю «{emptyProfileName}» сейчас нет ни одной закупки — показана вся
          лента.{" "}
          <Link href="/settings/search" className="text-accent-fg hover:underline">
            Изменить условия поиска
          </Link>
        </p>
      )}

      {/* Применённые ограничения видны даже при свёрнутой панели: без них
          список молча урезан и причина не видна. */}
      {chips.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="list"
          aria-label="Применённые фильтры"
        >
          {chips.map((chip) => (
            <span
              key={chip.id}
              role="listitem"
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-[13px] text-muted-foreground shadow-card"
            >
              <span className="truncate">{chip.label}</span>
              <button
                type="button"
                className="shrink-0 text-faint hover:text-foreground"
                aria-label={`Снять фильтр: ${chip.label}`}
                onClick={() => patch(chip.reset)}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
          {chips.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFilters({ ...defaultFilters, laws: filters.laws })}
            >
              Сбросить всё
            </Button>
          )}
        </div>
      )}

      <TenderFiltersPanel
        filters={filters}
        onChange={patch}
        regions={regions}
        sources={sources}
        searchProfiles={searchProfiles.map((p) => ({ id: p.id, name: p.name }))}
        onApplyProfile={applyProfile}
      />

      {loading ? (
        <LoadingSkeleton rows={8} />
      ) : page.items.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Ничего не найдено"
            description={
              // При запросе объясняем, что именно не нашлось и что можно
              // ослабить: пустая выдача без причины выглядит как поломка.
              textQuery !== null
                ? searchEmptyLabel
                : "Измените условия поиска или сбросьте фильтры."
            }
          />
        </div>
      ) : (
        <TenderTable
          rows={pageRows}
          sortField={effectiveSortField}
          sortDir={filters.sortDir}
          onSort={onSort}
          searchInfo={searchInfo}
          freshnessInfo={freshnessInfo}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Размер страницы рядом со страницами: «мало строк на странице»
                  и «много страниц» — одна и та же жалоба, и чинятся они здесь. */}
              <label className="flex items-center gap-2 text-[14.5px] text-muted-foreground">
                Показывать по
                <select
                  className="num rounded-full border border-border bg-panel px-2.5 py-1 text-[14.5px] text-foreground focus:outline-none focus:ring-2 focus:ring-accent/25"
                  value={filters.pageSize}
                  onChange={(e) =>
                    patch({ pageSize: Number(e.target.value), page: 1 })
                  }
                  aria-label="Закупок на странице"
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center gap-2">
                <p className="num text-[14.5px] text-muted-foreground">
                  {page.page} / {page.totalPages}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page.page <= 1}
                  onClick={() => patch({ page: page.page - 1 })}
                >
                  Назад
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page.page >= page.totalPages}
                  onClick={() => patch({ page: page.page + 1 })}
                >
                  Вперёд
                </Button>
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}
