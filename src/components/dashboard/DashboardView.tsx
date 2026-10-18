"use client";

import { KONTUR_ENABLED } from "@/domain/features";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import type { SearchProfile } from "@/domain/entities";
import type { TenderVerdict } from "@/domain/enums";
import { isCustomerKnown, isRegionKnown } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import {
  isClosingWithinDays,
  isCriticalDeadline,
  isSubmissionExpired,
  URGENT_DEADLINE_DAYS,
} from "@/domain/scoring";
import { summarizeSearchMatch } from "@/domain/searchMatching";
import { selectLastKonturBatch } from "@/domain/lastSearch";
import {
  deadlineHistogram,
  groupUrgentByDay,
  hoursUntil,
  isInWork,
  rejectionReason,
  summarizeBudget,
  summarizeVerdicts,
  tallyRejectionReasons,
  todayRank,
} from "@/domain/todayBoard";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { useTenderData } from "@/hooks/useTenderData";
import { useCompletedAnalyses } from "@/hooks/useCompletedAnalyses";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Stat,
  StatStrip,
} from "@/components/ui/primitives";
import { VerdictBadge } from "@/components/analysis";
import { SearchEmptyExplanation } from "@/components/dashboard/SearchEmptyExplanation";
import {
  NewTendersButton,
  NewTendersStatus,
  useTendersSearch,
} from "@/components/dashboard/NewTendersSearch";
import { ProfileAuditSummary } from "@/components/dashboard/ProfileAuditSummary";
import { DeadlineChart, RejectionBars, VerdictBar, verdictHref } from "@/components/dashboard/TodayCharts";
import { dataSourceLabels, pipelineLabels } from "@/lib/labels";
import {
  formatCompactRub,
  formatDate,
  formatDateTime,
  formatTenderPrice,
  formatTimeLeft,
  pluralRu,
} from "@/utils/format";
import { cn } from "@/lib/cn";

/** Сколько закупок показываем в блоке «Лучшее из нового». */
const TOP_TODAY = 6;
/** Сколько закупок в работе видно на первом экране; остальные — в воронке. */
const IN_WORK_SHOWN = 4;
/** Сколько готовых разборов показываем: блок — напоминание, а не журнал. */
const ANALYZED_SHOWN = 5;
/** Сколько закупок показываем в блоке «Горит». */
const URGENT_SHOWN = 5;
/** Сколько главных причин отказа рисуем столбиками (и примеров в раскрытии). */
const REJECTED_SHOWN = 5;

/**
 * Почему закупка стоит в подборке: первый плюс и первый минус из заключения.
 *
 * Раньше в каждой строке печаталось одно и то же резюме («48 из 100…»), и
 * строки отличались только заголовком. Конкретный плюс и конкретный риск
 * отвечают на «зачем открывать» и «что проверить». Нет ни того ни другого —
 * показываем резюме, как и раньше: выдумывать причину нельзя.
 */
function fitReasons(row: TenderRow): {
  positive: string | null;
  negative: string | null;
  summary: string;
} {
  const { positiveFactors, negativeFactors, uncertainties, summary } = row.analysis;
  return {
    positive: positiveFactors[0]?.text ?? null,
    negative: negativeFactors[0]?.text ?? uncertainties[0]?.question ?? null,
    summary,
  };
}

/** Время подачи для строки: «до 18:00», дата уже названа заголовком группы. */
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** «вторник, 6 октября» — дата среза данных под заголовком. */
function formatToday(now: Date): string {
  return now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
}

/**
 * Экран «Сегодня».
 *
 * Один экран — одна задача: решить, что делать сегодня. Сверху сводка (четыре
 * числа и полоса вердиктов), ниже блоки в порядке вопроса пользователя: что в
 * работе, что горит, что открыть, почему остальное отклонено. Диаграммы
 * («Подача по дням», причины отказа) стоят рядом с теми блоками, которые они
 * поясняют. Всё, что объясняет устройство системы (телеметрия синхронизации,
 * тренды к прошлому срезу, распределение по регионам, сигналы мониторинга),
 * отсюда убрано: на решение оно не влияет, а место на первом экране занимает.
 *
 * Просроченные закупки не попадают ни в «Лучшее из нового», ни в «Горит», ни в
 * счётчики и диаграммы — для них есть доменный блокер «Срок подачи истёк».
 * Вся арифметика (доли, дни, группы, причины) живёт в `domain/todayBoard`,
 * здесь только отрисовка.
 */
