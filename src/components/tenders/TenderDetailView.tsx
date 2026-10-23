"use client";

import { deepRiskCounts } from "@/domain/analysisDigest";
import { summarizeDeepAnalysis } from "@/domain/deepAnalysis";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ExternalLink, Sparkles } from "lucide-react";
import type {
  CompanyProfile,
  Evidence,
  PipelineStatus,
  RequirementGroupStatus,
} from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { isCriticalDeadline, SCORE_WEIGHTS } from "@/domain/scoring";
import { buildRequirementGroups } from "@/domain/requirementsReview";
import { tenderApiService } from "@/services/tenderApiService";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { withSearchRegions } from "@/domain/scoringGeography";
import { pipelineRepository } from "@/repositories/pipelineRepository";
import { feedbackRepository } from "@/repositories/feedbackRepository";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingSkeleton,
  Select,
} from "@/components/ui/primitives";
import {
  EvidenceCard,
  FeedbackButtons,
  FindingRow,
  FitScoreBreakdown,
  HardBlockerCard,
  RiskBadge,
  UncertaintyCard,
} from "@/components/analysis";
import { ManualReviewPanel } from "@/components/tenders/ManualReviewPanel";
import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import {
  TenderTabs,
  resolveTabFromLocation,
  searchForTab,
  tabButtonId,
  tabPanelId,
  type TenderTabId,
} from "@/components/tenders/TenderTabs";
import { VerdictScore, verdictScoreTitle } from "@/components/tenders/VerdictScore";
import { cn } from "@/lib/cn";
import { formatCurrency, formatDate, formatDateTime, formatTenderPrice, formatTimeLeft, pluralRu } from "@/utils/format";
import {
  contractRiskCategoryLabels,
  dataSourceLabels,
  dataSourceLinkLabels,
  evidenceSourceLabels,
  lawLabels,
  pipelineLabels,
  pipelineOrder,
  placingWayLabels,
  requirementKindLabels,
  requirementStatusLabels,
} from "@/lib/labels";

const groupStatusTone: Record<RequirementGroupStatus, "olive" | "mustard" | "brick"> = {
  MATCH: "olive",
  REVIEW: "mustard",
  MISMATCH: "brick",
};

/** Прокрутить к элементу; в окружении без scrollIntoView (тесты) — тихо ничего. */
function scrollToElement(el: HTMLElement | null, block: ScrollLogicalPosition): void {
  if (!el || typeof el.scrollIntoView !== "function") return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block });
}

/**
 * Прокрутить к элементу, когда он появится: панель анализа монтируется при первом открытии
 * вкладки и грузит разбор по сети, поэтому секции рисков в первый момент ещё нет. Ждём до 8 с.
 */
function scrollWhenReady(id: string): void {
  const started = Date.now();
  const timer = setInterval(() => {
    const el = document.getElementById(id);
    if (el !== null || Date.now() - started > 8_000) {
      clearInterval(timer);
      if (el !== null) scrollToElement(el, "start");
    }
  }, 150);
}

