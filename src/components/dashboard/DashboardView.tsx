"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { SearchProfile } from "@/domain/entities";
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
import { isInWork, summarizeBudget, todayRank } from "@/domain/todayBoard";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { useTenderData } from "@/hooks/useTenderData";
import { useCompletedAnalyses } from "@/hooks/useCompletedAnalyses";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
} from "@/components/ui/primitives";
import { DisclaimerAlert, VerdictBadge } from "@/components/analysis";
import { SearchEmptyExplanation } from "@/components/dashboard/SearchEmptyExplanation";
import { TenderSearchPanel } from "@/components/dashboard/TenderSearchPanel";
import { ProfileAuditNotice } from "@/components/settings/ProfileAuditNotice";
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

/** Сколько закупок показываем в блоке «Откройте сегодня». */
const TOP_TODAY = 6;
/** Сколько закупок в работе видно на первом экране; остальные — в воронке. */
const IN_WORK_SHOWN = 4;
/** Сколько готовых разборов показываем: блок — напоминание, а не журнал. */
const ANALYZED_SHOWN = 5;
/** Сколько закупок показываем в блоке «Срочно». */
const URGENT_SHOWN = 5;
/** Сколько причин отказа видно в раскрытом блоке «Не подошло». */
const REJECTED_SHOWN = 5;

/**
 * Причина отказа одной строкой.
 *
 * Берём первый стоп-фактор: он же показывается в карточке закупки, поэтому
 * объяснение на двух экранах не расходится. Если стоп-фактора нет (отказ по
 * оценке соответствия), говорим об этом прямо, а не выдумываем причину.
 */
function rejectionReason(row: TenderRow): string {
  return (
    row.analysis.hardBlockers[0]?.reason ??
    row.analysis.negativeFactors[0]?.text ??
    "Не проходит по условиям профиля"
  );
}

/** Почему эта закупка подходит — одна строка из заключения. */
function fitReason(row: TenderRow): string {
  return row.analysis.positiveFactors[0]?.text ?? row.analysis.summary;
}

/**
 * Экран «Сегодня».
 *
 * Один экран — одна задача: решить, что делать сегодня. Поэтому блоков три и
 * они идут в порядке вопроса пользователя: что открыть, что горит, почему
 * остальное отклонено. Всё, что объясняет устройство системы (телеметрия
 * синхронизации, тренды к прошлому срезу, распределение по регионам, сигналы
 * мониторинга), отсюда убрано: на решение оно не влияет, а место на первом
 * экране занимает.
 *
 * Просроченные закупки не попадают ни в «Откройте сегодня», ни в «Срочно» —
 * для них есть доменный блокер «Срок подачи истёк» и блок «Не подошло».
 */