export function DashboardView() {
  const { profile, rows, loading, error, reload } = useTenderData();
  const search = useTendersSearch(reload);
  const completedAnalyses = useCompletedAnalyses();
  const [rejectedOpen, setRejectedOpen] = useState(false);
  const [searchProfiles, setSearchProfiles] = useState<SearchProfile[]>([]);
  /*
    Раскрыта ли панель подтверждения поиска. Состояние живёт здесь, а не в
    панели, потому что кнопку открывают с двух мест экрана: из заголовка и из
    блока «Откройте сегодня», когда подходящих закупок нет.
  */

  useEffect(() => {
    setSearchProfiles(searchProfileRepository.getAll().filter((p) => p.enabled));
  }, [rows]);

  /*
    «Сейчас» фиксируем на срез данных, а не пересчитываем на каждый рендер:
    иначе список срочных закупок дёргался бы при каждом открытии блока.
    Зависимость от `rows` здесь намеренная — это и есть «новый срез».
  */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [rows]);

  const openRows = useMemo(
    () =>
      rows.filter((row) => !isSubmissionExpired(row.tender.deadlines.submissionEnd, now)),
    [rows, now],
  );

  /*
    Вердикты считаются по открытым закупкам, а не по всей ленте (см.
    `verdictSummary` ниже).

    В ленте 40% строк с истёкшим сроком, и по ним вердикт почти всегда
    «Не подходит» — по доменному блокеру «Срок подачи истёк». Складывая их в
    общий счётчик, экран печатал «Не подходит: 106», где 68 означало не
    «не подходит вашей компании», а «объявление устарело».
  */

  /*
    Партия последнего прогона Контур.Закупок: строки с общей меткой записи.

    Считается от всей ленты, а не от отфильтрованной, и показывается отдельным
    блоком сверху — ответ на «куда уходит результат поиска» обязан быть виден
    сразу, без похода в ленту из нескольких сотен строк.
  */
  const lastBatch = useMemo(() => (KONTUR_ENABLED ? selectLastKonturBatch(rows) : null), [rows]);

  const batchIds = useMemo(
    () => new Set((lastBatch?.rows ?? []).map((row) => row.tender.id)),
    [lastBatch],
  );

  /**
   * Закупки, взятые в работу: первый блок экрана.
   *
   * Это единственное, что человек на экране «Сегодня» обязан сделать сам —
   * у остального срок ещё не наступил. Порядок по сроку подачи: ближайший
   * дедлайн и есть ответ на вопрос «что горит из моего».
   */
  const inWork = useMemo(
    () =>
      openRows
        .filter((row) => isInWork(row.pipelineStatus))
        .sort(
          (a, b) =>
            new Date(a.tender.deadlines.submissionEnd).getTime() -
            new Date(b.tender.deadlines.submissionEnd).getTime(),
        ),
    [openRows],
  );

  /*
    Закупки, по которым разбор закончился.

    Блок существует ровно из-за одной дыры: разбор идёт минутами, партнёр уходит
    со страницы, и вернуться к закупке может только вспомнив её номер среди
    сотен строк выдачи. Поэтому список свежих сверху и сразу ссылками — это
    точка возврата, а не отчёт.
  */
  const analyzedRows = useMemo(() => {
    const finished = (id: string): number => {
      const value = completedAnalyses.finishedAt.get(id);
      const time = value === null || value === undefined ? NaN : Date.parse(value);
      return Number.isNaN(time) ? 0 : time;
    };
    return openRows
      .filter((row) => completedAnalyses.ids.has(row.tender.id))
      .sort((a, b) => finished(b.tender.id) - finished(a.tender.id));
  }, [openRows, completedAnalyses]);

  const inWorkIds = useMemo(
    () => new Set(inWork.map((row) => row.tender.id)),
    [inWork],
  );

  /** Кандидаты в подборку: не просрочены, не отклонены и ещё не в работе. */
  const candidates = useMemo(
    () =>
      openRows.filter(
        (row) =>
          row.analysis.verdict !== "NOT_RECOMMENDED" && !inWorkIds.has(row.tender.id),
      ),
    [openRows, inWorkIds],
  );

  /*
    «Лучшее из нового» — один список вместо двух.

    Раньше результат последнего прогона и подборка по соответствию шли
    отдельными блоками, и человек читал два списка об одном и том же. Теперь
    список один, а принадлежность к последнему прогону показывается меткой на
    строке: это свойство закупки, а не повод для отдельного раздела.
  */
  const top = useMemo(
    () =>
      [...candidates].sort((a, b) => todayRank(b, now) - todayRank(a, now)).slice(0, TOP_TODAY),
    [candidates, now],
  );

  /** Масштаб денег в подборке: первый вопрос подрядчика — сколько на столе. */
  const topBudget = useMemo(() => summarizeBudget(top), [top]);

  const urgent = useMemo(
    () =>
      openRows
        .filter(
          (row) =>
            row.analysis.verdict !== "NOT_RECOMMENDED" &&
            isClosingWithinDays(
              row.tender.deadlines.submissionEnd,
              URGENT_DEADLINE_DAYS,
              now,
            ),
        )
        .sort(
          (a, b) =>
            new Date(a.tender.deadlines.submissionEnd).getTime() -
            new Date(b.tender.deadlines.submissionEnd).getTime(),
        ),
    [openRows, now],
  );

  /*
    Отклонённые — только среди открытых закупок.

    Просроченные отсюда убраны: их отклонил не профиль компании, а календарь,
    и «чаще всего: Срок подачи истёк» ничего не говорило о том, что поправить
    в условиях поиска. Теперь в блоке остаются настоящие причины отказа.
  */
  const rejected = useMemo(
    () => openRows.filter((row) => row.analysis.verdict === "NOT_RECOMMENDED"),
    [openRows],
  );

  /**
   * Главные причины отказа: что в условиях поиска исправлять первым.
   * Доли считаются от всех отклонённых, см. `tallyRejectionReasons`.
   */
  const rejectionTally = useMemo(
    () => tallyRejectionReasons(rejected, REJECTED_SHOWN),
    [rejected],
  );

  /** Доли вердиктов — по открытым закупкам, как и счётчики выше. */
  const verdictSummary = useMemo(() => summarizeVerdicts(openRows), [openRows]);

  /**
   * Подача по дням. Считается от открытых строк, а отклонённые функция
   * отсекает сама: на диаграмме только то, что ещё можно подать.
   */
  const histogram = useMemo(() => deadlineHistogram(openRows, now), [openRows, now]);

  /** НМЦК горящих закупок: сколько денег закрывается в ближайшие дни. */
  const urgentBudget = useMemo(() => summarizeBudget(urgent), [urgent]);

  /** Видимая часть «Горит», разложенная по дням подачи. */
  const urgentGroups = useMemo(
    () => groupUrgentByDay(urgent.slice(0, URGENT_SHOWN), now),
    [urgent, now],
  );

  /** Чем отклонены закупки при поиске: объяснение пустого блока «Откройте сегодня». */
  const matchSummary = useMemo(
    () => summarizeSearchMatch(rows, searchProfiles, now),
    [rows, searchProfiles, now],
  );

  const sources = useMemo(
    () => [...new Set(rows.map((row) => row.tender.dataSource))].map((s) => dataSourceLabels[s]),
    [rows],
  );

  const lastSync = useMemo(
    () => rows.map((row) => row.analysis.analyzedAt).sort().at(-1),
    [rows],
  );

  /*
    Имя в приветствии: профиль может существовать с пустым названием компании
    (его создаёт мастер первого запуска), и «Здравствуйте, » с висящей запятой
    читалось как поломка. Пустое после trim — обычный заголовок.
  */
  const legalName = profile?.legalName.trim() ?? "";
  const heading = legalName ? `Здравствуйте, ${legalName}` : "Сегодня";

  const urgentWindow = `${URGENT_DEADLINE_DAYS} ${pluralRu(URGENT_DEADLINE_DAYS, ["день", "дня", "дней"])}`;

  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-tight text-foreground">{heading}</h1>
          {/* Дата выводится только после загрузки: до неё `now` берётся на сервере
              и в другом часовом поясе, и первая отрисовка разошлась бы с клиентской. */}
          <p className="mt-1.5 text-[15.5px] text-muted-foreground">
            {loading ? (
              "Загрузка…"
            ) : (
              <>
                {formatToday(now)} ·{" "}
                {lastSync ? (
                  <>
                    данные на <span className="num">{formatDateTime(lastSync)}</span>
                  </>
                ) : (
                  "данные ещё не загружены"
                )}
              </>
            )}
          </p>
        </div>
        <NewTendersButton search={search} busy={loading} />
      </div>

      <NewTendersStatus search={search} />

      {/* Противоречия в профиле компании объясняют плохой результат раньше,
          чем пользователь начнёт винить закупки. Свёрнуты в одну строку: они не
          должны вытеснять с первого экрана сами закупки. Пустым не показывается. */}
      {profile && <ProfileAuditSummary profile={profile} />}

      {loading ? (
        <LoadingSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Закупок пока нет"
            description="Нажмите «Найти новые закупки» — лента наполнится через несколько минут."
          />
          {searchProfiles.length === 0 && (
            <div className="mt-4 flex justify-center">
              <Link href="/settings/search">
                <Button size="sm" variant="secondary">
                  Указать, что ищем
                </Button>
              </Link>
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {/*
            Сводка: четыре числа и одна полоса вердиктов. Числа отвечают «сколько
            и чего», полоса — «насколько перекошена выдача». Вместе они занимают
            меньше места, чем прежние три текстовые пилюли с подписями.
          */}
          <div className="space-y-3">
            <StatStrip dense>
              <Stat
                label="Открытых закупок"
                value={openRows.length}
                hint={<>из {rows.length} в базе</>}
              />
              <Stat
                label={`Закрывается за ${urgentWindow}`}
                value={
                  <span className={cn(urgent.length > 0 && "text-brick-fg")}>{urgent.length}</span>
                }
                hint="без отклонённых"
              />
              <Stat
                label="В работе"
                value={inWork.length}
                hint={
                  inWork[0] ? (
                    <>
                      подача до{" "}
                      <span className="num">{formatDate(inWork[0].tender.deadlines.submissionEnd)}</span>
                    </>
                  ) : (
                    "пока ничего не взято"
                  )
                }
              />
              <Stat
                label="Бюджет подборки"
                value={topBudget.counted > 0 ? formatCompactRub(topBudget.total) : "—"}
                hint={
                  <>
                    {top.length} {pluralRu(top.length, ["закупка", "закупки", "закупок"])}
                    {topBudget.skipped > 0 && <> · у {topBudget.skipped} нет цены в ₽</>}
                  </>
                }
              />
            </StatStrip>
            <VerdictBar shares={verdictSummary.shares} total={verdictSummary.total} />
          </div>

          {/*
            Две колонки на lg+: слева то, с чем работаешь (в работе, разбор,
            подборка), справа то, что подсказывает срок и причины отказа. На
            телефоне колонки «растворяются» (`contents`), а порядок блоков задан
            `order-*`: в работе → горит → подборка → остальное. Горящие сроки
            поднимаются выше подборки — пропущенный срок не отыграть, а новую
            закупку можно посмотреть и завтра.
          */}
          <div className="flex flex-col gap-4 lg:grid lg:grid-cols-3 lg:items-start">
            <div className="contents lg:col-span-2 lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
              {/*
                Первым — то, что человек взял в работу сам: по остальному срок ещё
                не наступил, а здесь уже есть обязательства и дедлайны.
              */}
              <Card
                className="order-1 lg:order-none"
                title="В работе у вас"
                actions={
                  <Link href="/pipeline" className="text-[13.5px] text-accent-fg hover:underline">
                    Все мои закупки
                  </Link>
                }
              >
                {inWork.length === 0 ? (
                  <p className="text-[14.5px] text-muted-foreground">
                    Вы пока ничего не взяли в работу. Отметьте закупку «Интересные» — она
                    появится здесь.
                  </p>
                ) : (
                  <>
                    <p className="text-[14.5px] text-muted-foreground">
                      {inWork.length}{" "}
                      {pluralRu(inWork.length, ["закупка", "закупки", "закупок"])} в работе
                      {inWork[0] && (
                        <>
                          {" "}
                          · ближайшая подача{" "}
                          <span className="num">
                            {formatDate(inWork[0].tender.deadlines.submissionEnd)}
                          </span>{" "}
                          ({formatTimeLeft(inWork[0].tender.deadlines.submissionEnd, now)})
                        </>
                      )}
                    </p>
                    <ul className="mt-3 space-y-2">
                      {inWork.slice(0, IN_WORK_SHOWN).map((row) => (
                        <InWorkRow key={row.tender.id} row={row} now={now} />
                      ))}
                    </ul>
                    {inWork.length > IN_WORK_SHOWN && (
                      <Link
                        href="/pipeline"
                        className="mt-3 inline-flex text-[13.5px] text-accent-fg hover:underline"
                      >
                        Ещё {inWork.length - IN_WORK_SHOWN} — показать все
                      </Link>
                    )}
                  </>
                )}
              </Card>

              {/*
                Разбор закончился — вот куда вернуться.

                Блок показывается только когда есть что показать: пустая карточка
                «пока ничего не разобрано» на каждом открытии экрана была бы шумом,
                а не подсказкой.
              */}
              {analyzedRows.length > 0 && (
                <Card
                  className="order-4 lg:order-none"
                  title="Разбор готов"
                >
                  <ul className="space-y-2">
                    {analyzedRows.slice(0, ANALYZED_SHOWN).map((row) => (
                      <li
                        key={row.tender.id}
                        className="flex flex-col gap-2 rounded-control border border-border/70 bg-panel px-4 py-3 shadow-card sm:flex-row sm:items-start sm:justify-between sm:gap-3"
                      >
                        <div className="min-w-0">
                          <Link
                            href={`/tenders/${row.tender.id}`}
                            className="line-clamp-2 text-[14.5px] font-medium hover:underline"
                          >
                            {row.tender.subject}
                          </Link>
                          <p className="mt-1 text-[13.5px] text-muted-foreground">
                            № <span className="num">{row.tender.regNumber}</span> · подача до{" "}
                            <span className="num">
                              {formatDate(row.tender.deadlines.submissionEnd)}
                            </span>
                          </p>
                        </div>
                        <VerdictBadge verdict={row.analysis.verdict} />
                      </li>
                    ))}
                  </ul>
                  {analyzedRows.length > ANALYZED_SHOWN && (
                    <Link
                      href="/tenders"
                      className="mt-3 inline-flex text-[13.5px] text-accent-fg hover:underline"
                    >
                      Ещё {analyzedRows.length - ANALYZED_SHOWN} — показать все
                    </Link>
                  )}
                </Card>
              )}

              <Card
                className="order-3 lg:order-none"
                title="Лучшее из нового"
                actions={
                  <Link href="/tenders" className="text-[13.5px] text-accent-fg hover:underline">
                    Все закупки
                  </Link>
                }
              >
                {top.length === 0 ? (
                  <div className="space-y-3">
                    <p className="text-[14.5px] text-muted-foreground">
                      Подходящих закупок сейчас нет.
                    </p>
                    <SearchEmptyExplanation summary={matchSummary} />
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href="/settings/search"
                        className="text-[14.5px] text-accent-fg hover:underline"
                      >
                        Изменить условия поиска
                      </Link>
                    </div>
                  </div>
                ) : (
                  <>
                    {/*
                      Масштаб денег в подборке. Валютные закупки и закупки без НМЦ
                      в сумму не входят и названы отдельно: пересчёт по выдуманному
                      курсу дал бы на первом экране число, которого нет в извещении.
                    */}
                    <p className="text-[14.5px] text-muted-foreground">
                      {top.length} {pluralRu(top.length, ["закупка", "закупки", "закупок"])}
                      {topBudget.counted > 0 && (
                        <>
                          {" "}
                          на <span className="num">{formatCompactRub(topBudget.total)}</span>
                        </>
                      )}
                      {topBudget.skipped > 0 && (
                        <>
                          {" "}
                          · у {topBudget.skipped}{" "}
                          {pluralRu(topBudget.skipped, ["закупки", "закупок", "закупок"])} цена не
                          указана или в валюте
                        </>
                      )}
                      {lastBatch && (
                        <>
                          {" · "}
                          <Link
                            href={`/tenders?batch=${encodeURIComponent(lastBatch.stamp)}`}
                            className="text-accent-fg hover:underline"
                          >
                            весь платный поиск ({lastBatch.rows.length})
                          </Link>
                        </>
                      )}
                    </p>
                    <ul className="mt-3 space-y-2.5">
                      {top.map((row) => (
                        <TodayRow
                          key={row.tender.id}
                          row={row}
                          now={now}
                          isNew={batchIds.has(row.tender.id)}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </Card>
            </div>

            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
              <Card
                className="order-2 lg:order-none"
                title="Горит"
                actions={
                  <span className="text-[13.5px] text-muted-foreground">
                    ближайшие {urgentWindow}
                    {urgentBudget.counted > 0 && (
                      <>
                        {" · на "}
                        <span className="num whitespace-nowrap font-medium text-foreground">
                          {formatCompactRub(urgentBudget.total)}
                        </span>
                      </>
                    )}
                  </span>
                }
              >
                {urgent.length === 0 ? (
                  <p className="text-[14.5px] text-muted-foreground">
                    Горящих сроков нет: в ближайшие {urgentWindow} подача не закрывается.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {urgentGroups.map((group) => (
                      <section key={group.offset} aria-label={group.label}>
                        <h3 className="flex items-baseline gap-1.5 text-[12.5px] font-semibold uppercase tracking-[0.07em] text-faint">
                          {group.label}
                          <span className="num font-medium normal-case tracking-normal">
                            {group.rows.length}
                          </span>
                        </h3>
                        <ul className="mt-1 space-y-1">
                          {group.rows.map((row) => (
                            <UrgentRow key={row.tender.id} row={row} now={now} />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
                {urgentBudget.skipped > 0 && urgent.length > 0 && (
                  <p className="mt-3 text-[12.5px] text-faint">
                    В сумму не вошло {urgentBudget.skipped}:{" "}
                    {pluralRu(urgentBudget.skipped, ["цена не указана", "цены не указаны", "цены не указаны"])}{" "}
                    или в валюте.
                  </p>
                )}
                {urgent.length > URGENT_SHOWN && (
                  <Link
                    href="/tenders?soon=1"
                    className="mt-3 inline-flex text-[13.5px] text-accent-fg hover:underline"
                  >
                    Ещё {urgent.length - URGENT_SHOWN} — показать все
                  </Link>
                )}
              </Card>

              <Card className="order-5 lg:order-none" title="Подача по дням">
                <DeadlineChart
                  days={histogram.days}
                  inWindow={histogram.inWindow}
                  beyond={histogram.beyond}
                />
              </Card>

              <Card className="order-6 lg:order-none" title="Не подошло — почему">
                {rejected.length === 0 ? (
                  <p className="text-[14.5px] text-muted-foreground">Отклонённых закупок нет.</p>
                ) : (
                  <>
                    <p className="mb-3 text-[14.5px] text-muted-foreground">
                      <span className="num font-medium text-foreground">{rejected.length}</span>{" "}
                      {pluralRu(rejected.length, ["закупка", "закупки", "закупок"])} отклонено
                    </p>
                    <RejectionBars reasons={rejectionTally.reasons} total={rejectionTally.total} />
                    {rejectionTally.otherCount > 0 && (
                      <p className="mt-2.5 text-[12.5px] text-faint">
                        ещё <span className="num">{rejectionTally.otherCount}</span> — по другим причинам
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <Link
                        href={verdictHref("NOT_RECOMMENDED")}
                        className="text-[13.5px] text-accent-fg hover:underline"
                      >
                        Показать все отклонённые
                      </Link>
                      <Link
                        href="/settings/search"
                        className="text-[13.5px] text-accent-fg hover:underline"
                      >
                        Изменить условия поиска
                      </Link>
                    </div>
                    <div className="mt-3 border-t border-border pt-2">
                      <button
                        type="button"
                        onClick={() => setRejectedOpen((v) => !v)}
                        aria-expanded={rejectedOpen}
                        className="flex w-full items-center justify-between gap-3 py-1 text-left text-[13.5px] text-muted-foreground hover:text-foreground"
                      >
                        {rejectedOpen ? "Скрыть примеры" : "Показать примеры закупок"}
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 shrink-0 text-faint transition-transform",
                            rejectedOpen && "rotate-180",
                          )}
                          aria-hidden
                        />
                      </button>
                      {rejectedOpen && (
                        <ul className="mt-2 space-y-2.5">
                          {rejected.slice(0, REJECTED_SHOWN).map((row) => (
                            <li key={row.tender.id} className="min-w-0">
                              <Link
                                href={`/tenders/${row.tender.id}`}
                                className="line-clamp-1 text-[14.5px] font-medium text-foreground hover:text-accent-fg"
                              >
                                {row.tender.subject}
                              </Link>
                              <p className="mt-0.5 text-[13.5px] text-brick-fg">
                                {rejectionReason(row)}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </Card>
            </div>
          </div>

          {/* Оговорка «оценка — не вероятность победы» стоит в подвале каждой страницы. */}
          <p className="text-[12.5px] text-faint">
            {rows.length} {pluralRu(rows.length, ["закупка", "закупки", "закупок"])} в базе
            {sources.length > 0 && <> · источники: {sources.join(", ")}</>}
          </p>
        </div>
      )}
    </div>
  );
}

/*
  Кольцо соответствия 0–100 в цвете вердикта.

  Цвет берётся от вердикта, а не от порога числа: так кольцо не спорит с
  бейджем рядом (число 48 при «Нужно посмотреть» не станет красным). Число
  внутри — не украшение: цвет не должен быть единственным носителем смысла.
*/
const RING_STROKE: Record<TenderVerdict, string> = {
  RECOMMENDED: "stroke-olive",
  MANUAL_REVIEW: "stroke-mustard",
  NOT_RECOMMENDED: "stroke-brick",
};

function FitRing({ score, verdict }: { score: number; verdict: TenderVerdict }) {
  const value = Math.max(0, Math.min(100, Math.round(score)));
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const label = `Соответствие профилю: ${value} из 100`;
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className="relative h-11 w-11 shrink-0"
      data-testid="fit-ring"
    >
      <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r={radius} fill="none" strokeWidth="3.5" className="stroke-panel-raised" />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${(value / 100) * circumference} ${circumference}`}
          className={RING_STROKE[verdict]}
        />
      </svg>
      <span className="num absolute inset-0 flex items-center justify-center text-[13.5px] font-semibold text-foreground">
        {value}
      </span>
    </div>
  );
}

/* Закупка из блока «Лучшее из нового». */
function TodayRow({
  row,
  now,
  isNew = false,
}: {
  row: TenderRow;
  now: Date;
  /** Закупка пришла последним прогоном — метка вместо отдельного блока. */
  isNew?: boolean;
}) {
  /*
   * Строка «кто · где · сколько»: заглушки «Заказчик не указан» и «Не указан»
   * не печатаем — две заглушки подряд читаются как поломка экрана, а не как
   * отсутствие данных. Цена остаётся всегда: её отсутствие само по себе факт.
   */
  const meta = [
    isCustomerKnown(row.tender.customerName) ? row.tender.customerName : null,
    isRegionKnown(row.tender.region) ? row.tender.region : null,
  ].filter((part): part is string => part !== null);
  const reasons = fitReasons(row);
  const hasFactors = reasons.positive !== null || reasons.negative !== null;
  return (
    <li className="flex gap-3 rounded-control border border-border/70 bg-panel px-4 py-3 shadow-card transition-shadow hover:shadow-card-hover">
      <FitRing score={row.analysis.fitScore} verdict={row.analysis.verdict} />
      <div className="min-w-0 flex-1">
        {/* Вердикт встаёт под заголовок на узком экране: нерастяжимый бейдж
            рядом с названием оставлял названию одно слово. */}
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <Link
              href={`/tenders/${row.tender.id}`}
              className="line-clamp-2 text-[14.5px] font-medium text-foreground hover:text-accent-fg sm:line-clamp-1"
            >
              {row.tender.subject}
            </Link>
            <p className="mt-0.5 text-[13.5px] text-muted-foreground">
              {meta.length > 0 && <>{meta.join(" · ")} · </>}
              <span className="num">
                {formatTenderPrice(row.tender.financial.price, row.tender.financial.currency)}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isNew && (
              <span className="rounded-full bg-accent-subtle px-2.5 py-1 text-[13.5px] font-medium text-accent-fg">
                новое
              </span>
            )}
            <VerdictBadge verdict={row.analysis.verdict} />
          </div>
        </div>
        {hasFactors ? (
          /* Не ul/li: вложенные пункты стали бы лишними listitem внутри строки списка. */
          <div className="mt-1.5 space-y-0.5 text-[13.5px] leading-snug">
            {reasons.positive && (
              <p className="flex items-start gap-1.5 text-muted-foreground">
                <Check className="mt-[3px] h-3.5 w-3.5 shrink-0 text-olive-fg" aria-hidden />
                <span className="line-clamp-1" title={reasons.positive}>
                  {reasons.positive}
                </span>
              </p>
            )}
            {reasons.negative && (
              <p className="flex items-start gap-1.5 text-muted-foreground">
                <AlertTriangle className="mt-[3px] h-3.5 w-3.5 shrink-0 text-mustard-fg" aria-hidden />
                <span className="line-clamp-1" title={reasons.negative}>
                  {reasons.negative}
                </span>
              </p>
            )}
          </div>
        ) : (
          <p className="mt-1.5 line-clamp-2 text-[13.5px] leading-snug text-muted-foreground">
            {reasons.summary}
          </p>
        )}
        {/* Отдельной ссылки «Смотреть» нет: название строки — та же ссылка. */}
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          подача до <span className="num">{formatDate(row.tender.deadlines.submissionEnd)}</span>{" "}
          · {formatTimeLeft(row.tender.deadlines.submissionEnd, now)}
        </p>
      </div>
    </li>
  );
}

/* Закупка из блока «Срочно»: срок важнее всего остального. */
/*
  Закупка, взятая в работу: статус воронки важнее вердикта.

  Вердикт здесь уже не нужен — решение принято, закупка выбрана человеком.
  Нужно другое: на каком она шаге и сколько осталось до подачи.
*/
function InWorkRow({ row, now }: { row: TenderRow; now: Date }) {
  const critical = isCriticalDeadline(row.tender.deadlines.submissionEnd, now);
  return (
    <li className="flex flex-col gap-2 rounded-control border border-border/70 bg-panel px-4 py-3 shadow-card sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <Link
          href={`/tenders/${row.tender.id}`}
          className="line-clamp-2 text-[15.5px] font-medium text-foreground hover:text-accent-fg sm:line-clamp-1"
        >
          {row.tender.subject}
        </Link>
        <p className="mt-1 text-[14.5px] text-muted-foreground">
          <span className="num">
            {formatTenderPrice(row.tender.financial.price, row.tender.financial.currency)}
          </span>{" "}
          · подача до{" "}
          <span className="num">{formatDate(row.tender.deadlines.submissionEnd)}</span> ·{" "}
          <span className={cn(critical && "text-brick-fg font-medium")}>
            {formatTimeLeft(row.tender.deadlines.submissionEnd, now)}
          </span>
        </p>
      </div>
      <span className="shrink-0 rounded-full bg-panel-raised px-2.5 py-1 text-[13.5px] font-medium text-muted-foreground">
        {pipelineLabels[row.pipelineStatus]}
      </span>
    </li>
  );
}

/*
  Строка блока «Горит»: срок важнее всего остального, поэтому чип с оставшимися
  часами стоит справа и красится по близости срока. День подачи назван
  заголовком группы, а в строке остаётся только время суток.
*/
function UrgentRow({ row, now }: { row: TenderRow; now: Date }) {
  const critical = isCriticalDeadline(row.tender.deadlines.submissionEnd, now);
  const hours = hoursUntil(row.tender.deadlines.submissionEnd, now);
  return (
    <li className="flex items-center justify-between gap-2 rounded-control px-1 py-1.5">
      <div className="min-w-0">
        <Link
          href={`/tenders/${row.tender.id}`}
          className="line-clamp-1 text-[14.5px] font-medium text-foreground hover:text-accent-fg"
        >
          {row.tender.subject}
        </Link>
        <p className="mt-0.5 text-[13.5px] text-muted-foreground">
          <span className="num">
            {formatTenderPrice(row.tender.financial.price, row.tender.financial.currency)}
          </span>{" "}
          · до <span className="num">{formatClock(row.tender.deadlines.submissionEnd)}</span>
        </p>
      </div>
      {hours !== null && (
        <span
          title={`Осталось ${hours} ч до конца подачи`}
          aria-label={`Осталось ${hours} ч`}
          className={cn(
            "num shrink-0 rounded-full px-2.5 py-1 text-[13.5px] font-medium whitespace-nowrap",
            critical ? "bg-brick-subtle text-brick-fg" : "bg-mustard-subtle text-mustard-fg",
          )}
        >
          {hours} ч
        </span>
      )}
    </li>
  );
}
