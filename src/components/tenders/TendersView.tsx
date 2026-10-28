"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
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
  selectedRegions,
  sortSearched,
  unknownRegionRows,
} from "@/domain/filtering";
import { freshnessContextOf, groupByFreshness } from "@/domain/lastSearch";
import {
  filtersFromSearchParams,
  filtersToSearchParams,
} from "@/domain/filterUrl";
import {
  buildSnippetCorpus,
  snippetForMatch,
  snippetIsRedundant,
} from "@/domain/textSearch";
import {
  autoAppliedProfile,
  filtersFromSearchProfile,
  limitsFromProfile,
  profileNarrowing,
  searchWordsFromProfile,
} from "@/domain/searchProfileFilters";
import { profileDescribesSubject } from "@/domain/emptyCompanyProfile";
import {
  hiddenReasonsText,
  nonContractReason,
  profileIsContractor,
  worksIntent,
  type NonContractNature,
} from "@/domain/procurementNature";
import type { RerankVerdict } from "@/domain/searchAssist";
import { searchAssistApiService } from "@/services/searchAssistApiService";
import { QuickProfileCard } from "@/components/tenders/QuickProfileCard";
import { RegionSearchStatus } from "@/components/tenders/RegionSearchStatus";
import { SearchAssistBar } from "@/components/tenders/SearchAssistBar";
import { LastSearchBanner } from "@/components/tenders/LastSearchBanner";
import {
  clearSearchMarker,
  loadSearchMarker,
  rowsFromSearch,
  rowsNewSince,
  saveSearchMarker,
  takeFeedSeen,
  type SearchMarker,
} from "@/domain/searchMarker";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { activeFilterChips } from "@/lib/filterChips";
import { cn } from "@/lib/cn";
import { searchEmptyLabel } from "@/lib/labels";
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
  Collapsible,
  ErrorState,
  LoadingSkeleton,
} from "@/components/ui/primitives";
import { ProductTour } from "@/components/tour/ProductTour";
import { takePendingFirstSearch } from "@/domain/pendingFirstSearch";
import { STORAGE_KEYS, readJSON, writeJSON } from "@/lib/storage";
import { accountSync } from "@/services/accountSync";
import {
  NewTendersButton,
  NewTendersStatus,
  useTendersSearch,
} from "@/components/dashboard/NewTendersSearch";

const SHOW_ALL_KEY = "tenderfit.feedShowAll";

/** Сколько ждём поиск на площадках после первого профиля: столько он и длится в худшем случае. */
const FIRST_SEARCH_WAIT_MS = 8 * 60_000;

/** Закупку отклонил только регион вне географии компании, других блокеров нет. */
function onlyRegionBlocks(row: {
  analysis: { hardBlockers: { id: string }[] };
}): boolean {
  const blockers = row.analysis.hardBlockers;
  return (
    blockers.length > 0 && blockers.every((b) => b.id.endsWith("-block-region"))
  );
}

/** Сколько скрыто закупок каждой «не подрядной» природы. */
function natureCounts(byNature: ReadonlyMap<string, NonContractNature>): Partial<Record<NonContractNature, number>> {
  const counts: Partial<Record<NonContractNature, number>> = {};
  for (const nature of byNature.values()) counts[nature] = (counts[nature] ?? 0) + 1;
  return counts;
}

