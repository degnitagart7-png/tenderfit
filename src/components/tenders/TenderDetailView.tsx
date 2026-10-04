"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ExternalLink } from "lucide-react";
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
  DisclaimerAlert,
  EvidenceCard,
  FeedbackButtons,
  FindingRow,
  FitScore,
  FitScoreBreakdown,
  HardBlockerCard,
  RiskBadge,
  UncertaintyCard,
  VerdictBadge,
} from "@/components/analysis";
import { ManualReviewPanel } from "@/components/tenders/ManualReviewPanel";
import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import {
  TenderSectionNav,
  TenderSectionNavMobile,
  flattenNavGroups,
  type TenderNavGroup,
} from "@/components/tenders/TenderSectionNav";
import { useActiveSection } from "@/hooks/useActiveSection";
import { cn } from "@/lib/cn";
import { formatCurrency, formatDate, formatDateTime, formatTenderPrice, formatTimeLeft } from "@/utils/format";
import {
  contractRiskCategoryLabels,
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

export function TenderDetailView({ tenderId }: { tenderId: string }) {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [row, setRow] = useState<TenderRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>("NEW");
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [focusDocId, setFocusDocId] = useState<string | null>(null);

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

  /** Структура разделов: группы навигации совпадают с порядком секций на странице. */
  const navGroups = useMemo<TenderNavGroup[]>(() => {
    const isFz223 = row?.tender.law === "FZ_223";
    const hasOperations = Boolean(row?.analysis.operationalFitDetails);
    const analysisSections = [
      { id: "compliance", label: "Соответствие компании" },
      { id: "requirements", label: isFz223 ? "Требования 223-ФЗ" : "Требования" },
      ...(hasOperations ? [{ id: "operations", label: "Операционная оценка" }] : []),
      { id: "evidence", label: "Доказательства" },
      { id: "deep-analysis", label: "Глубокий анализ" },
    ];
    return [
      { title: "Обзор", sections: [{ id: "overview", label: "Обзор" }] },
      { title: "Анализ", sections: analysisSections },
      {
        title: "Финансы и риски",
        sections: [
          { id: "economics", label: "Экономика" },
          { id: "risks", label: "Риски договора" },
          { id: "manual-review", label: "Ручная проверка" },
        ],
      },
      {
        title: "Данные",
        sections: [
          { id: "documents", label: "Документы" },
          { id: "history", label: "История изменений" },
        ],
      },
    ];
  }, [row]);

  const sectionIds = useMemo(
    () => flattenNavGroups(navGroups).map((s) => s.id),
    [navGroups],
  );
  const { activeId: activeSection, selectSection } = useActiveSection(sectionIds);

  /*
    Какие разделы раскрыты. Изначально — только «Обзор»: он отвечает на вопрос
    «подавать или нет», а остальные десять нужны, когда решение уже принято и
    пользователь проверяет детали.
  */
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(["overview"]),
  );

  const toggleSection = (id: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /*
    Переход из якорной навигации раскрывает раздел: иначе клик по «Рискам»
    прокручивал бы к закрытому заголовку, и выглядело бы это как поломка.
    Якорь — сам <section>, он отрисован всегда, поэтому прокрутка попадает
    в цель независимо от того, успело ли раскрыться содержимое.
  */
  const goToSection = (id: string) => {
    setOpenSections((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    selectSection(id);
  };

  /** Развернуть все разделы разом — для печати и сплошного чтения. */
  const expandAll = () => setOpenSections(new Set(sectionIds));
  const allOpen = sectionIds.every((id) => openSections.has(id));

  /** Подсветка и прокрутка к документу, открытому из блока «Доказательства». */
  useEffect(() => {
    if (!focusDocId) return;
    const el = document.getElementById(`doc-${focusDocId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusDocId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = companyProfileRepository.get();
        const r = await tenderApiService.getRowById(tenderId, p);
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

  if (loading) return <LoadingSkeleton rows={8} />;
  if (error) return <ErrorState message={error} />;
  if (!row || !profile) {
    return <ErrorState message="Закупка не найдена" />;
  }

  const { tender, analysis } = row;
  const critical = isCriticalDeadline(tender.deadlines.submissionEnd);

  const findEvidence = (id: string | null): Evidence | undefined =>
    id ? evidenceById.get(id) : undefined;

  /** Переход к документу из доказательства: выделяем файл и прокручиваем к нему. */
  const showInDocument = (e: Evidence) => {
    if (e.documentId) setFocusDocId(e.documentId);
  };

  /*
    Смена стадии воронки — только стадия воронки, без побочных трат.

    Раньше перевод в «Интересное» сам ставил глубокий разбор в очередь, и это
    связывало два несвязанных решения: «эта закупка мне интересна» и «потрать на
    неё разбор документации». Разбор стоит денег (≈6 ₽ за закупку при суточном
    потолке 20) и занимает время воркера, а закупку переводят в работу и для
    того, чтобы просто не потерять её из вида. Теперь разбор запускается только
    кнопкой «Запустить глубокий анализ» в панели на этой же карточке — там, где
    видно состояние очереди и остаток лимита.
  */
  const changePipeline = (status: PipelineStatus, note?: string) => {
    pipelineRepository.setStatus(tender.id, status, note);
    setPipelineStatus(status);
  };

  /*
    Запуск разбора — это и есть решение взять закупку в работу.

    Результат приходит не сразу: документацию качает сервер в России, текст
    разбирает модель. Если закупка осталась в «Новых», вернуться к ней можно
    только вспомнив номер и найдя его среди сотен строк выдачи — на практике
    это означает «не вернуться». Поэтому запуск сам кладёт закупку в
    «Интересные»: там её ждут «Мои закупки» и блок готовых разборов.

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

  return (
    <div className="space-y-4">
      <Link
        href="/tenders"
        className="inline-flex items-center gap-1 text-sm text-accent-fg hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> К списку закупок
      </Link>

      {/* Шапка карточки */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <p className="muted text-xs">
              № {tender.regNumber} · {lawLabels[tender.law]} ·{" "}
              {placingWayLabels[tender.placingWay]}
            </p>
            <h1 className="mt-1.5 text-[22px] font-semibold leading-snug tracking-tight text-foreground">{tender.subject}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Заказчик: {tender.customerName}
              {tender.customerInn ? ` (ИНН ${tender.customerInn})` : ""} · {tender.region}
            </p>
            <div className="flex flex-wrap items-center gap-4 mt-3 text-sm">
              <span className="font-medium text-foreground tabular-nums">
                НМЦК: {formatTenderPrice(tender.financial.price)}
              </span>
              <span className={critical ? "text-brick-fg font-medium" : "text-muted-foreground"}>
                Подача до {formatDate(tender.deadlines.submissionEnd)} (
                {formatTimeLeft(tender.deadlines.submissionEnd)})
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <VerdictBadge verdict={analysis.verdict} />
            <FitScore value={analysis.fitScore} size="lg" />
            <div className="flex items-center gap-2">
              <Select
                value={pipelineStatus}
                onChange={(e) => changePipeline(e.target.value as PipelineStatus)}
                aria-label="Статус воронки"
                className="w-48"
              >
                {pipelineOrder.map((s) => (
                  <option key={s} value={s}>
                    {pipelineLabels[s]}
                  </option>
                ))}
              </Select>
              {tender.eisUrl ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(tender.eisUrl, "_blank")}
                >
                  <ExternalLink className="h-3.5 w-3.5" />{" "}
                  {dataSourceLinkLabels[tender.dataSource]}
                </Button>
              ) : null}
            </div>
            <FeedbackButtons onFeedback={sendFeedback} disabled={feedbackSent} />
            {feedbackSent && <p className="muted text-xs">Спасибо, отзыв учтён.</p>}
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-4 border-t border-border pt-3">
          {analysis.summary}
        </p>
        <div className="mt-3">
          <DisclaimerAlert />
        </div>
      </Card>

      {/* Мобильная якорная навигация: горизонтальный скролл под хедером */}
      <TenderSectionNavMobile
        sections={flattenNavGroups(navGroups)}
        activeId={activeSection}
        onNavigate={goToSection}
      />

      <div className="lg:flex lg:items-start lg:gap-8">
        <TenderSectionNav
          groups={navGroups}
          activeId={activeSection}
          onNavigate={goToSection}
        />

        <div className="min-w-0 flex-1">
          {/* Раскрыт только «Обзор»: остальные разделы — проверка деталей уже
              после решения. Кнопка разворачивает всё разом для сплошного чтения. */}
          {!allOpen && (
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={expandAll}
                className="rounded-control px-2 py-1.5 text-[14.5px] font-medium text-accent-fg hover:underline"
              >
                Развернуть все разделы
              </button>
            </div>
          )}

          <Section id="overview" open={openSections.has("overview")} onToggle={() => toggleSection("overview")} title="Обзор" first>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card title="Почему подходит">
                {analysis.positiveFactors.length === 0 ? (
                  <p className="muted">Выраженных положительных факторов не найдено.</p>
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
                {analysis.negativeFactors.length === 0 ? (
                  <p className="muted">Существенных ограничений не найдено.</p>
                ) : (
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
                )}
              </Card>
              {analysis.hardBlockers.length > 0 && (
                <Card title="Hard blockers" className="lg:col-span-2">
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
                </Card>
              )}
              {analysis.uncertainties.length > 0 && (
                <Card title="Неопределённости" className="lg:col-span-2">
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
                </Card>
              )}
              <Card title="Следующие действия" className="lg:col-span-2">
                {analysis.nextActions.length === 0 ? (
                  <p className="muted">Действий не требуется.</p>
                ) : (
                  <ol className="list-decimal pl-5 space-y-1.5 text-sm text-muted-foreground">
                    {analysis.nextActions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ol>
                )}
              </Card>
            </div>
          </Section>

          <Section id="compliance" open={openSections.has("compliance")} onToggle={() => toggleSection("compliance")} title="Соответствие компании">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card title="Пять показателей соответствия">
                <FitScoreBreakdown scores={analysis.scores} />
                {/* Проценты берутся из SCORE_WEIGHTS, а не печатаются вручную:
                    прежний текст остался со старыми весами и расходился с
                    расчётом после их пересмотра. */}
                <p className="muted text-xs mt-3">
                  Веса: предмет {Math.round(SCORE_WEIGHTS.subjectFit * 100)}%, юридические
                  препятствия {Math.round(SCORE_WEIGHTS.legalEligibility * 100)}%, операционные{" "}
                  {Math.round(SCORE_WEIGHTS.operationalFit * 100)}%, финансы{" "}
                  {Math.round(SCORE_WEIGHTS.financialFit * 100)}%, риск договора{" "}
                  {Math.round(SCORE_WEIGHTS.contractRisk * 100)}% (инвертирован). Уверенность
                  анализа: {Math.round(analysis.confidence * 100)}%.
                </p>
              </Card>
              <Card
                title="Ключевые доказательства"
                actions={
                  <button
                    type="button"
                    onClick={() => goToSection("evidence")}
                    className="text-sm text-accent-fg hover:underline"
                  >
                    Все доказательства ({analysis.evidence.length})
                  </button>
                }
              >
                <div className="space-y-3">
                  {analysis.evidence.slice(0, 4).map((e) => (
                    <EvidenceCard key={e.id} evidence={e} onShowInDocument={showInDocument} />
                  ))}
                </div>
              </Card>
            </div>
          </Section>

          <Section
            id="requirements"
            open={openSections.has("requirements")}
            onToggle={() => toggleSection("requirements")}
            title={isFz223 ? "Требования 223-ФЗ" : "Требования"}
          >
            <div className="space-y-4">
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
              <Card title="Требования к участникам — формулировки из документации">
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
          </Section>

          {analysis.operationalFitDetails && (
            <Section id="operations" open={openSections.has("operations")} onToggle={() => toggleSection("operations")} title="Операционная оценка">
              <Card>
                <p className="muted text-sm mb-4">
                  Оценка возможности исполнения контракта по операционным параметрам.
                </p>
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
              </Card>
            </Section>
          )}

          <Section id="evidence" open={openSections.has("evidence")} onToggle={() => toggleSection("evidence")} meta={`${analysis.evidence.length} записей`} title="Доказательства">
            <Card
              title="Доказательства по выводам системы"
              actions={<span className="muted">{analysis.evidence.length} записей</span>}
            >
              <p className="muted text-sm mb-3">
                Каждый вывод трассируется до источника: факт из документации закупки, данные
                профиля компании, системное правило или вывод AI. «Показать в документе» прокручивает
                к нужному файлу в разделе «Документы».
              </p>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {analysis.evidence.map((e) => (
                  <EvidenceCard key={e.id} evidence={e} onShowInDocument={showInDocument} />
                ))}
              </div>
            </Card>
          </Section>

          <Section id="deep-analysis" open={openSections.has("deep-analysis")} onToggle={() => toggleSection("deep-analysis")} title="Глубокий анализ документации">
            <DeepAnalysisPanel
              tenderId={tender.id}
              dataSource={tender.dataSource}
              subject={tender.subject}
              onStarted={takeIntoWork}
            />
          </Section>

          <Section id="economics" open={openSections.has("economics")} onToggle={() => toggleSection("economics")} title="Экономика">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card title="Финансовые условия">
                <dl className="space-y-2 text-sm">
                  <EconRow label="НМЦК" value={formatTenderPrice(tender.financial.price)} />
                  <EconRow
                    label="Аванс"
                    value={
                      tender.financial.advancePercent != null
                        ? `${tender.financial.advancePercent}%${
                            tender.financial.advanceAmount != null
                              ? ` (${formatCurrency(tender.financial.advanceAmount)})`
                              : ""
                          }`
                        : "не предусмотрен"
                    }
                  />
                  <EconRow
                    label="Срок оплаты"
                    value={`${tender.financial.paymentTermDays} дн.`}
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
                    value={
                      tender.financial.bidSecurityAmount != null
                        ? `${formatCurrency(tender.financial.bidSecurityAmount)}${
                            tender.financial.bidSecurityPercent != null
                              ? ` (${tender.financial.bidSecurityPercent}%)`
                              : ""
                          }`
                        : "не требуется"
                    }
                  />
                  <EconRow
                    label="Обеспечение контракта"
                    value={
                      tender.financial.contractSecurityAmount != null
                        ? `${formatCurrency(tender.financial.contractSecurityAmount)}${
                            tender.financial.contractSecurityPercent != null
                              ? ` (${tender.financial.contractSecurityPercent}%)`
                              : ""
                          }`
                        : "не требуется"
                    }
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
          </Section>

          <Section id="risks" open={openSections.has("risks")} onToggle={() => toggleSection("risks")} meta={
              analysis.contractRisks.length > 0
                ? `${analysis.contractRisks.length} найдено`
                : "не найдены"
            }
            title="Риски договора"
          >
            <Card title="Риски проекта контракта">
              {analysis.contractRisks.length === 0 ? (
                <p className="muted">
                  Типичных рисков не обнаружено. Это не отменяет необходимости прочитать проект
                  контракта целиком.
                </p>
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
          </Section>

          <Section id="manual-review" open={openSections.has("manual-review")} onToggle={() => toggleSection("manual-review")} title="Ручная проверка">
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
          </Section>

          <Section id="documents" open={openSections.has("documents")} onToggle={() => toggleSection("documents")} meta={`${tender.documents.length} файлов`} title="Документы">
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
                        Документ открыт из блока «Доказательства».
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          </Section>

          <Section id="history" open={openSections.has("history")} onToggle={() => toggleSection("history")} title="История изменений">
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
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * Раздел карточки: якорь для навигации плюс сворачивание.
 *
 * Одиннадцать разделов подряд — отчёт аналитика, а не опора для решения
 * «подавать или нет». Развёрнут только «Обзор»; остальные открываются по
 * заголовку или переходом из якорной навигации. Заголовок раздела остаётся
 * h2 с кнопкой внутри — стандартный паттерн раскрытия, при котором раздел
 * по-прежнему доступен и как заголовок, и как элемент управления.
 *
 * scroll-mt-20 (80px) компенсирует sticky-хедер, чтобы заголовок не уходил
 * под него при переходе.
 */
function Section({
  id,
  title,
  meta,
  open,
  onToggle,
  first = false,
  children,
}: {
  id: string;
  title: string;
  /** Короткая сводка в свёрнутом виде: сколько внутри и стоит ли открывать. */
  meta?: string;
  open: boolean;
  onToggle: () => void;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      data-section={id}
      className={cn("scroll-mt-20", !first && "mt-3")}
    >
      <h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-card border border-border/70 bg-panel px-4 py-3.5 text-left shadow-card transition-colors hover:bg-panel-raised/40",
            open && "rounded-b-none border-b-0",
          )}
        >
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <span className="text-[16px] font-semibold tracking-tight text-foreground">
              {title}
            </span>
            {/* Пробел внутри строки, а не только отступ: иначе скринридер
                читает доступное имя слитно — «Риски договоране найдены». */}
            {meta && (
              <span className="text-[14.5px] text-muted-foreground">{` ${meta}`}</span>
            )}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-faint transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </h2>
      {open && (
        <div
          id={`${id}-body`}
          className="rounded-b-card border border-t-0 border-border/70 bg-panel px-4 pb-4 pt-1 shadow-card"
        >
          {children}
        </div>
      )}
    </section>
  );
}

function EconRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="muted">{label}</dt>
      <dd className="text-foreground text-right tabular-nums">{value}</dd>
    </div>
  );
}
