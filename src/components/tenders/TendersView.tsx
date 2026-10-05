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
  limitsFromProfile,
  profileNarrowing,
  searchWordsFromProfile,
} from "@/domain/searchProfileFilters";
import { profileDescribesSubject } from "@/domain/emptyCompanyProfile";
import type { RerankVerdict } from "@/domain/searchAssist";
import { searchAssistApiService } from "@/services/searchAssistApiService";
import { QuickProfileCard } from "@/components/tenders/QuickProfileCard";
import { SearchAssistBar } from "@/components/tenders/SearchAssistBar";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { activeFilterChips } from "@/lib/filterChips";
import type { TenderVerdict } from "@/domain/enums";
import { cn } from "@/lib/cn";
import { searchEmptyLabel, verdictLabels } from "@/lib/labels";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { demandReporter } from "@/services/demandReporter";
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
  fitScore: "сначала самые подходящие вашей компании",
  price: "отсортировано по НМЦК",
  submissionEnd: "отсортировано по сроку подачи",
  subject: "отсортировано по названию",
  analyzedAt: "отсортировано по дате разбора",
};

const SHOW_ALL_KEY = "tenderfit.feedShowAll";

/** Сколько ждём поиск на площадках после первого профиля: столько он и длится в худшем случае. */
const FIRST_SEARCH_WAIT_MS = 8 * 60_000;