export function DashboardView() {
  const { profile, rows, loading, error, reload, syncKontur, syncState } = useTenderData();
  const completedAnalyses = useCompletedAnalyses();
  const [rejectedOpen, setRejectedOpen] = useState(false);
  const [searchProfiles, setSearchProfiles] = useState<SearchProfile[]>([]);
  /*
    Раскрыта ли панель подтверждения поиска. Состояние живёт здесь, а не в
    панели, потому что кнопку открывают с двух мест экрана: из заголовка и из
    блока «Откройте сегодня», когда подходящих закупок нет.
  */
  const [searchOpen, setSearchOpen] = useState(false);

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
    Счётчики считаются по открытым закупкам, а не по всей ленте.

    В ленте 40% строк с истёкшим сроком, и по ним вердикт почти всегда
    «Не подходит» — по доменному блокеру «Срок подачи истёк». Складывая их в
    общий счётчик, экран печатал «Не подходит: 106», где 68 означало не
    «не подходит вашей компании», а «объявление устарело».
  */
  const counts = useMemo(() => {
    const acc = { RECOMMENDED: 0, MANUAL_REVIEW: 0, NOT_RECOMMENDED: 0 };
    for (const row of openRows) acc[row.analysis.verdict] += 1;
    return acc;
  }, [openRows]);

  /*
    Партия последнего прогона Контур.Закупок: строки с общей меткой записи.

    Считается от всей ленты, а не от отфильтрованной, и показывается отдельным
    блоком сверху — ответ на «куда уходит результат поиска» обязан быть виден
    сразу, без похода в ленту из нескольких сотен строк.
  */
  const lastBatch = useMemo(() => selectLastKonturBatch(rows), [rows]);

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

  /** Самая частая причина отказа — то, что стоит исправить в профиле первым. */
  const mainRejection = useMemo(() => {
    const tally = new Map<string, number>();
    for (const row of rejected) {
      const reason = rejectionReason(row);
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
    let best: { reason: string; count: number } | null = null;
    for (const [reason, count] of tally) {
      if (best === null || count > best.count) best = { reason, count };
    }
    return best;
  }, [rejected]);

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

  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-tight text-foreground">
            {profile ? `Здравствуйте, ${profile.legalName}` : "Сегодня"}
          </h1>
          {loading ? (
            <p className="mt-1.5 text-[15.5px] text-muted-foreground">Загрузка…</p>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Counter tone="olive" label="Подходит" value={counts.RECOMMENDED} />
              <Counter tone="mustard" label="Нужно посмотреть" value={counts.MANUAL_REVIEW} />
              <Counter tone="brick" label="Не подходит" value={counts.NOT_RECOMMENDED} />
            </div>
          )}
        </div>
        <TenderSearchPanel
          open={searchOpen}
          onOpenChange={setSearchOpen}
          syncKontur={syncKontur}
          syncState={syncState}
          busy={loading}
        />
      </div>

      {/* Противоречия в профиле компании объясняют плохой результат раньше,
          чем пользователь начнёт винить закупки. Пустым не показывается. */}
      {profile && <ProfileAuditNotice profile={profile} />}

      {syncState.error && (
        <Card>
          <div className="flex items-start gap-3">
            {/* text-brick, а не text-destructive: токена `destructive` в палитре
                нет (это имя из shadcn/ui), класс не компилировался и иконка
                теряла сигнальный цвет ровно там, где он нужен. */}
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-brick" />
            <div className="flex-1">
              <p className="text-[14.5px] font-medium text-foreground">
                Новые закупки не загрузились
              </p>
              {/*
                Совет «проверьте интернет» здесь был бы ложью: чаще всего
                отказ приходит от самого источника — исчерпан суточный бюджет
                (429), ключ отклонён (401) или не задан (503). Причина уже
                содержится в тексте ошибки, поэтому добавлять к ней нечего.
              */}
              <p className="mt-1 text-[13.5px] text-muted-foreground">{syncState.error}</p>
            </div>
          </div>
        </Card>
      )}

      {loading ? (
        <LoadingSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <Card>
          {/*
            Площадки в подписи намеренно не перечислены, и «на вашем компьютере»
            больше не написано. Перечисление устаревало дважды за неделю
            (ТЭК-Торг, затем Росэлторг), а сам прогон с 25.09.2026 живёт на
            сервере в России — задача Windows на машине владельца отключена,
            поэтому прежняя подпись была неправдой. Платный агрегатор не назван
            тем более: кнопка ставит в очередь бесплатный прогон, и обещать
            «ищет сразу» значило бы приписать ленте источник, который в любой
            момент может быть отключён.
          */}
          <EmptyState
            title="Закупок пока нет"
            description="Нажмите «Найти новые закупки»: прогон по бесплатным площадкам выполнит сервер в России, и лента наполнится через несколько минут. По расписанию то же повторяется каждые 2 часа."
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
            Первым — то, что человек взял в работу сам: по остальному срок ещё
            не наступил, а здесь уже есть обязательства и дедлайны.
          */}
          <Card
            title="В работе у вас"
            actions={
              <Link href="/pipeline" className="text-[13.5px] text-accent-fg hover:underline">
                Все мои закупки
              </Link>
            }
          >
            {inWork.length === 0 ? (
              <div className="space-y-2">
                <p className="text-[14.5px] text-muted-foreground">
                  Вы пока ничего не взяли в работу.
                </p>
                <p className="text-[14.5px] text-muted-foreground">
                  Откройте закупку из подборки ниже и переведите её в «Интересные» —
                  она появится здесь вместе со сроком подачи.
                </p>
              </div>
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
              title="Разбор готов"
              actions={
                <span className="text-[13.5px] text-muted-foreground">
                  документация прочитана, выводы в карточке
                </span>
              }
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

          {/* Горящие сроки идут выше подборки: пропущенный срок не отыграть,
              а новую закупку можно посмотреть и завтра. */}
          <Card
            title="Горит"
            actions={
              <span className="text-[13.5px] text-muted-foreground">
                подача закрывается в ближайшие {URGENT_DEADLINE_DAYS}{" "}
                {pluralRu(URGENT_DEADLINE_DAYS, ["день", "дня", "дней"])}
              </span>
            }
          >
            {urgent.length === 0 ? (
              <p className="text-[14.5px] text-muted-foreground">
                Горящих сроков нет: в ближайшие {URGENT_DEADLINE_DAYS}{" "}
                {pluralRu(URGENT_DEADLINE_DAYS, ["день", "дня", "дней"])} подача не закрывается.
              </p>
            ) : (
              <ul className="space-y-2">
                {urgent.slice(0, URGENT_SHOWN).map((row) => (
                  <UrgentRow key={row.tender.id} row={row} now={now} />
                ))}
              </ul>
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

          <Card
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
                  {/* Та же панель подтверждения, что и в заголовке: расход
                      платный, поэтому второй запуск без неё невозможен. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setSearchOpen(true)}
                    disabled={syncState.syncing}
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Найти новые закупки
                  </Button>
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

          <Card title="Не подошло — почему">
            {rejected.length === 0 ? (
              <p className="text-[14.5px] text-muted-foreground">Отклонённых закупок нет.</p>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setRejectedOpen((v) => !v)}
                  aria-expanded={rejectedOpen}
                  className="flex w-full items-center justify-between gap-3 text-left"
                >
                  <span className="text-[14.5px] text-muted-foreground">
                    {rejected.length}{" "}
                    {pluralRu(rejected.length, ["закупка", "закупки", "закупок"])} отклонено
                    {mainRejection && (
                      <>
                        {" "}
                        · чаще всего:{" "}
                        <span className="text-foreground">{mainRejection.reason}</span>{" "}
                        <span className="num">({mainRejection.count})</span>
                      </>
                    )}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 text-faint transition-transform",
                      rejectedOpen && "rotate-180",
                    )}
                    aria-hidden
                  />
                </button>
                {rejectedOpen && (
                  <div className="mt-3 border-t border-border pt-3">
                    <ul className="space-y-2.5">
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
                    <Link
                      href="/tenders?verdict=NOT_RECOMMENDED"
                      className="mt-3 inline-flex text-[13.5px] text-accent-fg hover:underline"
                    >
                      Показать все отклонённые
                    </Link>
                  </div>
                )}
              </>
            )}
          </Card>

          <div className="space-y-2">
            <p className="text-[12.5px] text-faint">
              {lastSync ? `Данные на ${formatDateTime(lastSync)}` : "Данные ещё не загружены"} ·{" "}
              {rows.length} {pluralRu(rows.length, ["закупка", "закупки", "закупок"])}
              {sources.length > 0 && <> · источники: {sources.join(", ")}</>}
            </p>
            <DisclaimerAlert />
          </div>
        </div>
      )}
    </div>
  );
}

/* Счётчик в строке заголовка: закрашенная пилюля тона результата. */
function Counter({
  tone,
  label,
  value,
}: {
  tone: "olive" | "mustard" | "brick";
  label: string;
  value: number;
}) {
  const chip = {
    olive: "bg-olive-subtle text-olive-fg",
    mustard: "bg-mustard-subtle text-mustard-fg",
    brick: "bg-brick-subtle text-brick-fg",
  }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[14.5px] font-medium", chip)}>
      {label}: <span className="num font-semibold">{value}</span>
    </span>
  );
}

/* Закупка из блока «Откройте сегодня». */
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
  return (
    <li className="rounded-control border border-border/70 bg-panel px-4 py-3.5 shadow-card transition-shadow hover:shadow-card-hover">
      {/* Вердикт встаёт под заголовок на узком экране: нерастяжимый бейдж
          рядом с названием оставлял названию одно слово. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <Link
            href={`/tenders/${row.tender.id}`}
            className="line-clamp-2 text-[14.5px] font-medium text-foreground hover:text-accent-fg sm:line-clamp-1"
          >
            {row.tender.subject}
          </Link>
          <p className="mt-1 text-[14.5px] text-muted-foreground">
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
      <p className="mt-2 line-clamp-2 text-[14.5px] leading-relaxed text-muted-foreground">
        {fitReason(row)}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14.5px] text-muted-foreground">
          подача до <span className="num">{formatDate(row.tender.deadlines.submissionEnd)}</span>{" "}
          · {formatTimeLeft(row.tender.deadlines.submissionEnd, now)}
        </p>
        <Link
          href={`/tenders/${row.tender.id}`}
          className="inline-flex items-center gap-1 text-[14.5px] font-medium text-accent-fg hover:underline"
        >
          Смотреть <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
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

function UrgentRow({ row, now }: { row: TenderRow; now: Date }) {
  const critical = isCriticalDeadline(row.tender.deadlines.submissionEnd, now);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-control px-1 py-1.5">
      <div className="min-w-0">
        <Link
          href={`/tenders/${row.tender.id}`}
          className="line-clamp-1 text-[15.5px] font-medium text-foreground hover:text-accent-fg"
        >
          {row.tender.subject}
        </Link>
        <p className="mt-0.5 text-[14.5px] text-muted-foreground">
          <span className="num">
            {formatTenderPrice(row.tender.financial.price, row.tender.financial.currency)}
          </span>{" "}
          · до <span className="num">{formatDate(row.tender.deadlines.submissionEnd)}</span> ·{" "}
          {formatTimeLeft(row.tender.deadlines.submissionEnd, now)}
        </p>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full px-2.5 py-1 text-[13.5px] font-medium whitespace-nowrap",
          critical ? "bg-brick-subtle text-brick-fg" : "bg-mustard-subtle text-mustard-fg",
        )}
      >
        {critical ? "Закрывается сегодня" : "Успеть подать"}
      </span>
    </li>
  );
}