export function TenderDetailView({ tenderId }: { tenderId: string }) {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [analysisStartSignal, setAnalysisStartSignal] = useState(0);
  const [row, setRow] = useState<TenderRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>("NEW");
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [focusDocId, setFocusDocId] = useState<string | null>(null);
  /** Риски договора по глубокому анализу: когда он есть, вкладка «Риски договора» считает их, а не быструю оценку. */
  const [deepRisks, setDeepRisks] = useState<{ total: number; high: number } | null>(null);

  /*
    Вкладки. Активная хранится в адресе (`?tab=…`, главная — без параметра) и
    меняется без перезагрузки. Вкладка монтируется при первом открытии и
    дальше только прячется: глубокий анализ держит состояние (ход расчёта,
    введённые параметры), и терять его при переключении нельзя.
  */
  const [tab, setTab] = useState<TenderTabId>("main");
  const [visited, setVisited] = useState<Set<TenderTabId>>(() => new Set(["main"]));
  /** Раскрытые блоки внутри вкладок: «Подробнее об оценке», «Все условия», ручная проверка. */
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(() => new Set());
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const tabsTopRef = useRef<HTMLDivElement>(null);

  const toggleBlock = (id: string) =>
    setOpenBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectTab = useCallback((next: TenderTabId) => {
    setTab(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    // Якорь старой ссылки не оставляем: он уже отработал и спорил бы с вкладкой.
    const url = `${window.location.pathname}${searchForTab(window.location.search, next)}`;
    window.history.replaceState(null, "", url);
    // Вкладки приклеены под шапкой: если страница прокручена, возвращаем начало
    // вкладки в поле зрения, а не оставляем читателя посреди чужого текста.
    const top = tabsTopRef.current;
    if (top && top.getBoundingClientRect().top < 62) scrollToElement(top, "start");
  }, []);

  /** Адрес при открытии и смене якоря: `?tab=` или старый якорь вроде `#deep-analysis`. */
  useEffect(() => {
    const apply = () => {
      const target = resolveTabFromLocation(window.location.search, window.location.hash);
      setTab(target.tab);
      setVisited((prev) => (prev.has(target.tab) ? prev : new Set(prev).add(target.tab)));
      if (target.block) {
        const block = target.block;
        setOpenBlocks((prev) => (prev.has(block) ? prev : new Set(prev).add(block)));
      }
      if (target.anchor) setPendingAnchor(target.anchor);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  /** Прокрутка к якорю после того, как вкладка и блок уже отрисованы. */
  useEffect(() => {
    if (!pendingAnchor || loading) return;
    scrollToElement(document.getElementById(pendingAnchor), "start");
    setPendingAnchor(null);
  }, [pendingAnchor, tab, openBlocks, loading]);

  const evidenceById = useMemo(
    () => new Map((row?.analysis.evidence ?? []).map((e) => [e.id, e])),
    [row],
  );
  const requirementGroups = useMemo(
    () =>
      row && profile
        ? buildRequirementGroups(row.tender, row.analysis, profile)
        : [],
    [row, profile],
  );

  /** Подсветка и прокрутка к документу, открытому из «Показать в документе». */
  useEffect(() => {
    if (!focusDocId || tab !== "docs") return;
    scrollToElement(document.getElementById(`doc-${focusDocId}`), "center");
  }, [focusDocId, tab]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = companyProfileRepository.get();
        // Та же география, что у ленты: иначе оценка в карточке и в списке разойдётся.
        const r = await tenderApiService.getRowById(
          tenderId,
          withSearchRegions(p, searchProfileRepository.getAll()),
        );
        if (cancelled) return;
        setProfile(p);
        setRow(r);
        if (r) {
          setPipelineStatus(r.pipelineStatus);
          setFeedbackSent(feedbackRepository.forTender(tenderId) !== null);
        }
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Неизвестная ошибка");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenderId]);

  /*
    Число на вкладке видно сразу, а панель анализа монтируется только при открытии своей
    вкладки, — поэтому итог разбора читаем здесь же, тем же расчётом, что и панель
    (`summarizeDeepAnalysis`: те же правила отсева типового). Ошибка — остаётся быстрая оценка.
  */
  const rowTender = row?.tender ?? null;
  useEffect(() => {
    if (rowTender === null) return;
    let cancelled = false;
    void deepAnalysisService
      .getStatus(rowTender.id)
      .then((status) => {
        if (cancelled) return;
        const counts = deepRiskCounts(
          summarizeDeepAnalysis({
            ...status,
            dataSource: rowTender.dataSource,
            price: rowTender.financial.price ?? null,
            law: rowTender.law ?? null,
          }),
        );
        if (counts !== null) setDeepRisks(counts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rowTender]);

  if (loading) return <LoadingSkeleton rows={8} />;
  if (error) return <ErrorState message={error} />;
  if (!row || !profile) {
    return <ErrorState message="Закупка не найдена" />;
  }

  const { tender, analysis } = row;
  const critical = isCriticalDeadline(tender.deadlines.submissionEnd);

  const findEvidence = (id: string | null): Evidence | undefined =>
    id ? evidenceById.get(id) : undefined;

  /** Переход к документу из доказательства: открываем «Документы» и выделяем файл. */
  const showInDocument = (e: Evidence) => {
    if (!e.documentId) return;
    setFocusDocId(e.documentId);
    selectTab("docs");
  };

  /*
    Смена стадии воронки — только стадия воронки, без побочных трат.

    Раньше перевод в «Интересное» сам ставил глубокий разбор в очередь, и это
    связывало два несвязанных решения: «эта закупка мне интересна» и «потрать на
    неё разбор документации». Разбор стоит денег и занимает время воркера, а
    закупку переводят в работу и для того, чтобы просто не потерять её из вида.
    Теперь разбор запускается только кнопкой «Запустить глубокий анализ» в
    панели на вкладке «Анализ документов» — там, где видно состояние очереди и
    остаток лимита.
  */
  const changePipeline = (status: PipelineStatus, note?: string) => {
    pipelineRepository.setStatus(tender.id, status, note);
    setPipelineStatus(status);
  };

  /*
    Запуск разбора — это и есть решение взять закупку в работу.

    Результат приходит не сразу: документацию качает сервер в России, текст
    разбирает модель. Если закупка осталась в «Новых», вернуться к ней можно
    только вспомнив номер и найдя его среди сотен строк выдачи. Поэтому запуск
    сам кладёт закупку в «Интересные».

    Только из «Новых»: если закупка уже дальше по воронке — готовим заявку или
    подали её — возврат в «Интересные» был бы откатом чужого решения.
  */
  const takeIntoWork = () => {
    if (pipelineStatus !== "NEW") return;
    changePipeline("INTERESTING");
  };

  const sendFeedback = (useful: boolean) => {
    feedbackRepository.add(tender.id, analysis.verdict, useful);
    setFeedbackSent(true);
  };

  const isFz223 = tender.law === "FZ_223";
  const hasBlockers = analysis.hardBlockers.length > 0;
  const hasUncertainties = analysis.uncertainties.length > 0;
  const hasNegatives = analysis.negativeFactors.length > 0;
  const nothingAgainst = !hasBlockers && !hasUncertainties && !hasNegatives;
  const countdownText = formatTimeLeft(tender.deadlines.submissionEnd);

  const panelClass = (id: TenderTabId) => cn("space-y-4 pt-4", tab !== id && "hidden");

  return (
    <div className="space-y-4">
      <Link
        href="/tenders"
        className="inline-flex items-center gap-1 text-sm text-accent-fg hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> К списку закупок
      </Link>

      {/* Шапка: что за закупка, сколько стоит и до какого срока, подходит ли нам. */}
      <Card>
        {/*
          Название на всю ширину, факты строкой под ним. Колонкой справа факты
          съедали половину карточки: на 1280px название сжималось до ~210px и
          обрезалось на третьей строке, заказчик — на первых словах.
        */}
        <div className="grid gap-y-4">
          <div className="min-w-0">
            <p className="muted text-xs">
              № {tender.regNumber} · {lawLabels[tender.law]} ·{" "}
              {placingWayLabels[tender.placingWay]} · {dataSourceLabels[tender.dataSource]}
            </p>
            <h1
              // Карточка — единственное место, где название читается целиком: три строки
              // обрывали его на полуслове («…Шовгеновского муниципального…»). Предел в
              // шесть строк оставлен для перечней на полстраницы.
              className="mt-1.5 line-clamp-6 text-[22px] font-semibold leading-snug tracking-tight text-foreground"
              title={tender.subject}
            >
              {tender.subject}
            </h1>
            <p
              className="mt-1 line-clamp-2 text-sm text-muted-foreground"
              title={`${tender.customerName}${tender.customerInn ? ` (ИНН ${tender.customerInn})` : ""} · ${tender.region}`}
            >
              {tender.customerName} · {tender.region}
            </p>
          </div>
          <dl className="flex flex-wrap items-start gap-x-10 gap-y-3 rounded-lg bg-panel-raised px-4 py-3">
            <div>
              <dt className="text-xs text-faint">НМЦК</dt>
              <dd className="num mt-0.5 text-[18px] font-semibold text-foreground">
                {formatTenderPrice(tender.financial.price)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Подача до</dt>
              <dd
                className="mt-0.5 text-[15.5px] text-foreground"
                title={formatDateTime(tender.deadlines.submissionEnd)}
              >
                <span className="num font-medium">{formatDate(tender.deadlines.submissionEnd)}</span>
                <span
                  className={cn(
                    "block text-sm",
                    critical ? "font-medium text-brick-fg" : "text-muted-foreground",
                  )}
                  data-testid="deadline-countdown"
                >
                  {countdownText}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Оценка</dt>
              <dd
                className="mt-0.5 flex items-center"
                title={verdictScoreTitle(analysis.verdict, analysis.fitScore)}
              >
                <VerdictScore
                  verdict={analysis.verdict}
                  fitScore={analysis.fitScore}
                  layout="inline"
                />
              </dd>
            </div>
          </dl>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {/* Одно нажатие: запускает разбор, если он ещё не шёл, и сразу открывает
              вкладку с ходом работы. Раньше кнопка только переключала вкладку, и на
              ней приходилось нажимать «Запустить» второй раз. */}
          <Button
            size="sm"
            onClick={() => {
              setAnalysisStartSignal((n) => n + 1);
              selectTab("analysis");
            }}
            title="Запустить анализ документации или открыть результат"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Глубокий анализ
          </Button>
          {tender.eisUrl ? (
            <a
              href={tender.eisUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-accent-line px-3.5 py-1.5 text-[14.5px] font-medium text-accent-fg transition-colors hover:bg-accent-subtle focus:outline-none focus:ring-2 focus:ring-accent/35"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {dataSourceLinkLabels[tender.dataSource]}
            </a>
          ) : null}
          <Select
            value={pipelineStatus}
            onChange={(e) => changePipeline(e.target.value as PipelineStatus)}
            aria-label="Статус закупки"
            title="Статус в разделе «Мои закупки»"
            className="w-full sm:ml-auto sm:w-48"
          >
            {pipelineOrder.map((s) => (
              <option key={s} value={s}>
                {pipelineLabels[s]}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {/* Итог одной строкой: без рамки, оговорка про оценку стоит в подвале страницы. */}
      <p className="line-clamp-2 text-[15px] text-muted-foreground" title={analysis.summary}>
        {analysis.summary}
      </p>

      <div ref={tabsTopRef} className="scroll-mt-[62px]" />
      <TenderTabs
        active={tab}
        onSelect={selectTab}
        counts={{ risks: deepRisks?.total ?? analysis.contractRisks.length, docs: tender.documents.length }}
      />

      {/* ============================== Главное ============================== */}
      <div
        id={tabPanelId("main")}
        role="tabpanel"
        aria-labelledby={tabButtonId("main")}
        hidden={tab !== "main"}
        className={panelClass("main")}
      >
        <div id="overview" className="grid scroll-mt-32 grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Почему подходит">
            {analysis.positiveFactors.length === 0 ? (
              <p className="muted">Выраженных плюсов не найдено.</p>
            ) : (
              <ul className="space-y-2.5">
                {analysis.positiveFactors.map((f) => (
                  <FindingRow
                    key={f.id}
                    text={f.text}
                    evidence={findEvidence(f.evidenceId)}
                    onShowInDocument={showInDocument}
                  />
                ))}
              </ul>
            )}
          </Card>
          <Card title="Почему может не подойти">
            {nothingAgainst ? (
              <p className="muted">Существенных ограничений не найдено.</p>
            ) : (
              <div className="space-y-4">
                {hasBlockers && (
                  <div>
                    <h3 className="mb-2 text-[13.5px] font-semibold text-foreground">
                      Что мешает участвовать
                    </h3>
                    <div className="space-y-2">
                      {analysis.hardBlockers.map((b) => (
                        <HardBlockerCard
                          key={b.id}
                          blocker={b}
                          evidence={findEvidence(b.evidenceId)}
                          onShowInDocument={showInDocument}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {hasNegatives && (
                  <div>
                    {(hasBlockers || hasUncertainties) && (
                      <h3 className="mb-2 text-[13.5px] font-semibold text-foreground">Замечания</h3>
                    )}
                    <ul className="space-y-2.5">
                      {analysis.negativeFactors.map((f) => (
                        <FindingRow
                          key={f.id}
                          text={f.text}
                          evidence={findEvidence(f.evidenceId)}
                          onShowInDocument={showInDocument}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                {hasUncertainties && (
                  <div>
                    <h3 className="mb-2 text-[13.5px] font-semibold text-foreground">Что неясно</h3>
                    <div className="space-y-2">
                      {analysis.uncertainties.map((u) => (
                        <UncertaintyCard
                          key={u.id}
                          uncertainty={u}
                          evidence={findEvidence(u.evidenceId)}
                          onShowInDocument={showInDocument}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>

        <Card title="Что делать дальше">
          {analysis.nextActions.length === 0 ? (
            <p className="muted">Действий не требуется.</p>
          ) : (
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              {analysis.nextActions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Деньги и сроки">
          <dl className="grid grid-cols-1 gap-x-10 gap-y-2 text-sm md:grid-cols-2">
            <EconRow
              label="Обеспечение заявки"
              quote={tender.documentTerms?.bidSecurity?.quote}
              value={securityValue(
                tender.financial.bidSecurityAmount,
                tender.financial.bidSecurityPercent,
                tender.documentTerms?.bidSecurity?.required === false,
              )}
            />
            <EconRow
              label="Обеспечение контракта"
              quote={tender.documentTerms?.contractSecurity?.quote}
              value={securityValue(
                tender.financial.contractSecurityAmount,
                tender.financial.contractSecurityPercent,
                tender.documentTerms?.contractSecurity?.required === false,
              )}
            />
            <EconRow
              label="Аванс"
              quote={tender.documentTerms?.advance?.quote}
              value={
                tender.financial.advancePercent != null
                  ? `${tender.financial.advancePercent}%${
                      tender.financial.advanceAmount != null
                        ? ` (${formatCurrency(tender.financial.advanceAmount)})`
                        : ""
                    }`
                  : tender.documentTerms?.advance?.required === false
                    ? "не предусмотрен"
                    : "нет данных"
              }
            />
            <EconRow label="Срок оплаты" value={paymentTermText(tender.financial.paymentTermDays)} />
            <EconRow
              label="Срок исполнения"
              value={
                tender.deadlines.deliveryTermDays != null
                  ? `${tender.deadlines.deliveryTermDays} дн.`
                  : "не указан"
              }
            />
            <EconRow
              label="Окончание подачи"
              value={`${formatDateTime(tender.deadlines.submissionEnd)}${
                critical ? " — менее 24 часов!" : ""
              }`}
            />
          </dl>
          <Disclosure
            id="economics"
            title="Все условия и сроки"
            open={openBlocks.has("all-terms")}
            onToggle={() => toggleBlock("all-terms")}
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card title="Финансовые условия">
                <dl className="space-y-2 text-sm">
                  <EconRow label="НМЦК" value={formatTenderPrice(tender.financial.price)} />
                  {/*
                    Пустое поле — «нет данных», а не «не требуется»: ЕИС и
                    большинство площадок этих реквизитов не отдают, и прежняя
                    подпись утверждала отсутствие обеспечения там, где оно было.
                    «Не требуется» печатается, только когда так написано в
                    документации, — с цитатой.
                  */}
                  <EconRow
                    label="Аванс"
                    quote={tender.documentTerms?.advance?.quote}
                    value={
                      tender.financial.advancePercent != null
                        ? `${tender.financial.advancePercent}%${
                            tender.financial.advanceAmount != null
                              ? ` (${formatCurrency(tender.financial.advanceAmount)})`
                              : ""
                          }`
                        : tender.documentTerms?.advance?.required === false
                          ? "не предусмотрен"
                          : "нет данных"
                    }
                  />
                  <EconRow
                    label="Срок оплаты"
                    value={paymentTermText(tender.financial.paymentTermDays)}
                  />
                  <EconRow
                    label="Постоплата"
                    value={
                      tender.financial.postpaymentDays != null
                        ? `${tender.financial.postpaymentDays} дн.`
                        : "—"
                    }
                  />
                  <EconRow
                    label="Обеспечение заявки"
                    quote={tender.documentTerms?.bidSecurity?.quote}
                    value={securityValue(
                      tender.financial.bidSecurityAmount,
                      tender.financial.bidSecurityPercent,
                      tender.documentTerms?.bidSecurity?.required === false,
                    )}
                  />
                  <EconRow
                    label="Обеспечение контракта"
                    quote={tender.documentTerms?.contractSecurity?.quote}
                    value={securityValue(
                      tender.financial.contractSecurityAmount,
                      tender.financial.contractSecurityPercent,
                      tender.documentTerms?.contractSecurity?.required === false,
                    )}
                  />
                  <EconRow
                    label="Казначейское сопровождение"
                    value={tender.financial.treasurySupport ? "да" : "нет"}
                  />
                  <EconRow
                    label="Ожидаемая маржинальность"
                    value={
                      tender.financial.expectedMarginPercent != null
                        ? `${tender.financial.expectedMarginPercent}%`
                        : "не оценена"
                    }
                  />
                </dl>
              </Card>
              <Card title="Сроки">
                <dl className="space-y-2 text-sm">
                  <EconRow
                    label="Размещено"
                    value={formatDate(tender.deadlines.publicationDate)}
                  />
                  <EconRow
                    label="Обновлено"
                    value={formatDate(tender.deadlines.lastUpdateDate)}
                  />
                  <EconRow
                    label="Окончание подачи"
                    value={`${formatDateTime(tender.deadlines.submissionEnd)}${
                      critical ? " — менее 24 часов!" : ""
                    }`}
                  />
                  <EconRow
                    label="Срок поставки"
                    value={
                      tender.deadlines.deliveryTermDays != null
                        ? `${tender.deadlines.deliveryTermDays} дн.`
                        : "не указан"
                    }
                  />
                  <EconRow
                    label="Гарантия"
                    value={
                      tender.deadlines.warrantyMonths != null
                        ? `${tender.deadlines.warrantyMonths} мес.`
                        : "не указана"
                    }
                  />
                  <EconRow label="Место поставки" value={tender.deliveryAddress || tender.region} />
                </dl>
                {tender.lots.length > 0 && (
                  <div className="mt-4 border-t border-border pt-3">
                    <p className="label mb-2">Лоты</p>
                    <ul className="space-y-2 text-sm">
                      {tender.lots.map((lot) => (
                        <li key={lot.id} className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">
                            № {lot.number}: {lot.subject}
                          </span>
                          <span className="tabular-nums text-foreground">
                            {formatTenderPrice(lot.price)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            </div>
          </Disclosure>
        </Card>

        <Disclosure
          id="manual-review"
          card
          title="Проверить вручную и принять решение"
          open={openBlocks.has("manual-review")}
          onToggle={() => toggleBlock("manual-review")}
        >
          <ManualReviewPanel
            tenderId={tender.id}
            systemVerdict={analysis.verdict}
            onDecided={(outcome) => {
              if (outcome === "CONFIRMED") {
                changePipeline("INTERESTING", "Подтверждено вручную");
              } else if (outcome === "REJECTED") {
                changePipeline("SKIPPED", "Отклонено вручную");
              }
            }}
          />
        </Disclosure>

        <Disclosure
          id="compliance"
          card
          title="Подробнее об оценке"
          open={openBlocks.has("score-details")}
          onToggle={() => toggleBlock("score-details")}
        >
          <div className="space-y-4">
            <div>
              <FitScoreBreakdown scores={analysis.scores} />
              {/* Проценты берутся из SCORE_WEIGHTS, а не печатаются вручную:
                  прежний текст остался со старыми весами и расходился с
                  расчётом после их пересмотра. */}
              <p className="muted mt-3 text-xs">
                Вес в оценке: предмет {Math.round(SCORE_WEIGHTS.subjectFit * 100)}%, препятствия{" "}
                {Math.round(SCORE_WEIGHTS.legalEligibility * 100)}%, исполнение{" "}
                {Math.round(SCORE_WEIGHTS.operationalFit * 100)}%, финансы{" "}
                {Math.round(SCORE_WEIGHTS.financialFit * 100)}%, риск договора{" "}
                {Math.round(SCORE_WEIGHTS.contractRisk * 100)}%. Уверенность анализа:{" "}
                {Math.round(analysis.confidence * 100)}%.
              </p>
            </div>
            {analysis.operationalFitDetails && (
              <div id="operations" className="scroll-mt-32 border-t border-border pt-4">
                <h3 className="mb-3 text-[13.5px] font-semibold text-foreground">
                  Сможем ли выполнить
                </h3>

                <ul className="space-y-3">
                  {Object.entries(analysis.operationalFitDetails).map(([key, item]) => (
                    <li key={key} className="flex items-start gap-3">
                      <span
                        className={cn(
                          "mt-0.5 h-2 w-2 rounded-full shrink-0",
                          item.ok ? "bg-olive-500" : "bg-brick-500",
                        )}
                      />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-foreground">
                          {key === "deliveryTerm" && "Срок поставки"}
                          {key === "geography" && "География"}
                          {key === "personnel" && "Персонал"}
                          {key === "equipment" && "Техника и оборудование"}
                          {key === "logistics" && "Логистика и склад"}
                          {key === "resources" && "Ресурсы на выполнение"}
                        </p>
                        <p className="text-sm text-muted-foreground mt-0.5">{item.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>

              </div>
            )}
            <div id="evidence" className="scroll-mt-32 border-t border-border pt-4">
              <h3 className="mb-3 text-[13.5px] font-semibold text-foreground">
                Все доказательства{" "}
                <span className="font-normal text-muted-foreground">({analysis.evidence.length})</span>
              </h3>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {analysis.evidence.map((e) => (
                  <EvidenceCard key={e.id} evidence={e} onShowInDocument={showInDocument} />
                ))}
              </div>
            </div>
          </div>
        </Disclosure>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
          <FeedbackButtons onFeedback={sendFeedback} disabled={feedbackSent} />
          {feedbackSent && <p className="muted text-xs">Спасибо, отзыв учтён.</p>}
        </div>
      </div>

      {/* ========================== Анализ документов ========================== */}
      <div
        id={tabPanelId("analysis")}
        role="tabpanel"
        aria-labelledby={tabButtonId("analysis")}
        hidden={tab !== "analysis"}
        className={panelClass("analysis")}
      >
        {visited.has("analysis") && (
          <>
            <div id="deep-analysis" className="scroll-mt-32">
              <DeepAnalysisPanel
                tenderId={tender.id}
                dataSource={tender.dataSource}
                subject={tender.subject}
                onStarted={takeIntoWork}
                tender={tender}
                profile={profile}
                startSignal={analysisStartSignal}
                onRiskCounts={setDeepRisks}
              />
            </div>

            <div id="requirements" className="scroll-mt-32 space-y-4">
              <h2 className="pt-2 text-[16px] font-semibold tracking-tight text-foreground">
                {isFz223 ? "Требования 223-ФЗ" : "Требования к участникам"}
              </h2>
              {isFz223 && analysis.fz223Specific && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <Card title="Положение о закупке" className="lg:col-span-2">
                    <p className="text-sm text-muted-foreground">
                      {analysis.fz223Specific.regulationSummary}
                    </p>
                  </Card>
                  <Card title="Специальные требования заказчика">
                    {analysis.fz223Specific.customerRequirements.length === 0 ? (
                      <p className="muted">Специальные требования не установлены.</p>
                    ) : (
                      <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
                        {analysis.fz223Specific.customerRequirements.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  <Card title="Нестандартные критерии оценки">
                    <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
                      {analysis.fz223Specific.nonStandardCriteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </Card>
                  <Card title="Отличия от 44-ФЗ" className="lg:col-span-2">
                    <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
                      {analysis.fz223Specific.differencesFrom44.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </Card>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {requirementGroups.map((g) => (
                  <Card key={g.key}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-sm font-semibold text-foreground">{g.title}</p>
                      <Badge tone={groupStatusTone[g.status]}>
                        {requirementStatusLabels[g.status]}
                      </Badge>
                    </div>
                    {g.items.length === 0 ? (
                      <p className="muted text-sm">Условий в этой группе не обнаружено.</p>
                    ) : (
                      <ul className="space-y-2">
                        {g.items.map((item) => {
                          const ev = findEvidence(item.evidenceId);
                          return (
                            <li
                              key={item.id}
                              className="flex items-start justify-between gap-2 border-b border-border/60 pb-2 last:border-0 last:pb-0"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-foreground">{item.label}</p>
                                <p className="text-xs text-muted-foreground mt-0.5">{item.value}</p>
                                {ev && (
                                  <button
                                    type="button"
                                    onClick={() => showInDocument(ev)}
                                    className="text-xs text-accent-fg hover:underline mt-0.5"
                                  >
                                    Показать в документе
                                  </button>
                                )}
                              </div>
                              <Badge tone={groupStatusTone[item.status]} dot={false}>
                                {requirementStatusLabels[item.status]}
                              </Badge>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Card>
                ))}
              </div>
              <Card title="Формулировки из документации">
                {analysis.requirements.length === 0 ? (
                  <p className="muted">Особых требований не обнаружено.</p>
                ) : (
                  <ul className="space-y-3">
                    {analysis.requirements.map((r) => (
                      <li key={r.id} className="rounded-control border border-border bg-panel p-3.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-foreground">{r.title}</span>
                          <span className="muted text-xs">
                            {requirementKindLabels[r.kind]}
                            {r.mandatory ? " · обязательно" : ""}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{r.description}</p>
                        {r.evidenceId && (
                          <p className="muted text-xs mt-1">
                            Источник: {findEvidence(r.evidenceId)?.documentTitle ?? "документ закупки"}
                            {` · стр. ${findEvidence(r.evidenceId)?.page ?? "—"}`}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Обязательные документы">
                <ul className="space-y-2">
                  {analysis.requiredDocuments.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-muted-foreground">{d.title}</span>
                      <span
                        className={
                          d.confirmedInProfile
                            ? "text-olive-fg text-xs font-medium"
                            : "text-mustard-fg text-xs font-medium"
                        }
                      >
                        {d.confirmedInProfile ? "Есть в профиле" : "Не подтверждён"}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </>
        )}
      </div>

      {/* ============================ Риски договора ============================ */}
      <div
        id={tabPanelId("risks")}
        role="tabpanel"
        aria-labelledby={tabButtonId("risks")}
        hidden={tab !== "risks"}
        className={panelClass("risks")}
      >
        <div id="risks" className="scroll-mt-32 space-y-4">
            {deepRisks !== null && (
              <div className="border-l-[3px] border-accent pl-4" data-testid="deep-risks-note">
                <p className="text-[15px] font-medium text-foreground">
                  Глубокий анализ документации: {deepRisks.total}{" "}
                  {pluralRu(deepRisks.total, ["риск", "риска", "рисков"])} договора
                  {deepRisks.high > 0 ? `, из них высоких ${String(deepRisks.high)}` : ""}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    selectTab("analysis");
                    scrollWhenReady("analysis-risks");
                  }}
                  className="mt-1 text-[14px] text-accent-fg underline underline-offset-4 hover:no-underline"
                >
                  Открыть риски в анализе документов
                </button>
              </div>
            )}
            <Card title={deepRisks !== null ? "Быстрая оценка по извещению" : "Риски проекта контракта"}>
              {analysis.contractRisks.length === 0 ? (
                <p className="muted">Типичных рисков не найдено. Проект контракта всё равно прочитайте.</p>
              ) : (
                <div className="space-y-4">
                  {/* Группировка по категориям */}
                  {Object.entries(
                    analysis.contractRisks.reduce<Record<string, typeof analysis.contractRisks>>(
                      (acc, r) => {
                        const cat = r.category ?? "OTHER";
                        if (!acc[cat]) acc[cat] = [];
                        acc[cat].push(r);
                        return acc;
                      },
                      {},
                    ),
                  ).map(([category, risks]) => (
                    <div key={category}>
                      <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
                        {category === "OTHER"
                          ? "Прочие риски"
                          : contractRiskCategoryLabels[category as keyof typeof contractRiskCategoryLabels]}
                      </p>
                      <ul className="space-y-3">
                        {risks.map((r) => (
                          <li key={r.id} className="rounded-control border border-border bg-panel p-3.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium text-foreground">{r.title}</span>
                              <RiskBadge severity={r.severity} />
                            </div>
                            <p className="text-sm text-muted-foreground mt-1">{r.detail}</p>
                            {(() => {
                              const ev = findEvidence(r.evidenceId);
                              if (!ev) return null;
                              return (
                                <p className="muted text-xs mt-1">
                                  Источник: {ev.documentTitle ?? evidenceSourceLabels[ev.source]}
                                  {ev.page != null ? ` · стр. ${ev.page}` : ""}
                                  {ev.section ? ` · ${ev.section}` : ""}
                                  {ev.documentId && (
                                    <button
                                      type="button"
                                      className="ml-2 text-accent-fg hover:underline"
                                      onClick={() => showInDocument(ev)}
                                    >
                                      Показать в документе
                                    </button>
                                  )}
                                </p>
                              );
                            })()}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </Card>
        </div>
      </div>

      {/* ============================== Документы ============================== */}
      <div
        id={tabPanelId("docs")}
        role="tabpanel"
        aria-labelledby={tabButtonId("docs")}
        hidden={tab !== "docs"}
        className={panelClass("docs")}
      >
        <div id="documents" className="scroll-mt-32">
            <Card title="Документы закупки">
              <ul className="space-y-3">
                {tender.documents.map((d) => (
                  <li
                    key={d.id}
                    id={`doc-${d.id}`}
                    className={
                      focusDocId === d.id
                        ? "rounded-control border-2 border-accent bg-accent-subtle p-3.5 scroll-mt-24"
                        : "rounded-control border border-border bg-panel p-3.5"
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{d.title}</span>
                      <span className="muted text-xs">
                        {d.fileName}
                        {d.pageCount != null ? ` · ${d.pageCount} стр.` : ""}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">{d.text}</p>
                    {focusDocId === d.id && (
                      <p className="text-xs text-accent-fg mt-1">
                        Открыт по ссылке «Показать в документе».
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
        </div>
        <div id="history" className="scroll-mt-32">
            <Card title="История изменений документации">
              {tender.changeLog.length === 0 ? (
                <p className="muted">Документация не изменялась.</p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {tender.changeLog.map((c, i) => (
                    <li key={i} className="rounded-control border border-border bg-panel p-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="muted shrink-0 tabular-nums">{formatDate(c.date)}</span>
                        <div className="flex gap-1.5">
                          {c.critical && (
                            <Badge tone="brick" dot={false}>
                              Критическое
                            </Badge>
                          )}
                          {c.affectedVerdict && (
                            <Badge tone="mustard" dot={false}>
                              Влияет на вердикт
                            </Badge>
                          )}
                          {c.requiresRecheck && (
                            <Badge tone="accent" dot={false}>
                              Требуется перепроверка
                            </Badge>
                          )}
                        </div>
                      </div>
                      <p className="text-muted-foreground mt-1">{c.description}</p>
                      {c.documentId && (
                        <p className="muted text-xs mt-1">
                          Документ: {tender.documents.find((d) => d.id === c.documentId)?.title ?? c.documentId}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * Раскрывающийся блок внутри вкладки.
 *
 * Содержимое монтируется только когда блок открыт. Якорь — сам внешний
 * элемент, поэтому он на месте и у закрытого блока.
 */
function Disclosure({
  id,
  title,
  open,
  onToggle,
  card = false,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Рамка и тень, как у карточки: блок стоит самостоятельно, а не внутри карточки. */
  card?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn("scroll-mt-32", card ? "card" : "mt-4 border-t border-border pt-3")}
    >
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          className={cn(
            "flex w-full items-center justify-between gap-3 text-left text-[14.5px] font-medium text-accent-fg hover:underline",
            card && "px-5 py-3.5",
          )}
        >
          {title}
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-faint transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </h3>
      {open && (
        <div id={`${id}-body`} className={cn(card ? "border-t border-border px-5 py-4" : "pt-3")}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Сумма и процент обеспечения; без данных — честное «нет данных». */
function securityValue(
  amount: number | null,
  percent: number | null,
  notRequired: boolean,
): string {
  if (amount != null) {
    return `${formatCurrency(amount)}${percent != null ? ` (${percent}%)` : ""}`;
  }
  if (percent != null) return `${percent}%`;
  return notRequired ? "не требуется" : "нет данных";
}

function EconRow({
  label,
  value,
  quote,
}: {
  label: string;
  value: string;
  /** Фраза документации, из которой взято значение; нет — реквизит площадки. */
  quote?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="muted">{label}</dt>
      <dd className="text-foreground text-right tabular-nums">
        {value}
        {quote && (
          <span
            className="block cursor-help text-[11px] text-faint underline decoration-dotted underline-offset-2"
            title={`«${quote}»`}
          >
            из документации
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * Срок оплаты для строки «Деньги и сроки». Площадки срока не отдают, и разбор
 * ставит 0: «0 дн.» рядом с «нет данных» у соседних строк читалось как оплата в
 * день подписания (проверка 24.10.2026). Ноль — это отсутствие данных.
 */
function paymentTermText(days: number | null | undefined): string {
  return days != null && days > 0 ? `${days} дн.` : "нет данных";
}