export function TendersView() {
  const { rows, loading, error, reload } = useTenderData();
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [searchProfiles, setSearchProfiles] = useState<SearchProfile[]>([]);
  /*
    Вся общая база — только по явной просьбе. Без своего профиля человек видел
    закупки, собранные под чужие профили (у владельца — стройка в Бурятии):
    база общая, а лента должна быть его. Выбор живёт до закрытия вкладки.
  */
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    try {
      setShowAll(sessionStorage.getItem(SHOW_ALL_KEY) === "1");
    } catch {
      // Память вкладки недоступна — спросим снова.
    }
  }, []);
  /** Что сейчас с поиском на площадках, запущенным из «Что вы ищете?». */
  const [firstSearch, setFirstSearch] = useState<string | null>(null);
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
    const all = searchProfileRepository.getAll();
    const enabled = all.filter((p) => p.enabled);
    setSearchProfiles(enabled);
    // Сервер собирает закупки по темам посетителей: сообщаем свои (без ожидания).
    void demandReporter.report(all);
    const params = new URLSearchParams(window.location.search);
    const fromUrl = filtersFromSearchParams(params);
    /*
      Профиль поиска применяется всегда и сразу. Раньше любой параметр в адресе
      отключал его, и вкладка со старым адресом (прежний набор слов, закон)
      показывала всю базу по России вместо закупок регионов человека — даже
      после обновления страницы (замечание 05.10.2026).

      Исключение одно: в адресе свой запрос (`q`) — это ссылка на конкретный
      поиск или поиск, который человек набрал сам; она открывается как есть.
      Из остального адреса берутся только порядок и страница: условия отбора
      задаёт профиль, а не устаревшая ссылка.
    */
    const auto = autoAppliedProfile(enabled);
    if (auto && fromUrl.search.trim() === "") {
      setFilters({
        ...defaultFilters,
        sortField: fromUrl.sortField,
        sortDir: fromUrl.sortDir,
        page: fromUrl.page,
        pageSize: fromUrl.pageSize,
        ...searchWordsFromProfile(auto),
      });
      setAppliedProfileName(auto.name);
    } else {
      setFilters(fromUrl);
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
  /*
    Оценки модели по смыслу. Живут только пока не изменился запрос: выдача
    поменялась, и оценки относились бы к другим закупкам.
  */
  const [verdicts, setVerdicts] = useState<Record<string, RerankVerdict> | null>(null);
  const [hideModelNo, setHideModelNo] = useState(false);
  const queryKey = `${filters.search}␟${filters.searchKeywords.join("␞")}`;
  useEffect(() => {
    setVerdicts(null);
    setHideModelNo(false);
  }, [queryKey]);

  /*
    Заполнен ли профиль настолько, чтобы соответствие что-то означало. Читаем
    один раз при монтировании: профиль правят на другом экране, и между
    переходами компонент пересоздаётся.
  */
  const [subjectKnown, setSubjectKnown] = useState(true);
  /** Приоритетные регионы компании: где искать, если человек регион не задал. */
  const [priorityRegions, setPriorityRegions] = useState<string[]>([]);
  /** О чём компания, коротко: модели нужно понимать, «подходит ли это нам». */
  const [companyNote, setCompanyNote] = useState("");
  useEffect(() => {
    const profile = companyProfileRepository.get();
    setSubjectKnown(profileDescribesSubject(profile));
    setPriorityRegions(profile.preferences.priorityRegions.filter((r) => r.trim() !== ""));
    setCompanyNote(
      (profile.activityDescription.trim() !== ""
        ? profile.activityDescription
        : profile.capabilities.products.slice(0, 12).join(", ")
      ).slice(0, 400),
    );
  }, []);

  const allHits = useMemo(() => searchRows(rows, filters), [rows, filters]);
  const foundHits = useMemo(
    () =>
      hideModelNo && verdicts !== null
        ? allHits.filter((hit) => verdicts[hit.row.tender.id]?.fit !== "no")
        : allHits,
    [allHits, hideModelNo, verdicts],
  );

  /*
    Второй шаг: исключить найденное по профилю. Первый слой нашёл всё по словам,
    по всей России; теперь из найденного убирается то, что не подходит под
    условия профиля поиска (регион, цена, заказчики) и под профиль компании
    (оценка «Не подходит»: регион вне географии работы, цена вне диапазона,
    нет лицензий). Скрытое не пропадает молча: число названо над таблицей, а
    «Показать скрытые» возвращает его в выдачу.
  */
  const [showExcluded, setShowExcluded] = useState(false);
  const appliedProfile = searchProfiles.find((p) => p.name === appliedProfileName) ?? null;
  const profileLimitIds = useMemo(() => {
    if (appliedProfile === null || profileNarrowing(appliedProfile).length === 0) return null;
    return new Set(
      searchRows(rows, { ...filters, ...limitsFromProfile(appliedProfile) }).map((hit) => hit.row.tender.id),
    );
  }, [rows, filters, appliedProfile]);
  const excluded = useMemo(() => {
    const byLimits = new Set<string>();
    const byFit = new Set<string>();
    for (const hit of foundHits) {
      const id = hit.row.tender.id;
      if (profileLimitIds !== null && !profileLimitIds.has(id)) {
        byLimits.add(id);
      } else if (
        subjectKnown &&
        filters.verdict === "ALL" &&
        hit.row.analysis.verdict === "NOT_RECOMMENDED"
      ) {
        byFit.add(id);
      }
    }
    return { byLimits, byFit, total: byLimits.size + byFit.size };
  }, [foundHits, profileLimitIds, subjectKnown, filters.verdict]);
  const hits = useMemo(
    () =>
      showExcluded
        ? foundHits
        : foundHits.filter(
            (hit) =>
              !excluded.byLimits.has(hit.row.tender.id) &&
              !excluded.byFit.has(hit.row.tender.id),
          ),
    [foundHits, showExcluded, excluded],
  );

  /*
    Второй слой выдачи. Первый нашёл всё по словам; здесь видно, как оценка
    по профилю компании делит найденное. Счёт идёт по выдаче без фильтра по
    оценке: иначе выбранная кнопка показывала бы нули у соседних.
  */
  const verdictCounts = useMemo(() => {
    const counts: Record<TenderVerdict, number> = { RECOMMENDED: 0, MANUAL_REVIEW: 0, NOT_RECOMMENDED: 0 };
    for (const hit of searchRows(rows, { ...filters, verdict: "ALL" })) {
      // Вне региона и цены профиля поиска — не считаем, пока они скрыты: иначе
      // счётчики говорили о 329 закупках при 26 показанных.
      if (!showExcluded && profileLimitIds !== null && !profileLimitIds.has(hit.row.tender.id)) continue;
      counts[hit.row.analysis.verdict] = (counts[hit.row.analysis.verdict] ?? 0) + 1;
    }
    return counts;
  }, [rows, filters, showExcluded, profileLimitIds]);

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

    По умолчанию — Fit Score: выдача уже отобрана по словам запроса, и внутри
    неё первыми идут закупки, которые лучше всего подходят компании (регион,
    цена, лицензии, опыт). Совпадение слов решает, попала ли закупка в
    выдачу, а не её место в ней: первый слой находит, второй — ранжирует.
    Осознанный выбор пользователя (цена, срок, название, свежесть) не
    перебивается. «По релевантности» без запроса бессмысленна и читается как
    Fit Score; «по свежести» при запросе читается как релевантность, потому
    что свежесть партии про запрос ничего не знает.

    Держать это в состоянии означало бы помнить, кто и когда переключил поле:
    снятие чипа поиска, применение профиля и «Сбросить» оставляли бы сортировку
    «по релевантности» при пустом запросе, и стрелка указывала бы на колонку,
    которой в таблице уже нет.
  */
  const effectiveSortField: SortField =
    filters.sortField === "freshness" && textQuery !== null
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

  /** Первые закупки выдачи для проверки моделью: токены растут линейно. */
  const assistCandidates = useMemo(
    () =>
      sorted.slice(0, 30).map((hit) => ({
        id: hit.row.tender.id,
        subject: hit.row.tender.subject,
        customer: hit.row.tender.customerName,
      })),
    [sorted],
  );

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

  /*
    Где искать на площадках. Первым берётся регион, который человек задал в
    ленте; нет — регионы применённого профиля поиска; нет — приоритетные
    регионы компании. Без региона поиск идёт по всей России, и по небольшому
    региону находились единицы (разбор 05.10.2026).
  */
  const liveRegions = useMemo(() => {
    const fromFilters = [filters.region, ...filters.regions].filter((r) => r.trim() !== "");
    if (fromFilters.length > 0) return fromFilters;
    if (appliedProfile !== null && appliedProfile.regions.length > 0) return appliedProfile.regions;
    return priorityRegions;
  }, [filters.region, filters.regions, appliedProfile, priorityRegions]);

  // Своего профиля нет, человек ничего не искал и не выбирал — спрашиваем, что он ищет.
  const needsProfile =
    !showAll &&
    textQuery === null &&
    chips.length === 0 &&
    !searchProfiles.some((p) => p.keywords.length > 0);

  /** Дождаться поиска на площадках, запущенного из «Что вы ищете?», и перечитать ленту. */
  const waitForFirstSearch = async (jobId: string): Promise<void> => {
    const until = Date.now() + FIRST_SEARCH_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      try {
        const state = await searchAssistApiService.liveStatus(jobId);
        if (state.status === "completed" || state.failed) {
          setFirstSearch(
            state.failed
              ? "Поиск на площадках не удался. Ваши закупки соберутся при ближайшем плановом сборе."
              : null,
          );
          await reload();
          return;
        }
      } catch {
        // Сбой опроса — пробуем ещё раз до конца ожидания.
      }
    }
    setFirstSearch(null);
    await reload();
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
          {!loading && textQuery === null && (
            <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Порядок выдачи">
              <span className="text-[13.5px] text-faint">Порядок:</span>
              {(
                [
                  { field: "fitScore", label: "Самые подходящие" },
                  { field: "freshness", label: "Сначала новые" },
                ] as const
              ).map(({ field, label }) => {
                const active = effectiveSortField === field;
                return (
                  <button
                    key={field}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilters((f) => ({ ...f, sortField: field, sortDir: "desc", page: 1 }))}
                    className={cn(
                      "rounded-full border px-3 py-1 text-[13.5px] transition-colors",
                      active
                        ? "border-accent-line bg-accent-subtle text-accent-fg"
                        : "border-border bg-panel text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {!loading && (
            <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Оценка по профилю компании">
              <span className="text-[13.5px] text-faint">По профилю компании:</span>
              {(["RECOMMENDED", "MANUAL_REVIEW", "NOT_RECOMMENDED"] as const).map((v) => {
                const active = filters.verdict === v;
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilters((f) => ({ ...f, verdict: active ? "ALL" : v, page: 1 }))}
                    className={cn(
                      "rounded-full border px-3 py-1 text-[13.5px] transition-colors",
                      active
                        ? "border-accent-line bg-accent-subtle text-accent-fg"
                        : "border-border bg-panel text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {verdictLabels[v]}: {verdictCounts[v]}
                  </button>
                );
              })}
            </div>
          )}
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
          показана целиком.{" "}
          <Link href="/settings/profile" className="text-accent-fg hover:underline">
            Заполнить профиль
          </Link>
        </p>
      )}

      {appliedProfileName !== null && chips.length > 0 && (
        <p className="muted">
          Показаны закупки по словам профиля «{appliedProfileName}» — найдено по всей России.{" "}
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

      {excluded.total > 0 && (
        <p className="muted" role="status">
          {showExcluded
            ? `Показаны и скрытые закупки (${excluded.total}).`
            : `Скрыто как не подходящее: ${excluded.total}`}
          {excluded.byLimits.size > 0 &&
            appliedProfile !== null &&
            ` — ${excluded.byLimits.size} вне условий профиля поиска (${profileNarrowing(appliedProfile).join("; ")})`}
          {excluded.byFit.size > 0 &&
            ` — ${excluded.byFit.size} не подходят по профилю компании (регион, цена, лицензии)`}
          .{" "}
          <button
            type="button"
            className="text-accent-fg hover:underline"
            onClick={() => setShowExcluded((v) => !v)}
          >
            {showExcluded ? "Скрыть" : "Показать скрытые"}
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

      <SearchAssistBar
        regions={liveRegions}
        query={filters.search}
        keywords={filters.searchKeywords}
        candidates={assistCandidates}
        companyNote={companyNote}
        verdicts={verdicts}
        hideNo={hideModelNo}
        onAddKeywords={(terms) =>
          patch({ searchKeywords: [...filters.searchKeywords, ...terms], page: 1 })
        }
        onVerdicts={setVerdicts}
        onHideNo={setHideModelNo}
        // Живой поиск дописал закупки в базу: лента перечитывает её целиком.
        onLiveDone={() => void reload()}
      />

      {firstSearch !== null && (
        <p className="muted" role="status">
          {firstSearch}
        </p>
      )}

      {loading ? (
        <LoadingSkeleton rows={8} />
      ) : needsProfile ? (
        <QuickProfileCard
          onShowAll={() => {
            setShowAll(true);
            try {
              sessionStorage.setItem(SHOW_ALL_KEY, "1");
            } catch {
              // Без памяти вкладки выбор продержится до перезагрузки.
            }
          }}
          onSaved={(profile, outcome) => {
            setSearchProfiles((prev) => [...prev, profile]);
            setAppliedProfileName(profile.name);
            setFilters((f) => ({ ...f, ...searchWordsFromProfile(profile) }));
            if (outcome.jobId === null) {
              setFirstSearch(outcome.problem);
              return;
            }
            setFirstSearch("Ищу ваши закупки на площадках — лента обновится сама, обычно за пару минут.");
            void waitForFirstSearch(outcome.jobId);
          }}
        />
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
          modelNotes={verdicts}
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