export function TendersView() {
  const { rows, loading, error, reload } = useTenderData();
  /*
    Последний поиск на площадках (живой, первый по профилю, «Найти новые
    закупки»): его результат показывается сразу, первым и без отсеиваний по
    профилю. Раньше найденное пряталось как «вне профиля», и увидеть его можно
    было только через «Расширенный поиск» → «Показать скрытые» (12.10.2026).
  */
  const [searchMarker, setSearchMarker] = useState<SearchMarker | null>(null);
  const [onlySearch, setOnlySearch] = useState(false);
  /** Прошлый визит в ленту: всё, что появилось в базе позже, — новое для человека. */
  const [feedSeen, setFeedSeen] = useState<string | null>(null);
  useEffect(() => {
    setSearchMarker(loadSearchMarker());
    setFeedSeen(takeFeedSeen());
  }, []);
  /** Поиск, запущенный «Быстрым стартом» до перехода сюда: лента досматривает его сама. */
  const [pendingFirst] = useState(() => (typeof window === "undefined" ? null : takePendingFirstSearch()));
  /*
    Тур по продукту: после быстрого старта (`?tour=1`) один раз, по ссылке «Как пользоваться»
    (`&force=1`) — всегда. Открывается, когда лента загрузилась: иначе вырезать нечего.
  */
  const [tourOpen, setTourOpen] = useState(false);
  const [tourRequested] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get("tour") !== "1") return false;
    return params.get("force") === "1" || !readJSON<boolean>(STORAGE_KEYS.tourDone, false);
  });
  const closeTour = (): void => {
    setTourOpen(false);
    writeJSON(STORAGE_KEYS.tourDone, true);
    void accountSync.pushIfSignedIn();
    const params = new URLSearchParams(window.location.search);
    params.delete("tour");
    params.delete("force");
    const query = params.toString();
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };
  const markSearch = (marker: SearchMarker): SearchMarker => {
    const withSeen = feedSeen !== null && marker.seenBefore === undefined ? { ...marker, seenBefore: feedSeen } : marker;
    saveSearchMarker(withSeen);
    setSearchMarker(withSeen);
    setOnlySearch(false);
    setFilters((f) => ({ ...f, page: 1 }));
    return withSeen;
  };
  /*
    Поиск закончился: перечитать базу и, если есть новое для человека, сразу показать
    только его. Иначе первые строки ленты — старые подходящие закупки, и новое
    приходилось выискивать, пролистывая (замечание владельца 15.10.2026).
  */
  const finishSearch = async (marker: SearchMarker): Promise<void> => {
    const applied = markSearch(marker);
    const fresh = await reload();
    setOnlySearch(rowsFromSearch(fresh, applied).fresh.length > 0);
  };
  const dismissSearch = (): void => {
    clearSearchMarker();
    setSearchMarker(null);
    setOnlySearch(false);
  };
  /** Начало живого поиска: по нему потом отличаем принесённые им строки. */
  const liveStart = useRef<{ startedAt: string; query: string } | null>(null);
  /** Начало первого поиска по профилю из «Что вы ищете?». */
  const firstStart = useRef<{ startedAt: string; queries: string[] } | null>(null);
  const search = useTendersSearch(({ startedAt }) => {
    void finishSearch({ kind: "full", startedAt, queries: [] });
  });
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
  /*
    Поиск на площадках идёт прямо сейчас. Не то же самое, что firstSearch !== null:
    там же лежит и текст сбоя, а при сбое «ищем ещё» было бы неправдой.
  */
  const [firstSearchRunning, setFirstSearchRunning] = useState(false);
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
  const [appliedProfileName, setAppliedProfileName] = useState<string | null>(
    null,
  );
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
  const [verdicts, setVerdicts] = useState<Record<
    string,
    RerankVerdict
  > | null>(null);
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
  /** Подрядчик ли компания: от этого зависит, прячем ли покупку квартир и мониторинг цен. */
  const [contractor, setContractor] = useState(false);
  /** Приоритетные регионы компании: где искать, если человек регион не задал. */
  const [priorityRegions, setPriorityRegions] = useState<string[]>([]);
  /** О чём компания, коротко: модели нужно понимать, «подходит ли это нам». */
  const [companyNote, setCompanyNote] = useState("");
  useEffect(() => {
    const profile = companyProfileRepository.get();
    setSubjectKnown(profileDescribesSubject(profile));
    setContractor(profileIsContractor(profile));
    setPriorityRegions(
      profile.preferences.priorityRegions.filter((r) => r.trim() !== ""),
    );
    setCompanyNote(
      (profile.activityDescription.trim() !== ""
        ? profile.activityDescription
        : profile.capabilities.products.slice(0, 12).join(", ")
      ).slice(0, 400),
    );
  }, []);

  const chosenRegions = useMemo(() => selectedRegions(filters), [filters]);
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
  /** Строки последнего поиска: новые (появились после его начала) и найденные тем же запросом. */
  const searchResult = useMemo(
    () => (searchMarker === null ? null : rowsFromSearch(rows, searchMarker)),
    [rows, searchMarker],
  );
  const searchIds = useMemo(() => {
    const ids = new Set<string>();
    if (searchResult !== null) {
      for (const row of [...searchResult.fresh, ...searchResult.known]) ids.add(row.tender.id);
    }
    return ids;
  }, [searchResult]);
  const freshSearchIds = useMemo(
    () => new Set((searchResult?.fresh ?? []).map((row) => row.tender.id)),
    [searchResult],
  );
  const appliedProfile =
    searchProfiles.find((p) => p.name === appliedProfileName) ?? null;
  const profileLimitIds = useMemo(() => {
    if (
      appliedProfile === null ||
      profileNarrowing(appliedProfile).length === 0
    )
      return null;
    return new Set(
      searchRows(rows, {
        ...filters,
        ...limitsFromProfile(appliedProfile),
      }).map((hit) => hit.row.tender.id),
    );
  }, [rows, filters, appliedProfile]);
  /*
    Слова, по которым человек ищет: строка поиска и ключевые слова профиля. По
    ним решается, лента ли это про подряд и просил ли человек сам квартиры или
    мониторинг цен (тогда они не прячутся).
  */
  const queryWords = useMemo(
    () => [filters.search, ...filters.searchKeywords].filter((w) => w.trim() !== ""),
    [filters.search, filters.searchKeywords],
  );
  const excluded = useMemo(() => {
    const byLimits = new Set<string>();
    const byFit = new Set<string>();
    /*
      Не подряд: покупка квартир у застройщика, мониторинг цен. Замер 14.10.2026
      на ленте владельца: 76 из 115 показанных закупок — квартиры; они совпали
      по слову «долевом строительстве», а подрядчик в них участвовать не может.
    */
    const byNature = new Map<string, NonContractNature>();
    /** Строки последнего поиска, которые обычные правила спрятали бы: показываем с пометкой. */
    const notes = new Map<string, string>();
    for (const hit of foundHits) {
      const id = hit.row.tender.id;
      const fromSearch = searchIds.has(id);
      if (profileLimitIds !== null && !profileLimitIds.has(id)) {
        if (fromSearch) {
          notes.set(
            id,
            `Из последнего поиска · вне профиля поиска${appliedProfile !== null ? ` «${appliedProfile.name}»` : ""}`,
          );
        } else byLimits.add(id);
        continue;
      }
      const nonContract = nonContractReason(hit.row.tender, { words: queryWords, contractor });
      if (nonContract !== null) {
        // И для найденного последним поиском: квартира не становится подрядом оттого,
        // что её нашли сегодня.
        byNature.set(id, nonContract);
      } else if (
        subjectKnown &&
        filters.verdict === "ALL" &&
        hit.row.analysis.verdict === "NOT_RECOMMENDED" &&
        // Регион человек выбрал в ленте сам: «регион вне географии работы» из
        // профиля компании не должен прятать то, что он прямо попросил.
        !(chosenRegions.length > 0 && onlyRegionBlocks(hit.row))
      ) {
        if (fromSearch) {
          notes.set(id, "Из последнего поиска · по профилю компании оценена как «Не подходит»");
        } else byFit.add(id);
      }
    }
    return { byLimits, byFit, byNature, notes, total: byLimits.size + byFit.size + byNature.size };
  }, [
    foundHits,
    profileLimitIds,
    queryWords,
    contractor,
    subjectKnown,
    filters.verdict,
    chosenRegions,
    searchIds,
    appliedProfile,
  ]);
  /*
    «Показать только их»: выдача — строки последнего поиска без слов и профиля
    ленты, иначе часть найденного (отобранного по смыслу) снова пропала бы.

    Регион и природа закупки при этом соблюдаются. Регион человек выбрал сам, и
    поиск, пришедший по всей России, не вправе выдавать ему Москву поверх Бурятии;
    покупка квартир и мониторинг цен — не подряд, сколько бы раз их ни нашли.
    Замечание тестировщика 23.10.2026: «Новые для вас: 268» показывали Москву и
    «Приобретение жилого помещения» с оценкой «Подходит 83».
  */
  const searchOnlyHits = useMemo(
    () =>
      searchResult === null
        ? []
        : searchRows([...searchResult.fresh, ...searchResult.known], {
            ...defaultFilters,
            region: filters.region,
            regions: filters.regions,
          }).filter((hit) => nonContractReason(hit.row.tender, { words: queryWords, contractor }) === null),
    [searchResult, filters.region, filters.regions, queryWords, contractor],
  );
  /*
    Строки последнего поиска, которые фильтры ленты (регион и слова профиля,
    закон, цена) отсекли бы ещё до «скрытых»: живой поиск смотрит по всей
    России. В обычной выдаче они всё равно стоят первыми — с пометкой.
  */
  const searchOutsideFilters = useMemo(() => {
    if (searchMarker === null || onlySearch) return [];
    const found = new Set(foundHits.map((hit) => hit.row.tender.id));
    return searchOnlyHits.filter((hit) => !found.has(hit.row.tender.id));
  }, [searchMarker, onlySearch, foundHits, searchOnlyHits]);
  const rowNotes = useMemo(() => {
    const notes = new Map(excluded.notes);
    for (const hit of searchOutsideFilters) {
      notes.set(hit.row.tender.id, "Из последнего поиска · не подходит под фильтры ленты");
    }
    if (onlySearch && searchResult !== null) {
      for (const row of searchResult.known) {
        if (!notes.has(row.tender.id)) notes.set(row.tender.id, "Найдена тем же запросом · была в ленте раньше");
      }
    }
    return notes;
  }, [excluded.notes, searchOutsideFilters, onlySearch, searchResult]);
  /** «Новая» у строки: появилась после прошлого визита или в последнем поиске. */
  const newIds = useMemo(() => {
    const ids = rowsNewSince(rows, feedSeen === null ? null : Date.parse(feedSeen));
    for (const id of freshSearchIds) ids.add(id);
    return ids;
  }, [rows, feedSeen, freshSearchIds]);
  const hits = useMemo(
    () =>
      onlySearch && searchMarker !== null
        ? searchOnlyHits
        : [
            ...searchOutsideFilters,
            ...(showExcluded
              ? foundHits
              : foundHits.filter(
                  (hit) =>
                    !excluded.byLimits.has(hit.row.tender.id) &&
                    !excluded.byNature.has(hit.row.tender.id) &&
                    !excluded.byFit.has(hit.row.tender.id),
                )),
          ],
    [foundHits, showExcluded, excluded, onlySearch, searchMarker, searchOnlyHits, searchOutsideFilters],
  );

  // Счётчики переключателя закона: сколько закупок даст каждый закон при
  // остальных текущих фильтрах. Сам закон в расчёте не участвует — иначе
  // переключатель показывал бы нули у соседних законов и переставал бы быть подсказкой.
  const lawCounts = useMemo(
    () => countRowsByLaw(rows, filters),
    [rows, filters],
  );

  // Показываем законы, которые есть в данных, плюс уже выбранные: спрятать
  // действующий фильтр значило бы рисовать «Все» при работающем ограничении.
  const lawOptions = useMemo<TenderLaw[]>(() => {
    const present = new Set(rows.map((r) => r.tender.law));
    return TENDER_LAWS.filter(
      (law) => present.has(law) || filters.laws.includes(law),
    );
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

  const sorted = useMemo(() => {
    const ordered = sortSearched(hits, effectiveSortField, filters.sortDir, freshness, {
      preferWorks: worksIntent(queryWords, contractor),
    });
    if (searchIds.size === 0) return ordered;
    // Новое из последнего поиска — первым. Найденное тем же запросом, но лежавшее в
    // ленте раньше, поднимается только в виде «только результат поиска»: в общей ленте
    // старые совпадения сверху заслоняли новое. Внутри групп порядок сортировки сохраняется.
    const rank = (hit: (typeof ordered)[number]): number =>
      freshSearchIds.has(hit.row.tender.id) ? 0 : onlySearch && searchIds.has(hit.row.tender.id) ? 1 : 2;
    return ordered
      .map((hit, index) => ({ hit, index }))
      .sort((a, b) => rank(a.hit) - rank(b.hit) || a.index - b.index)
      .map(({ hit }) => hit);
  }, [hits, effectiveSortField, filters.sortDir, freshness, queryWords, contractor, searchIds, freshSearchIds, onlySearch]);
  const page = useMemo(
    () => paginate(sorted, filters.page, filters.pageSize),
    [sorted, filters.page, filters.pageSize],
  );
  const pageRows = useMemo(
    () => page.items.map((hit) => hit.row),
    [page.items],
  );

  /*
    Выбранные регионы и закупки без региона. Источник не всегда указывает
    регион; такие закупки не выдаются за найденные в регионе, но и не
    пропадают — они в отдельном свёрнутом блоке под выдачей.
  */
  const unknownRegion = useMemo(
    () =>
      sortSearched(
        unknownRegionRows(rows, filters),
        effectiveSortField,
        filters.sortDir,
        freshness,
      ).map((hit) => hit.row),
    [rows, filters, effectiveSortField, freshness],
  );
  /** Что искать на площадках, если выбранный регион пуст: запрос или первое слово профиля. */
  const regionQuery =
    filters.search.trim() !== ""
      ? filters.search.trim()
      : (filters.searchKeywords[0] ?? null);

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
      const snippet = snippetForMatch(
        buildSnippetCorpus(row.tender),
        match,
        textQuery.query,
      );
      info.set(row.tender.id, {
        // Совпадение в коротком названии даёт сниппет, равный самому названию:
        // печатать его второй раз — шум, а не подсказка.
        snippet: snippetIsRedundant(snippet, row.tender.subject)
          ? null
          : snippet,
        priority: combined,
        relevanceScore: relevance.score,
        reasons: relevance.reasons.map((reason) => reason.label),
        // Совпадение только в документации помечается отдельно: извещение на
        // двести страниц содержит почти любое слово, и эта разница обязана быть видна.
        documentOnly:
          match.scopes.length === 1 && match.scopes[0] === "documents",
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
    if (
      typing &&
      appliedProfileName !== null &&
      filters.searchKeywords.length > 0
    ) {
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
    // Регион выбран — пустота в нём честный ответ, а не повод показать всю
    // Россию: лента говорит «здесь пока ничего» и ищет на площадках сама.
    if (chosenRegions.length > 0) return;
    setEmptyProfileName(appliedProfileName);
    setAppliedProfileName(null);
    setFilters({ ...defaultFilters });
  }, [appliedProfileName, loading, page.total, chosenRegions.length]);

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

  const onSort = (field: SortField) =>
    setFilters((f) => ({
      ...f,
      sortField: field,
      // Сравниваем с выводимым полем, а не с хранимым: стрелка в заголовке
      // нарисована по нему, и клик по ней обязан менять направление.
      sortDir:
        field === effectiveSortField && f.sortDir === "desc" ? "asc" : "desc",
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
    const fromFilters = [filters.region, ...filters.regions].filter(
      (r) => r.trim() !== "",
    );
    if (fromFilters.length > 0) return fromFilters;
    if (appliedProfile !== null && appliedProfile.regions.length > 0)
      return appliedProfile.regions;
    return priorityRegions;
  }, [filters.region, filters.regions, appliedProfile, priorityRegions]);

  // Своего профиля нет, человек ничего не искал и не выбирал — спрашиваем, что он ищет.
  const needsProfile =
    !showAll &&
    textQuery === null &&
    chips.length === 0 &&
    !searchProfiles.some((p) => p.keywords.length > 0);

  /*
    Слова поиска есть — после «Быстрого старта» человеку сказали «профиль заполните
    потом», и жёсткое «подбор не работает» выглядело бы как ошибка. Слова берём и
    из профилей поиска, и из задания быстрого старта (профили приходят позже ленты).
  */
  const hasSearchWords =
    searchProfiles.some((p) => p.keywords.length > 0) || (pendingFirst?.queries.length ?? 0) > 0;

  /**
    Следить за первым поиском по профилю: из карточки «Что вы ищете?» в ленте или из
    «Быстрого старта» после регистрации (тот запускает поиск и передаёт задание сюда).
  */
  const watchFirstSearch = (first: { jobId: string | null; problem: string | null; queries: string[]; startedAt: string }): void => {
    if (first.jobId === null) {
      setFirstSearch(first.problem);
      return;
    }
    setFirstSearch("Ищу ваши закупки на площадках — лента обновится сама, обычно за пару минут.");
    setFirstSearchRunning(true);
    firstStart.current = { startedAt: first.startedAt, queries: first.queries };
    void waitForFirstSearch(first.jobId);
  };

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
          setFirstSearchRunning(false);
          const started = firstStart.current;
          firstStart.current = null;
          if (!state.failed && started !== null) {
            await finishSearch({ kind: "first", startedAt: started.startedAt, queries: started.queries });
          } else {
            await reload();
          }
          return;
        }
      } catch {
        // Сбой опроса — пробуем ещё раз до конца ожидания.
      }
    }
    setFirstSearch(null);
    setFirstSearchRunning(false);
    await reload();
  };

  const firstPicked = useRef(false);
  useEffect(() => {
    if (loading || pendingFirst === null || firstPicked.current) return;
    firstPicked.current = true;
    watchFirstSearch(pendingFirst);
    // watchFirstSearch пересоздаётся на каждой отрисовке; задание забирается один раз.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, pendingFirst]);
  useEffect(() => {
    if (!loading && tourRequested) setTourOpen(true);
  }, [loading, tourRequested]);

  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">
            Закупки
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <p className="muted">
              {loading
                ? "Загрузка…"
                : firstSearchRunning
                  ? `Найдено ${page.total} · ищем ещё на площадках`
                  : `Найдено ${page.total}`}
            </p>
            {!loading && textQuery === null && (
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Порядок выдачи"
              >
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
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          sortField: field,
                          sortDir: "desc",
                          page: 1,
                        }))
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[13.5px] transition-colors",
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
          </div>
        </div>
        {/* Та же кнопка, что на экране «Сегодня»; ссылка на ручной ввод — под ней. */}
        <NewTendersButton search={search} busy={loading} />
      </div>

      {/* Ход поиска — на всю ширину под шапкой, а не в узкой колонке у кнопки. */}
      <NewTendersStatus search={search} />

      <LawSwitcher
        selected={filters.laws}
        counts={lawCounts}
        laws={lawOptions}
        onChange={(laws) => patch({ laws, page: 1 })}
      />

      {/*
        Профиль не заполнен — сортировка по соответствию ничего не значит.
        Молчать об этом нельзя: список выглядит ранжированным, и человек читает
        верхние строки как «самое подходящее мне», хотя подбору не с чем
        сравнивать.
      */}
      {!subjectKnown && (
        <p className="muted">
          {hasSearchWords
            ? "Лента подобрана по вашему запросу. Чтобы оценка учитывала лицензии, СРО и опыт, заполните профиль компании."
            : "Профиль компании не заполнен — подбор под вас не работает."}{" "}
          <Link
            href="/settings/profile"
            className="text-accent-fg hover:underline"
          >
            Заполнить
          </Link>
        </p>
      )}

      {emptyProfileName !== null && (
        <p className="muted">
          По профилю «{emptyProfileName}» ничего нет — показана вся лента.{" "}
          <Link
            href="/settings/search"
            className="text-accent-fg hover:underline"
          >
            Изменить условия
          </Link>
        </p>
      )}

      {/*
        Профиль, скрытые и применённые ограничения живут внутри «Расширенного
        поиска»: над таблицей они занимали полэкрана. Чтобы урезанный список не
        выглядел беспричинным, ссылка на блок показывает число действующих
        ограничений.
      */}
      <TenderFiltersPanel
        filters={filters}
        onChange={patch}
        sources={sources}
        searchProfiles={searchProfiles.map((p) => ({ id: p.id, name: p.name }))}
        onApplyProfile={applyProfile}
        summaryCount={chips.length}
        summary={
          appliedProfileName !== null ||
          excluded.total > 0 ||
          chips.length > 0 ? (
            <div className="space-y-2">
              {/* Лента применила профиль поиска сама — иначе короткий список выглядит как
              «закупок нет», хотя действует настройка из «Что ищем». */}
              {appliedProfileName !== null && chips.length > 0 && (
                <p className="muted">
                  Профиль «{appliedProfileName}»
                  {chosenRegions.length > 0
                    ? `: ${chosenRegions.join(", ")}`
                    : ": вся Россия"}
                  .{" "}
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
                <p
                  className="muted"
                  role="status"
                  title={
                    excluded.byLimits.size > 0 && appliedProfile !== null
                      ? `Вне условий профиля поиска: ${profileNarrowing(appliedProfile).join("; ")}`
                      : undefined
                  }
                >
                  {showExcluded
                    ? `Показаны и скрытые: ${excluded.total}`
                    : `Скрыто как неподходящее: ${excluded.total}`}
                  {hiddenReasonsText({
                    limits: excluded.byLimits.size,
                    fit: excluded.byFit.size,
                    nature: natureCounts(excluded.byNature),
                  })}
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

              {/* Применённые ограничения — чипами, каждый снимается отдельно. */}
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
                      onClick={() =>
                        setFilters({ ...defaultFilters, laws: filters.laws })
                      }
                    >
                      Сбросить всё
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : null
        }
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
          patch({
            searchKeywords: [...filters.searchKeywords, ...terms],
            page: 1,
          })
        }
        onVerdicts={setVerdicts}
        onHideNo={setHideModelNo}
        onLiveStart={(query) => {
          liveStart.current = { startedAt: new Date().toISOString(), query };
        }}
        // Живой поиск дописал закупки в базу: лента перечитывает её целиком и
        // показывает найденное первым (`LastSearchBanner`).
        onLiveDone={() => {
          const started = liveStart.current;
          liveStart.current = null;
          if (started !== null) {
            void finishSearch({ kind: "live", startedAt: started.startedAt, queries: [started.query] });
          } else {
            void reload();
          }
        }}
      />

      {firstSearch !== null && (
        <p className="muted" role="status">
          {firstSearch}
        </p>
      )}

      {!loading && searchMarker !== null && searchResult !== null && (
        <LastSearchBanner
          marker={searchMarker}
          freshCount={searchOnlyHits.filter((hit) => freshSearchIds.has(hit.row.tender.id)).length}
          knownCount={searchOnlyHits.filter((hit) => !freshSearchIds.has(hit.row.tender.id)).length}
          onlyActive={onlySearch}
          onToggleOnly={() => {
            setOnlySearch((v) => !v);
            setFilters((f) => ({ ...f, page: 1 }));
          }}
          onDismiss={dismissSearch}
        />
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
            watchFirstSearch({ ...outcome, queries: profile.keywords, startedAt: new Date().toISOString() });
          }}
        />
      ) : page.items.length === 0 && chosenRegions.length > 0 ? (
        <div className="card space-y-2 p-5">
          <p className="text-[15px] font-medium text-foreground">
            В регионе {chosenRegions.join(", ")} пока ничего не найдено
          </p>
          <RegionSearchStatus
            query={regionQuery}
            keywords={filters.searchKeywords.filter(
              (word) => word !== regionQuery,
            )}
            regions={chosenRegions}
            onDone={() => void reload()}
          />
        </div>
      ) : page.items.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Ничего не найдено"
            description={
              // При запросе объясняем, что именно не нашлось и что можно
              // ослабить: пустая выдача без причины выглядит как поломка.
              textQuery !== null
                ? searchEmptyLabel
                : "Попробуйте сбросить фильтры."
            }
          />
        </div>
      ) : (
        <div data-tour="feed">
        <TenderTable
          rows={pageRows}
          sortField={effectiveSortField}
          sortDir={filters.sortDir}
          onSort={onSort}
          searchInfo={searchInfo}
          modelNotes={verdicts}
          freshnessInfo={freshnessInfo}
          rowNotes={rowNotes}
          newIds={newIds}
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
        </div>
      )}

      {!loading && !needsProfile && unknownRegion.length > 0 && (
        <Collapsible
          title={`Регион не определён: ${String(unknownRegion.length)} — источник не указал`}
        >
          <div className="pt-3">
            <TenderTable
              rows={unknownRegion.slice(0, 50)}
              sortField={effectiveSortField}
              sortDir={filters.sortDir}
              onSort={onSort}
              modelNotes={verdicts}
            />
            {unknownRegion.length > 50 && (
              <p className="muted mt-2">
                Показаны первые 50 из {unknownRegion.length}.
              </p>
            )}
          </div>
        </Collapsible>
      )}
      {tourOpen && <ProductTour onClose={closeTour} />}
    </div>
  );
}
