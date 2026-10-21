"use client";

import { KONTUR_ENABLED } from "@/domain/features";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { WorkProgress } from "@/components/ui/WorkProgress";
import { analysisDecision, type AnalysisDecision } from "@/domain/analysisDecision";
import { Fold } from "@/components/ui/Fold";
import { CalendarClock, Calculator, Download, ExternalLink, MessageCircleQuestion, RefreshCw, ShieldAlert } from "lucide-react";
import { EstimateResult } from "@/components/estimate/EstimateResult";
import { useEstimateAuditJob, useEstimateJob } from "@/hooks/useEstimateJob";
import { marksOf, useBillEdits } from "@/hooks/useBillEdits";
import { CustomerAuditCard } from "@/components/estimate/CustomerAuditCard";
import { AuditBidEconomics } from "@/components/estimate/AuditBidEconomics";
import { persistCostProfile } from "@/hooks/useCompanyCostProfile";
import { effectiveMinMargin } from "@/domain/estimate/companyCostProfile";
import { SsrAuditCard } from "@/components/estimate/SsrAuditCard";
import { computeSsrLayer } from "@/domain/estimate/ssrLayer";
import { usePriceZones } from "@/hooks/usePriceZones";
import { PriceZonePicker } from "@/components/estimate/PriceZonePicker";
import { EstimateMethodSelect } from "@/components/estimate/EstimateMethodSelect";
import { WorkConditionsBlock } from "@/components/estimate/WorkConditionsBlock";
import { hasEstimateOptions, NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { computeAssurance } from "@/domain/estimate/assurance";
import { computeEstimateConfidence } from "@/domain/estimate/estimateConfidence";
import { computeBidEconomics, type BidEconomics } from "@/domain/estimate/bidEconomics";
import { detectVatStatus } from "@/domain/estimate/vatStatus";
import { parseCustomerEstimates } from "@/domain/estimate/customerEstimate";
import { compareWithCustomerEstimate } from "@/domain/estimate/customerComparison";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { summarizeCustomerConditions } from "@/domain/estimate/customerCoefficients";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet, lsrSourceInfo } from "@/domain/estimate/customerLsrSet";
import { DAILY_ANALYSIS_LIMIT } from "@/domain/analysisQuota";
import { cn } from "@/lib/cn";
import {
  deepAnalysisFingerprint,
  groupDocuments,
  summarizeDeepAnalysis,
  type DeepAnalysisState,
  type DeepAnalysisSummary,
  type DocumentGroup,
  type VerdictChangeInfo,
} from "@/domain/deepAnalysis";
import {
  deepAnalysisService,
  type DeepAnalysisStatus,
  type KonturCardQueued,
  type KonturCardStatus,
} from "@/services/deepAnalysisService";
import type {
  AnalysisFinding,
  DocumentTruncation,
  TenderDataSource,
} from "@/types/database";
import {
  Badge,
  Button,
  Card,
  LoadingSkeleton,
} from "@/components/ui/primitives";
import {
  documentSkippedLabel,
  findingCategoryLabels,
  findingSeverityLabels,
  parsedStatusLabels,
  verdictShort,
} from "@/lib/labels";
import { formatDateTime, formatFileSize, pluralRu } from "@/utils/format";
import { ConsolidationBlock, FindingProvenance, MoneyBlock } from "@/components/tenders/AnalysisSummaryBlocks";
import { AnalysisScorecard } from "@/components/tenders/AnalysisScorecard";
import { CompanyFitBlock } from "@/components/tenders/CompanyFitBlock";
import { factsHaveContent } from "@/domain/companyFacts/types";
import { useCompanyFit } from "@/hooks/useCompanyFit";
import {
  analysisScorecard,
  clarificationDeadline,
  nextSteps,
  splitVerdictReason,
  type NextStep,
  deepRiskCounts,
} from "@/domain/analysisDigest";
import { computeMoneyOutlook, hasMoneyOutlook } from "@/domain/moneyOutlook";
import type { ConsolidatedFinding } from "@/domain/analysisConsolidation";
import { isPriceKnown, type CompanyProfile, type Tender } from "@/domain/entities";
import {
  matchFindingsWithProfile,
  type ProfileCheck,
  type ProfileCheckStatus,
  type ProfileMatch,
} from "@/domain/profileMatch";
import { requirementAction, type RequirementAction } from "@/domain/requirementAction";

/**
 * Панель «Глубокий анализ документации» на карточке закупки.
 *
 * Панель — единственный вход в разбор: кнопка «Запустить глубокий анализ» ставит
 * задачу в очередь, и больше её не ставит ничто. Стадия воронки этого не делает
 * намеренно — разбор стоит денег и времени воркера, а закупку переводят в работу
 * и просто чтобы не потерять её из вида.
 *
 * Показывает настоящее состояние, а не имитацию прогресса: документацию скачивает
 * воркер на сервере в России (ЕИС не отвечает зарубежным IP), разбирает её воркер
 * на Vercel, поэтому между нажатием кнопки и результатом проходит время. Пока
 * разбор не закончен, статус опрашивается — иначе партнёру пришлось бы обновлять
 * страницу.
 *
 * Для коммерческих закупок Контур.Закупок бесплатного пути нет: ЕИС не публикует
 * для них вкладку документов. Таким закупкам панель предлагает купить карточку
 * источника — один платный запрос из суточного бюджета, и только после явного
 * подтверждения (блок KonturCardBlock).
 */

/*
  Пять секунд: загрузка и разбор теперь идут сразу по кнопке и укладываются в
  минуты, и пятнадцатисекундный опрос отставал бы от них заметно. Запрос
  статуса — чтение нескольких строк, и идёт он только пока разбор активен.
*/
const POLL_INTERVAL_MS = 5_000;

/** Состояния, в которых результат может появиться без участия пользователя. */
const ACTIVE_STATES: readonly DeepAnalysisState[] = [
  "queued",
  "analyzing",
  "resuming",
];

const severityTone: Record<
  AnalysisFinding["severity"],
  "brick" | "mustard" | "neutral"
> = {
  high: "brick",
  medium: "mustard",
  low: "neutral",
};

interface DeepAnalysisPanelProps {
  tenderId: string;
  dataSource: TenderDataSource;
  /** Наименование закупки: попадает в шапку выгруженного документа Word. */
  subject: string;
  /**
   * Разбор поставлен в очередь. Карточка переводит закупку в «Интересное»,
   * чтобы к ней можно было вернуться: результат приходит не сразу, а искать
   * закупку заново по номеру среди сотен — то, ради чего никто не вернётся.
   */
  onStarted?: () => void;
  /**
   * Закупка и профиль компании — для сверки требований документации с
   * профилем. Без них панель показывает разбор как раньше, без сверки.
   */
  tender?: Tender;
  profile?: CompanyProfile | null;
  /**
   * Сигнал «запусти разбор»: растёт на единицу при каждом нажатии кнопки
   * «Глубокий анализ» на вкладке «Главное». Панель запускает разбор сама, если
   * он ещё не шёл, — человеку не приходится нажимать «Запустить» второй раз
   * на другой вкладке. Если разбор уже идёт или закончен, сигнал ничего не делает.
   */
  startSignal?: number;
  /** Разбор закончен или обновился: число рисков договора — для вкладки «Риски договора» карточки. */
  onRiskCounts?: (counts: { total: number; high: number } | null) => void;
}

export function DeepAnalysisPanel({
  tenderId,
  dataSource,
  subject,
  onStarted,
  tender,
  profile,
  startSignal = 0,
  onRiskCounts,
}: DeepAnalysisPanelProps) {
  const [status, setStatus] = useState<DeepAnalysisStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [card, setCard] = useState<KonturCardStatus | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState<PanelTab>("findings");
  /** Итог последней ручной проверки: когда и что изменилось. */
  const [lastCheck, setLastCheck] = useState<{
    at: Date;
    changed: boolean;
  } | null>(null);

  /*
    `announce` отличает ручную проверку от фоновой.

    Фоновый опрос обязан молчать: строка «изменений нет», мигающая сама
    по себе, — шум. А нажатие кнопки обязано ответить всегда, даже когда
    отвечать нечем: без ответа оно выглядит поломкой, и партнёр жмёт снова.
  */
  const load = useCallback(
    async (announce = false) => {
      if (announce) setRefreshing(true);
      try {
        const next = await deepAnalysisService.getStatus(tenderId);
        setStatus((previous) => {
          if (announce) {
            const changed =
              previous === null ||
              deepAnalysisFingerprint(previous) !==
                deepAnalysisFingerprint(next);
            setLastCheck({ at: new Date(), changed });
          }
          return next;
        });
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Не удалось получить состояние анализа",
        );
      } finally {
        setLoading(false);
        if (announce) setRefreshing(false);
      }
    },
    [tenderId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Нужна ли закупке платная карточка, решает сервер: правило лежит в
   * @/domain/konturCardRequest и проверяется тестами, а копия в компоненте
   * разошлась бы с ним незаметно. Чтение бесплатное, поэтому зовём его при
   * каждом открытии карточки.
   */
  const loadCard = useCallback(async () => {
    if (!KONTUR_ENABLED) return;
    try {
      const next = await deepAnalysisService.getKonturCard(tenderId);
      setCard(next);
      setCardError(null);
    } catch (err) {
      setCardError(
        err instanceof Error
          ? err.message
          : "Не удалось прочитать состояние платной карточки",
      );
    }
  }, [tenderId]);

  /*
    Документация могла появиться — тогда карточка больше не нужна, и блок
    обязан исчезнуть, а не предлагать заплатить за то, что уже в базе.
    Перечитываем состояние блока по изменению числа документов.
  */
  const documentsCount = status?.documents.length ?? 0;

  useEffect(() => {
    void loadCard();
  }, [loadCard, documentsCount]);

  const summary = status
    ? summarizeDeepAnalysis({
        ...status,
        dataSource,
        // Когда закупке предлагается платная карточка, подпись очереди обязана
        // говорить о том же пути: обещание плановой догрузки для коммерческой
        // закупки не выполнится никогда.
        paidCardOffered: card?.show === true,
        // НМЦК — для правил закона (порог СРО 10 млн ₽) у разборов без сводки.
        price: tender?.financial.price ?? null,
        // Закон — для отсева типового: по 44-ФЗ казначейство и односторонний отказ не находки.
        law: tender?.law ?? null,
      })
    : null;
  const isActive = summary !== null && ACTIVE_STATES.includes(summary.state);

  /*
    «Соответствие вашей компании»: когда разбор готов и у человека есть факты из документов, сервер сверяет требования закупки
    с компанией сам (кэш по отпечаткам — повторное открытие ничего не стоит). Кнопка в блоке запускает то же вручную.
    Общий разбор закупки один на всех, а эта сверка — личная, поэтому считается отдельно и на сервере.
  */
  const hasCompanyFacts = factsHaveContent(profile?.companyFacts);
  const companyFit = useCompanyFit(tenderId, { auto: summary?.state === "completed" && hasCompanyFacts });

  const riskCounts = deepRiskCounts(summary);
  const riskTotal = riskCounts?.total ?? null;
  const riskHigh = riskCounts?.high ?? null;
  useEffect(() => {
    if (!onRiskCounts || riskTotal === null || riskHigh === null) return;
    onRiskCounts({ total: riskTotal, high: riskHigh });
  }, [onRiskCounts, riskTotal, riskHigh]);

  // Сверка считается один раз: её показывает панель и печатает выгрузка Word.
  const findings = summary?.findings;
  const profileMatch = useMemo(
    () =>
      tender && findings && findings.length > 0
        ? matchFindingsWithProfile(findings, tender, profile ?? null)
        : null,
    [findings, tender, profile],
  );

  // Что документация говорит про НДС в цене. Один раз на закупку: тексты бывают
  // огромными, а результат нужен и карточке цены, и отчёту.
  const vatStatus = useMemo(
    () =>
      detectVatStatus({
        law: tender?.law,
        documents: (tender?.documents ?? []).map((doc) => ({
          name: doc.fileName || doc.title,
          text: doc.text,
        })),
      }),
    [tender?.law, tender?.documents],
  );

  // Сметы заказчика из документации. Один раз на закупку, как и статус НДС:
  // разбор идёт по текстам, которые бывают огромными, а результат нужен и блоку
  // сравнения на экране, и отчёту Word.
  const customerEstimates = useMemo(
    () =>
      parseCustomerEstimates(
        (tender?.documents ?? []).map((doc) => ({
          name: doc.fileName || doc.title,
          text: doc.text,
        })),
      ),
    [tender?.documents],
  );

  // Локальные сметы заказчика (форма 421/пр) без повторов между документами: сравнение по каждой ЛСР.
  const lsrSet = useMemo(
    () =>
      buildLsrSet(
        parseCustomerLsr(
          (tender?.documents ?? []).map((doc) => ({
            name: doc.fileName || doc.title,
            text: doc.text,
          })),
        ).estimates,
      ),
    [tender?.documents],
  );
  const customerLsrs = useMemo(() => lsrSet.entries.map(lsrSourceInfo), [lsrSet]);
  // «Деньги»: обеспечения, запас по цене при снижении, зима, оплата — по НМЦК,
  // условиям договора из сводки анализа и смете заказчика (moneyOutlook.ts).
  const consolidationFacts = summary?.consolidation?.facts ?? null;
  const moneyOutlook = useMemo(
    () =>
      tender === undefined
        ? null
        : computeMoneyOutlook({
            price: isPriceKnown(tender.financial.price) ? tender.financial.price : null,
            facts: consolidationFacts,
            terms: tender.documentTerms ?? null,
            estimates: lsrSet.entries.map((entry) => entry.estimate),
            submissionEnd: tender.deadlines.submissionEnd || null,
          }),
    [tender, consolidationFacts, lsrSet],
  );
  /*
    «Сейчас» берётся один раз при открытии панели: срок запроса и остаток дней до подачи
    считаются от него, а не от каждой перерисовки (и не расходятся между чипами и скоркартой).
  */
  const [now] = useState(() => new Date());
  const submissionEnd = tender?.deadlines.submissionEnd || null;
  const knownPrice = tender !== undefined && isPriceKnown(tender.financial.price) ? tender.financial.price : null;
  const clarifyBy = useMemo(() => clarificationDeadline(submissionEnd, now), [submissionEnd, now]);
  const consolidation = summary?.consolidation ?? null;
  const scorecard = useMemo(
    () =>
      summary === null || summary.state !== "completed"
        ? []
        : analysisScorecard({
            match: profileMatch,
            findings: summary.findings,
            consolidation,
            documentsTotal: summary.documents.length,
            documentsWithText: summary.documentsWithText,
            documentsSkipped: summary.documentsSkipped,
            outlook: moneyOutlook,
            price: knownPrice,
            submissionEnd,
            now,
          }),
    [summary, profileMatch, consolidation, moneyOutlook, knownPrice, submissionEnd, now],
  );
  const steps = useMemo(
    () =>
      nextSteps({
        questionsCount: consolidation?.questions.length ?? 0,
        clarifyBy,
        submissionEnd,
        scorecard,
        now,
      }),
    [consolidation, clarifyBy, submissionEnd, scorecard, now],
  );

  /*
    Переход к секции из скоркарты, шагов и навигации: вкладка «Выводы» может быть скрыта
    (`hidden`), а у скрытого блока нет геометрии. Поэтому якорь запоминается, вкладка
    переключается, и прокрутка идёт уже после перерисовки.
  */
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const goTo = useCallback((anchor: string) => {
    setTab("findings");
    setPendingAnchor(anchor);
  }, []);
  useEffect(() => {
    if (pendingAnchor === null || tab !== "findings") return;
    window.document.getElementById(pendingAnchor)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    setPendingAnchor(null);
  }, [pendingAnchor, tab]);

  // Коэффициенты заказчика в его ЛСР: сколько позиций с ними и сколько подтверждено приложением 10 — для переключателя в «Условиях работ».
  const customerCoefficients = useMemo(() => {
    const items = lsrSet.entries.flatMap((entry) => lsrBillSection(entry, 1).section.items);
    const summary = summarizeCustomerConditions(items);
    return { positions: summary.positions, confirmed: summary.confirmed, rejected: summary.rejected };
  }, [lsrSet]);

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isActive, load]);

  /** Единственный запуск разбора во всём интерфейсе. */
  const start = async () => {
    setStarting(true);
    try {
      await deepAnalysisService.trigger(tenderId);
      onStarted?.();
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось запустить анализ",
      );
    } finally {
      setStarting(false);
    }
  };

  /**
   * Выгрузка выводов в файл Word.
   *
   * Сборка идёт в браузере: все данные панель уже держит. Библиотека весит
   * около мегабайта и подгружается по нажатию, а не при открытии карточки.
   */
  /*
    Смета считается на сервере воркера и ставится в очередь: у прода базы
    нормативов нет, а разбор ведомости идёт минутами. Пользователю это видно
    так же, как глубокий анализ, — поставили и ждём.
  */
  const estimateJob = useEstimateJob(tenderId);
  /*
    Правки ведомости: человек поправил объём или норму и пересчитал смету без модели. Дальше по панели —
    отчёт Word, цена участия, сравнение со сметой заказчика — идёт пересчитанный результат, а не исходный.
  */
  const billEditor = useBillEdits({ tenderId, jobId: estimateJob.jobId, result: estimateJob.result });
  const shownEstimate = billEditor?.effective ?? estimateJob.result;
  // Аудит сметы заказчика — отдельное задание того же вида (`mode: "audit"`): без ИИ, бесплатно.
  const auditJob = useEstimateAuditJob(tenderId);
  // Проверять есть что, если в документации нашлась смета заказчика хотя бы с одним разделом.
  const canAudit = customerEstimates.some((estimate) => estimate.sections.length > 0);
  // Ценовая зона расчёта: по закупке (null) или выбранная вручную.
  const priceZones = usePriceZones();
  const [pickedZone, setPickedZone] = useState<number | null>(null);
  // Условия работ: по умолчанию всё выключено, смета считается без начислений сверх норм.
  const [estimateOptions, setEstimateOptions] = useState<EstimateOptions>(NO_ESTIMATE_OPTIONS);
  // Тексты документации — для подсказок «В ТЗ сказано: …»; считается один раз на закупку.
  const documentsText = useMemo(() => (tender?.documents ?? []).map((doc) => doc.text).join("\n"), [tender?.documents]);
  /*
    Сводный расчёт поверх сметы: наш ССР и «наша оценка НМЦК», сравнение с НМЦК закупки, ССР заказчика из документов и его
    аудит. Считается в браузере по готовой смете и выбору в «Условиях работ»; на экране, в цене участия и в Word — одни числа.
  */
  const ssrToday = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const nmcValue = tender !== undefined && tender.financial.price > 0 ? tender.financial.price : null;
  const ssrLayer = useMemo(
    () =>
      computeSsrLayer({
        estimate: shownEstimate?.document ?? null,
        options: estimateOptions,
        nmc: nmcValue,
        nmcIncludesVat: vatStatus.includesVat,
        priceDate: tender?.deadlines?.publicationDate?.slice(0, 10) ?? null,
        today: ssrToday,
        documents: (tender?.documents ?? []).map((doc) => ({ name: doc.fileName || doc.title, text: doc.text })),
      }),
    [shownEstimate, estimateOptions, nmcValue, vatStatus.includesVat, tender?.deadlines?.publicationDate, tender?.documents, ssrToday],
  );

  const exportDocx = async (current: DeepAnalysisSummary) => {
    setExporting(true);
    try {
      const { buildDeepAnalysisDocx, deepAnalysisFileName } = await import(
        "@/services/deepAnalysisExport"
      );
      const generatedAt = new Date();
      // Смета уже посчитана — отчёт получает цену участия по ней. Числа те же,
      // что на экране: одна функция, одни допущения по умолчанию.
      const estimate = shownEstimate;
      const billEdits = marksOf(billEditor);
      let bidEconomics: BidEconomics | null = null;
      if (estimate !== null) {
        const assurance = computeAssurance(estimate.document, { volumeSource: estimate.volumeSource ?? null });
        bidEconomics = computeBidEconomics({
          document: estimate.document,
          nmc: tender !== undefined && tender.financial.price > 0 ? tender.financial.price : null,
          billItems: estimate.billItems,
          droppedPositions: assurance.droppedPositions,
          assumedPercent: assurance.assumedPercent,
          unpricedResources: assurance.unpricedResources,
          company: {
            taxSystem: profile?.taxSystem ?? "OSNO",
            minMarginPercent: effectiveMinMargin(profile?.restrictions.minMarginPercent ?? 0),
          },
          costProfile: profile?.costProfile ?? null,
          nmcIncludesVat: vatStatus.includesVat,
          ssr: ssrLayer.ssr,
          law: tender?.law,
          vatBasis: vatStatus.basis,
          vatQuote: vatStatus.quote,
          vatConflict: vatStatus.conflict,
        });
      }
      const bytes = await buildDeepAnalysisDocx({
        regNumber: tenderId,
        subject,
        summary: current,
        generatedAt,
        tender: tender ?? null,
        moneyOutlook,
        profileMatch,
        companyFit: companyFit.result,
        bidEconomics,
        vatStatus,
        customerComparison:
          estimate === null ? null : compareWithCustomerEstimate(estimate.document, customerEstimates, customerLsrs),
        customerAudit: auditJob.result,
        ssr:
          ssrLayer.ssr === null && ssrLayer.audits.length === 0
            ? null
            : { result: ssrLayer.ssr, comparison: ssrLayer.comparison, audits: ssrLayer.audits },
        estimateSource:
          estimate === null
            ? null
            : {
                priceZone: estimate.document.priceZone,
                period: estimate.document.period,
                baseEdition: estimate.document.baseEdition,
                method: estimate.document.method,
                ...(estimate.document.bim === undefined ? {} : { bim: estimate.document.bim }),
              },
        billEdits:
          billEdits === null
            ? null
            : { count: billEdits.count, marks: billEdits.marks.map((mark) => ({ title: mark.title, notes: mark.notes })) },
        appliedNormatives: estimate?.document.appliedNormatives ?? null,
        volumeSource: estimate?.volumeSource ?? null,
        estimateConfidence:
          estimate === null
            ? null
            : computeEstimateConfidence({
                document: estimate.document,
                volumeSource: estimate.volumeSource ?? null,
                customerLsrs: tender === undefined ? undefined : customerLsrs,
              }),
        volumeFindings: estimate?.volumeFindings ?? [],
        customerPriced:
          estimate?.document.totals.customerPricedCount
            ? {
                amount: estimate.document.totals.customerPriced ?? 0,
                count: estimate.document.totals.customerPricedCount,
              }
            : null,
      });

      const url = URL.createObjectURL(
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      );
      const link = window.document.createElement("a");
      link.href = url;
      link.download = deepAnalysisFileName(tenderId, generatedAt);
      link.click();
      // Ссылку на объект надо отпускать руками: иначе файл держится в памяти
      // вкладки до её закрытия.
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось собрать файл Word",
      );
    } finally {
      setExporting(false);
    }
  };

  /** После обращения к покупке перечитываем оба состояния: расход карточек и очередь разбора. */
  const refreshAfterPurchase = useCallback(async () => {
    await Promise.all([load(), loadCard()]);
  }, [load, loadCard]);

  const canStart =
    summary !== null &&
    (summary.state === "not_started" || summary.state === "failed");

  // Запуск по сигналу с вкладки «Главное»: ждём, пока состояние загрузится, и
  // стартуем один раз на каждое нажатие.
  const handledSignal = useRef(0);
  useEffect(() => {
    if (startSignal === 0 || startSignal === handledSignal.current || summary === null) return;
    handledSignal.current = startSignal;
    if (canStart) void start();
    // start меняется на каждый рендер; сигнал и состояние — единственные причины запуска.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSignal, summary, canStart]);

  const estimating = estimateJob.status === "queued" || estimateJob.status === "running";
  const auditing = auditJob.status === "queued" || auditJob.status === "running";
  const hasDocs = summary !== null && summary.documentsWithText > 0;
  const showDetails = summary !== null && (!isActive || summary.findings.length > 0);
  const showMoney = moneyOutlook !== null && hasMoneyOutlook(moneyOutlook);
  const riskCount = summary?.findings.filter((f) => f.category === "risk").length ?? 0;

  return (
    <Card title="Глубокий анализ документации">
      {loading && <LoadingSkeleton rows={3} />}

      {!loading && error && !status && (
        <div className="space-y-2">
          <p className="text-sm text-brick-fg">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Повторить
          </Button>
        </div>
      )}

      {!loading && summary && (
        <div className="space-y-6">
          {/* 1. Что происходит и что делать дальше — одно место, одна мысль. */}
          {isActive ? (
            <WorkProgress
              title={summary.title}
              hint={summary.detail}
              steps={ANALYSIS_STEPS}
              current={analysisStep(summary)}
              progress={analysisProgress(summary)}
            />
          ) : summary.state === "completed" ? (
            <DecisionBlock
              decision={analysisDecision({
                match: profileMatch,
                findings: summary.findings,
                documentsSkipped: summary.documentsSkipped,
              })}
              eyebrow={summary.title}
              detail={summary.detail}
              overview={summary.consolidation?.summary ?? ""}
              steps={steps}
              onStep={goTo}
            />
          ) : (
            <div>
              <p className="text-[19px] font-semibold tracking-tight text-foreground">
                {summary.title}
              </p>
              <p className="mt-1.5 max-w-[62ch] text-[14.5px] leading-relaxed text-muted-foreground">
                {summary.detail}
              </p>
            </div>
          )}
          {/* 2. Светофор по направлениям — до того, как человек уйдёт в детали. */}
          {summary.state === "completed" && scorecard.length > 0 && (
            <AnalysisScorecard items={scorecard} onSelect={goTo} />
          )}
          {/* 2б. Соответствие именно вашей компании: общий разбор у всех один, а этот блок — личный. */}
          {summary.state === "completed" && (
            <CompanyFitBlock state={companyFit} hasFacts={hasCompanyFacts} onCheck={(force) => void companyFit.run(force)} />
          )}

          {error && <p className="text-xs text-brick-fg">{error}</p>}

          <SummaryActions
            summary={summary}
            canStart={canStart}
            starting={starting}
            refreshing={refreshing}
            exporting={exporting}
            lastCheck={lastCheck}
            onStart={() => void start()}
            onRefresh={() => void load(true)}
            onExport={() => void exportDocx(summary)}
          />

          {KONTUR_ENABLED && (
            <KonturCardBlock
              tenderId={tenderId}
              card={card}
              cardError={cardError}
              onRetry={() => void loadCard()}
              refresh={refreshAfterPurchase}
            />
          )}

          {summary.verdictChange && <VerdictChangeNote change={summary.verdictChange} />}

          {/* 3. Всё остальное — по вкладкам, а не одной лентой. Пока идёт разбор и
              выводов ещё нет, вкладки были бы пустыми — их не показываем. */}
          {showDetails && (
          <>
          <PanelTabs
            tab={tab}
            onChange={setTab}
            tabs={[
              { id: "findings", label: "Выводы", count: summary.findings.length },
              { id: "estimate", label: "Смета", mark: shownEstimate !== null || estimating },
              { id: "documents", label: "Документы", count: summary.documents.length },
            ]}
          />

          <div role="tabpanel" hidden={tab !== "findings"} className="space-y-6">
            <SectionNav
              items={[
                { anchor: "analysis-conflicts", label: "Противоречия", count: consolidation?.conflicts.length ?? 0, show: (consolidation?.conflicts.length ?? 0) > 0 },
                { anchor: "analysis-questions", label: "Вопросы", count: consolidation?.questions.length ?? 0, show: (consolidation?.questions.length ?? 0) > 0 },
                { anchor: "analysis-money", label: "Деньги", show: showMoney },
                { anchor: "analysis-access", label: "Допуск", show: profileMatch !== null },
                { anchor: "analysis-risks", label: "Риски", count: riskCount, show: riskCount > 0 },
              ]}
              onSelect={goTo}
            />
            {/* Итог по документации стоит у решения вверху панели — здесь его не повторяем. */}
            <ConsolidationBlock
              consolidation={summary.consolidation}
              showSummary={summary.state !== "completed"}
              clarifyBy={clarifyBy}
            />
            {showMoney && moneyOutlook !== null && (
              <div id="analysis-money" className="scroll-mt-32">
                <MoneyBlock outlook={moneyOutlook} price={knownPrice} />
              </div>
            )}
            {profileMatch && (
              <div id="analysis-access" className="scroll-mt-32">
                <ProfileMatchBlock match={profileMatch} nmc={knownPrice} />
              </div>
            )}
            <div id="analysis-risks" className="scroll-mt-32">
              <FindingsList
                summary={summary}
                skipRequirements={profileMatch !== null && profileMatch.checks.length > 0}
              />
            </div>
            <PanelFooter summary={summary} />
          </div>

          <div role="tabpanel" hidden={tab !== "estimate"} className="space-y-5">
            {!hasDocs && !canAudit && shownEstimate === null && auditJob.result === null && ssrLayer.audits.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Смета считается по документации закупки. Сначала нужен готовый разбор —
                запустите глубокий анализ.
              </p>
            ) : (
              <>
                <EstimateActions
                  canAudit={canAudit}
                  auditing={auditing}
                  onAudit={() =>
                    void auditJob.start({
                      tenderId,
                      subject,
                      ...(pickedZone === null ? {} : { priceZoneId: pickedZone }),
                    })
                  }
                  canEstimate={hasDocs}
                  estimating={estimating}
                  onEstimate={() =>
                    void estimateJob.start({
                      tenderId,
                      subject,
                      ...(pickedZone === null ? {} : { priceZoneId: pickedZone }),
                      ...(hasEstimateOptions(estimateOptions) ? { options: estimateOptions } : {}),
                    })
                  }
                />

                {estimating && (
                  <WorkProgress
                    title="Считаем смету"
                    hint="Обычно это несколько минут. Страницу можно закрыть: результат сохранится в закупке."
                    steps={ESTIMATE_STEPS}
                    current={estimateJob.status === "queued" ? 0 : 1}
                  />
                )}
                {auditing && (
                  <div data-testid="audit-progress">
                    <WorkProgress
                      title="Проверяем смету заказчика"
                      hint="Это быстро: цены и арифметика сверяются автоматически."
                      steps={AUDIT_STEPS}
                      current={0}
                    />
                  </div>
                )}
                {estimateJob.error !== null && (
                  <p className="text-sm text-brick-fg">{estimateJob.error}</p>
                )}
                {auditJob.error !== null && (
                  <p className="text-sm text-brick-fg" data-testid="audit-error">{auditJob.error}</p>
                )}

                {/* Настройки расчёта — под раскрывающимся заголовком: нужны не всем и не всегда. */}
                <details className="group rounded-card border border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-foreground">
                    Параметры расчёта
                    <span className="text-xs font-normal text-faint group-open:hidden">показать</span>
                    <span className="hidden text-xs font-normal text-faint group-open:inline">скрыть</span>
                  </summary>
                  <div className="space-y-4 border-t border-border p-4">
                    <PriceZonePicker
                      tender={
                        tender === undefined
                          ? undefined
                          : { region: tender.region, deliveryAddress: tender.deliveryAddress, customerName: tender.customerName }
                      }
                      zones={priceZones}
                      picked={pickedZone}
                      onPick={setPickedZone}
                    />
                    {hasDocs && <EstimateMethodSelect options={estimateOptions} onChange={setEstimateOptions} text={documentsText} />}
                    {hasDocs && (
                      <WorkConditionsBlock
                        options={estimateOptions}
                        onChange={setEstimateOptions}
                        text={documentsText}
                        subject={subject}
                        customerCoefficients={customerCoefficients}
                        tender={
                          tender === undefined
                            ? undefined
                            : { region: tender.region, deliveryAddress: tender.deliveryAddress, customerName: tender.customerName }
                        }
                      />
                    )}
                  </div>
                </details>

                {(auditJob.result !== null || ssrLayer.audits.length > 0) && (
                  <div className="divide-y divide-border border-y border-border">
                    {auditJob.result !== null && (
                      <Fold title="Проверка сметы заказчика" summary="Цены, нормативы и арифметика — сверка с нашими" defaultOpen>
                        <CustomerAuditCard audit={auditJob.result} jobId={auditJob.jobId} />
                      </Fold>
                    )}
                    {auditJob.result !== null && (
                      <Fold title="Экономика участия по смете заказчика" summary="Безубыточная цена и допустимое снижение по его смете, пересчитанной по нашим ценам">
                        <AuditBidEconomics
                          audit={auditJob.result}
                          company={
                            profile === null || profile === undefined
                              ? null
                              : { taxSystem: profile.taxSystem, minMarginPercent: profile.restrictions.minMarginPercent }
                          }
                          costProfile={profile?.costProfile}
                          onCostProfileChange={persistCostProfile}
                          tender={{ nmc: nmcValue, law: tender?.law, vat: vatStatus }}
                          subject={subject}
                        />
                      </Fold>
                    )}
                    {ssrLayer.audits.length > 0 && (
                      <Fold title="Проверка сводного расчёта заказчика" summary="Резерв, инфляция, НДС и лимит финансирования">
                        <SsrAuditCard reports={ssrLayer.audits} />
                      </Fold>
                    )}
                  </div>
                )}
                {shownEstimate !== null && (
                  <EstimateResult
                    data={shownEstimate}
                    editor={billEditor}
                    regNumber={tenderId}
                    customerEstimates={tender === undefined ? undefined : customerEstimates}
                    customerLsrs={tender === undefined ? undefined : customerLsrs}
                    ssr={
                      ssrLayer.ssr === null
                        ? null
                        : { result: ssrLayer.ssr, comparison: ssrLayer.comparison, audits: ssrLayer.audits }
                    }
                    bid={{
                      // Ноль у нас означает «цена не опубликована», а не бесплатную закупку.
                      nmc: tender !== undefined && tender.financial.price > 0 ? tender.financial.price : null,
                      taxSystem: profile?.taxSystem ?? "OSNO",
                      minMarginPercent: profile?.restrictions.minMarginPercent ?? 0,
                      law: tender?.law,
                      vat: vatStatus,
                      costProfile: profile?.costProfile,
                      onCostProfileChange: persistCostProfile,
                    }}
                  />
                )}
              </>
            )}
          </div>

          <div role="tabpanel" hidden={tab !== "documents"}>
            <DocumentsList summary={summary} dataSource={dataSource} />
          </div>
          </>
          )}
        </div>
      )}
    </Card>
  );
}

type PanelTab = "findings" | "estimate" | "documents";

const DECISION_BAR: Record<AnalysisDecision["tone"], string> = {
  good: "border-olive",
  warn: "border-mustard",
  bad: "border-brick",
  neutral: "border-border-strong",
};

const STEP_ICON: Record<NextStep["key"], typeof CalendarClock> = {
  ask: MessageCircleQuestion,
  submit: CalendarClock,
  requirement: ShieldAlert,
};

/**
 * Главный вывод: заголовок, под ним — суть по всей документации (или до трёх причин,
 * если сводки нет) и строка «Что сделать» с датами. Всё остальное на вкладке —
 * доказательства этого вывода, а не отдельные новости.
 *
 * Суть из сводки заменяет причины: они дублировали риски («Риск: …» ×3), а сводка
 * говорит то же связно и с учётом противоречий между документами.
 */
function DecisionBlock({
  decision,
  eyebrow,
  detail,
  overview = "",
  steps = [],
  onStep,
}: {
  decision: AnalysisDecision;
  eyebrow: string;
  detail: string;
  /** Итог по всей документации (`consolidation.summary`); пусто — показываем причины. */
  overview?: string;
  steps?: readonly NextStep[];
  /** Шаг с якорем выбран: панель открывает «Выводы» и прокручивает к секции. */
  onStep?: (anchor: string) => void;
}) {
  return (
    <div data-testid="decision">
      <p className="text-[13px] text-faint">
        <span className="font-medium">{eyebrow}</span>
        <span> · {detail}</span>
      </p>
      <div className={cn("mt-3 border-l-[4px] pl-4", DECISION_BAR[decision.tone])}>
        <p className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">
          {decision.headline}
        </p>
        {overview !== "" ? (
          <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-foreground" data-testid="decision-overview">
            {overview}
          </p>
        ) : (
          decision.reasons.length > 0 && (
            <ul className="mt-2 space-y-1 text-[15px] text-muted-foreground">
              {decision.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )
        )}
      </div>
      {steps.length > 0 && (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1.5" data-testid="next-steps">
          <span className="text-[13px] text-faint">Что сделать</span>
          {steps.map((step) => {
            const Icon = STEP_ICON[step.key];
            const chip = cn(
              "inline-flex max-w-full items-center gap-1.5 text-left text-[14px] font-medium leading-snug",
              step.tone === "brick" ? "text-brick-fg" : "text-foreground",
            );
            const content = (
              <>
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{step.label}</span>
              </>
            );
            return step.anchor !== null && onStep ? (
              <button
                key={step.key}
                type="button"
                onClick={() => onStep(step.anchor!)}
                className={cn(chip, "underline decoration-border-strong underline-offset-4 hover:decoration-current")}
              >
                {content}
              </button>
            ) : (
              <span key={step.key} className={chip}>
                {content}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Вердикт пересмотрен — одной строкой; причина в истории хранится строкой «Обнаружены
 * риски: A; B; … » на два десятка пунктов, поэтому разбита на список и спрятана.
 */
function VerdictChangeNote({ change }: { change: VerdictChangeInfo }) {
  const { lead, items } = splitVerdictReason(change.reason);
  return (
    <div className="border-l-[3px] border-brick pl-4" data-testid="verdict-change">
      <p className="text-sm font-semibold text-foreground">
        Вердикт пересмотрен: {change.from ? `${verdictShort[change.from]} → ` : ""}
        {verdictShort[change.to]} · {formatDateTime(change.at)}
      </p>
      {items.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[13.5px] text-muted-foreground hover:text-foreground">
            Почему: {lead} ({items.length})
          </summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13.5px] text-muted-foreground">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : (
        lead !== "" && <p className="mt-0.5 text-[13.5px] text-muted-foreground">Почему: {lead}</p>
      )}
    </div>
  );
}

/** Чипы-переходы к секциям вкладки «Выводы»: показываем только те, что есть. */
function SectionNav({
  items,
  onSelect,
}: {
  items: { anchor: string; label: string; count?: number; show: boolean }[];
  onSelect: (anchor: string) => void;
}) {
  const shown = items.filter((item) => item.show);
  if (shown.length < 2) return null;
  return (
    <nav aria-label="Разделы выводов" className="flex flex-wrap gap-x-5 gap-y-1" data-testid="section-nav">
      {shown.map((item) => (
        <button
          key={item.anchor}
          type="button"
          onClick={() => onSelect(item.anchor)}
          className="inline-flex items-center gap-1.5 text-[13.5px] text-muted-foreground hover:text-foreground"
        >
          {item.label}
          {item.count !== undefined && item.count > 0 && <span className="num text-faint">{item.count}</span>}
        </button>
      ))}
    </nav>
  );
}

/** Этапы работы так, как их видит человек, а не система. */
const ANALYSIS_STEPS = ["Загружаем документы", "Читаем текст", "Сверяем с профилем"] as const;
const ESTIMATE_STEPS = ["Принимаем расчёт", "Читаем ведомость и считаем"] as const;
const AUDIT_STEPS = ["Сверяем цены и нормативы"] as const;

/** Какой этап идёт: нет документов — загрузка, есть — чтение, всё прочитано — сверка. */
function analysisStep(summary: DeepAnalysisSummary): number {
  if (summary.documents.length === 0) return 0;
  const job = summary.job;
  if (job && job.documents_total > 0 && job.documents_processed >= job.documents_total) return 2;
  return 1;
}

/** Доля прочитанных файлов — только когда она известна; иначе полоска бежит без конца. */
function analysisProgress(summary: DeepAnalysisSummary): number | null {
  const job = summary.job;
  if (!job || job.documents_total <= 0 || summary.documents.length === 0) return null;
  return Math.min(1, job.documents_processed / job.documents_total);
}

/** Вкладки: подчёркнутый активный заголовок, без пилюль и коробок. */
function PanelTabs({
  tab,
  onChange,
  tabs,
}: {
  tab: PanelTab;
  onChange: (tab: PanelTab) => void;
  tabs: { id: PanelTab; label: string; count?: number; mark?: boolean }[];
}) {
  return (
    <div role="tablist" aria-label="Разделы анализа" className="flex gap-6 border-b border-border">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "-mb-px flex items-center gap-1.5 border-b-2 pb-2.5 pt-1 text-[14.5px] font-medium transition-colors",
            tab === t.id
              ? "border-accent text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span className="num text-[12.5px] text-faint">{t.count}</span>
          )}
          {t.mark && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
        </button>
      ))}
    </div>
  );
}

/** Кнопки сметы — внутри вкладки «Смета», где они нужны. */
function EstimateActions({
  canAudit,
  auditing,
  onAudit,
  canEstimate,
  estimating,
  onEstimate,
}: {
  canAudit: boolean;
  auditing: boolean;
  onAudit: () => void;
  canEstimate: boolean;
  estimating: boolean;
  onEstimate: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canEstimate && (
        <Button size="sm" onClick={onEstimate} disabled={estimating} className="gap-1.5">
          <Calculator className="h-3.5 w-3.5" />
          {estimating ? "Считаем смету…" : "Рассчитать смету"}
        </Button>
      )}
      {canAudit && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onAudit}
          disabled={auditing}
          className="gap-1.5"
          title="Бесплатно: цены, нормативы и арифметика сметы заказчика сверяются с нашими"
        >
          <Calculator className="h-3.5 w-3.5" />
          {auditing ? "Проверяем смету…" : "Проверить смету заказчика"}
        </Button>
      )}
    </div>
  );
}

function SummaryActions({
  summary,
  canStart,
  starting,
  refreshing,
  exporting,
  lastCheck,
  onStart,
  onRefresh,
  onExport,
}: {
  summary: DeepAnalysisSummary;
  canStart: boolean;
  starting: boolean;
  refreshing: boolean;
  exporting: boolean;
  lastCheck: { at: Date; changed: boolean } | null;
  onStart: () => void;
  onRefresh: () => void;
  onExport: () => void;
}) {
  if (summary.state === "unsupported") return null;

  /*
    Выгрузка предлагается, только когда в документе будет что читать.

    Файл Word с одной строкой «разбор не запускался» партнёру не нужен, а кнопка
    рядом с пустым разбором обещает результат, которого нет.
  */
  const working = summary.state === "queued" || summary.state === "analyzing" || summary.state === "resuming";
  const canExport = !working && (summary.documents.length > 0 || summary.findings.length > 0);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {canStart && (
          <Button size="sm" onClick={onStart} disabled={starting}>
            {starting ? "Запускаем…" : "Запустить глубокий анализ"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="gap-1.5"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
          />
          {refreshing ? "Проверяем..." : "Обновить статус"}
        </Button>
        {canExport && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onExport}
            disabled={exporting}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Собираем файл..." : "Скачать в Word"}
          </Button>
        )}
      </div>
      {/*
        Ответ на нажатие обязателен даже тогда, когда отвечать нечем. Разбор
        идёт минутами, и «изменений нет» — нормальный результат проверки, а не
        молчание сломанной кнопки.
      */}
      {lastCheck && !refreshing && (
        <p className="muted text-xs">
          {lastCheck.changed ? "Состояние обновилось" : "Изменений нет"} ·
          проверено в{" "}
          {lastCheck.at.toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}
    </div>
  );
}

function DocumentsList({
  summary,
  dataSource,
}: {
  summary: DeepAnalysisSummary;
  dataSource: TenderDataSource;
}) {
  if (summary.documents.length === 0) return null;
  // Пропуски схлопываются по причине: на закупке с многотомным архивом их
  // бывает почти полсотни, и список одинаковых строк не читается.
  const groups = groupDocuments(summary.documents);
  return (
    <div>
      {/*
        Числа уже названы в строке состояния выше — здесь только про источник.
        Повтор «1 с текстом, пропущено 2» другими словами заставлял сверять два
        счёта глазами и ничего к ним не добавлял.
      */}
      <p className="muted text-xs mb-2">{documentsOriginNote(dataSource)}</p>
      <ul className="space-y-2">
        {groups.map((group) => (
          <DocumentRow key={group.document.id} group={group} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Откуда приехал текст — называем точно.
 *
 * Для коммерческой закупки Контур.Закупок файл мог прийти из платной карточки
 * источника; выдать его за бесплатный ответ ЕИС значит скрыть от партнёра, за что
 * списаны деньги.
 */
function documentsOriginNote(dataSource: TenderDataSource): string {
  const origin =
    dataSource === "KONTUR"
      ? "из ЕИС или из карточки Контур.Закупок"
      : dataSource === "EIS"
        ? "из ЕИС"
        : "из источника закупки";
  return `Текст получен ${origin}.`;
}

/**
 * Покупка карточки Контур.Закупок — единственный путь к документации коммерческой
 * закупки, которую ЕИС не публикует.
 *
 * Нажатие расходует платный запрос источника, поэтому подтверждение в два шага:
 * первое раскрывает состав работы и стоимость, второе покупает. Отмена возвращает
 * блок в исходное состояние и не тратит ничего.
 *
 * Блок молчит, когда сервер ответил `show: false`: для закупок ЕИС и для 44-ФЗ те
 * же файлы приходят бесплатно, и предлагать за них заплатить значит потратить
 * деньги партнёра впустую. Правило живёт в @/domain/konturCardRequest — копия
 * в компоненте разошлась бы с ним незаметно.
 */
function KonturCardBlock({
  tenderId,
  card,
  cardError,
  onRetry,
  refresh,
}: {
  tenderId: string;
  card: KonturCardStatus | null;
  cardError: string | null;
  onRetry: () => void;
  /** Перечитать состояние панели и расход карточек после обращения к покупке. */
  refresh: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [buying, setBuying] = useState(false);
  const [purchase, setPurchase] = useState<KonturCardQueued | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);

  if (cardError !== null && card === null) {
    // Сбой чтения не должен ронять панель разбора: блок про платный путь
    // объясняет себя сам и предлагает перечитать.
    return (
      <div className="rounded-md border border-border px-3 py-2">
        <p className="muted text-xs">
          Состояние платной карточки не прочитано: {cardError}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={onRetry}
        >
          Повторить
        </Button>
      </div>
    );
  }

  if (card === null || !card.show) return null;

  const buy = async () => {
    setBuying(true);
    setBuyError(null);
    try {
      const result = await deepAnalysisService.buyKonturCard(tenderId);
      setPurchase(result);
      setConfirming(false);
    } catch (err) {
      // Причина отказа приходит с сервера готовой фразой — исчерпан бюджет
      // карточек или суточный лимит разборов. Кнопка покупки возвращается:
      // лимиты сбрасываются в полночь, и блок не должен выглядеть сломанным.
      setBuyError(
        err instanceof Error
          ? err.message
          : "Не удалось купить карточку Контур.Закупок",
      );
      setConfirming(false);
    } finally {
      setBuying(false);
      await refresh();
    }
  };

  if (purchase !== null) {
    return (
      <div className="rounded-md border border-olive/45 bg-olive/5 px-3 py-2">
        <p className="text-sm font-medium text-foreground">
          Запрос принят: откроем карточку Контур.Закупок, загрузим документацию
          и сразу начнём разбор.
        </p>
        <p className="muted text-xs mt-1">{purchase.budgetNote}</p>
        {purchase.warning !== null && (
          <p className="text-xs text-mustard-fg mt-1">{purchase.warning}</p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-mustard/45 bg-mustard/5 px-3 py-2">
      <p className="text-sm font-medium text-foreground">
        Документацию этой закупки можно только купить
      </p>
      <p className="text-sm text-muted-foreground mt-1">
        ЕИС не публикует документы коммерческих закупок. Единственный источник —
        карточка Контур.Закупок: один платный запрос, после которого мы
        загрузим документацию и разберём её автоматически.
      </p>
      <p className="muted text-xs mt-1.5">{card.budgetNote}</p>
      <p className="muted text-xs mt-0.5">
        {analysisCostNote(card.analysisRemaining)}
      </p>
      <p className="muted text-xs mt-0.5">
        Деньги списываются и тогда, когда текст файлов закрыт за логином
        площадки: в этом случае источник отдаёт только имена документов.
      </p>

      {card.allowed ? (
        confirming ? (
          <div className="mt-2.5">
            <p className="text-sm text-foreground">
              Купить карточку Контур.Закупок одним платным запросом?
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <Button size="sm" onClick={() => void buy()} disabled={buying}>
                {buying ? "Покупаем..." : "Подтвердить покупку"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={buying}
              >
                Отмена
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2.5">
            <Button size="sm" onClick={() => setConfirming(true)}>
              Купить карточку Контур.Закупок
            </Button>
            {buyError !== null && (
              <p className="text-xs text-brick-fg mt-1.5">{buyError}</p>
            )}
          </div>
        )
      ) : (
        card.reason !== null && (
          <p className="text-sm text-muted-foreground mt-2">{card.reason}</p>
        )
      )}
    </div>
  );
}

/**
 * Сколько стоит разбор и расходуется ли суточный лимит.
 *
 * null — задача разбора на эту закупку уже стоит в очереди: она подберёт текст
 * без нового расхода, и обещать второй было бы неправдой.
 */
function analysisCostNote(remaining: number | null): string {
  if (remaining === null) {
    return "Разбор этой закупки уже запущен: суточный лимит не расходуется повторно.";
  }
  return (
    `Разбор стоит около 6 ₽ и входит в суточный лимит: осталось ${remaining} ` +
    `из ${DAILY_ANALYSIS_LIMIT}.`
  );
}

/**
 * Чем именно текст не дошёл до модели.
 *
 * Обрезка — не сбой, поэтому подпись приглушённая, как у пропуска. Но сказать
 * о ней нужно: на живой закупке 32616393585 архив документации о закупке из
 * 15 вложений отдал модели 2, и «Разбор завершён» без этой строки читался бы
 * как полный анализ документации.
 */
function truncationNote(truncation: DocumentTruncation): string {
  const { archive } = truncation;
  // Бюджета знаков на закупку больше нет (2026-10-08): запись об обрезке — либо
  // старая, сделанная при прежнем бюджете, либо файл прочитан не до конца из-за
  // предела времени распознавания или числа входов архива.
  if (!archive) {
    return "В разбор попала часть текста: файл прочитан не до конца.";
  }
  return (
    `В разбор попала часть текста: из архива прочитано ${archive.parsed} из ${archive.total} ` +
    `${pluralRu(archive.total, ["файл", "файла", "файлов"])}.`
  );
}

function DocumentRow({ group }: { group: DocumentGroup }) {
  const { document, skipped, truncated, archive, hidden } = group;
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm text-foreground truncate">
          {document.raw_json?.title ?? document.filename}
        </p>
        <p className="muted text-xs mt-0.5">
          {skipped
            ? documentSkippedLabel
            : parsedStatusLabels[document.parsed_status]}
          {document.file_size ? ` · ${formatFileSize(document.file_size)}` : ""}{" "}
          · {formatDateTime(document.updated_at)}
        </p>
        {skipped ? (
          // Пропуск — решение обхода, а не сбой, поэтому причина не красная.
          <p className="text-xs text-muted-foreground mt-0.5">
            {skipped.reason}
          </p>
        ) : (
          document.error_message && (
            <p className="text-xs text-brick-fg mt-0.5">
              {document.error_message}
            </p>
          )
        )}
        {/*
          Состав архива — отдельная строка и не только при обрезке: zip, целиком
          влезший в бюджет, тоже отдаёт текстом не все файлы, и «прочитан»
          рядом с сорока сканами внутри вводит в заблуждение.
        */}
        {archive && (
          <p className="muted text-xs mt-0.5">
            Внутри архива прочитано {archive.parsed} из {archive.total}{" "}
            {pluralRu(archive.total, ["файла", "файлов", "файлов"])}.
          </p>
        )}
        {truncated && (
          <p className="muted text-xs mt-0.5">{truncationNote(truncated)}</p>
        )}
        {hidden > 0 && (
          <p className="muted text-xs mt-0.5">
            …и ещё {hidden} {pluralRu(hidden, ["файл", "файла", "файлов"])} с
            той же причиной
          </p>
        )}
      </div>
      {document.file_url && (
        <a
          href={document.file_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-accent-fg hover:underline"
        >
          Открыть в ЕИС <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </li>
  );
}

const CHECK_TONE: Record<ProfileCheckStatus, "olive" | "mustard" | "brick"> = {
  MET: "olive",
  CHECK: "mustard",
  NOT_MET: "brick",
};

const CHECK_LABEL: Record<ProfileCheckStatus, string> = {
  MET: "Выполнено",
  CHECK: "Проверить",
  NOT_MET: "Не выполнено",
};

/** Цвет метки слева от итога сверки: смысл несёт текст, цвет — подсказка. */
const VERDICT_BAR: Record<ProfileMatch["verdict"], string> = {
  READY: "border-olive",
  REVIEW: "border-mustard",
  BLOCKED: "border-brick",
  NO_PROFILE: "border-border-strong",
  NOTHING_TO_CHECK: "border-border-strong",
};

/**
 * Сверка требований документации с профилем компании.
 *
 * Разбор общий для закупки, а ответ «можем ли мы участвовать» — свой у каждой
 * компании. Сверка идёт здесь, в браузере, по тем же правилам допуска, что и
 * карточка закупки: бесплатно, мгновенно и заново при любой правке профиля.
 * Строки разделены линиями, без коробок: список читается сверху вниз.
 */
function ProfileMatchBlock({ match, nmc }: { match: ProfileMatch; nmc: number | null }) {
  return (
    <section className="space-y-4" aria-label="Сверка с профилем компании">
      <div>
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
          Сверка с профилем компании
        </h3>
        <p className={cn("mt-2 border-l-[3px] pl-3 text-[15px] font-medium text-foreground", VERDICT_BAR[match.verdict])}>
          {match.headline}
          {match.verdict === "NO_PROFILE" && (
            <Link href="/settings/profile" className="ml-2 text-accent-fg underline underline-offset-2">
              Заполнить профиль
            </Link>
          )}
        </p>
      </div>
      {match.checks.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {match.checks.map((item, index) => (
            <li key={`${item.finding.title}-${index}`} className="py-4">
              <div className="flex items-start justify-between gap-4">
                <span className="text-[15px] font-medium text-foreground">{item.finding.title}</span>
                <Badge tone={CHECK_TONE[item.status]}>{CHECK_LABEL[item.status]}</Badge>
              </div>
              {item.finding.required_value && (
                <p className="mt-1 text-sm text-muted-foreground">{item.finding.required_value}</p>
              )}
              {/* «Что делать» — тот же текст, что в пятой колонке отчёта Word. */}
              <WhatToDo check={item} nmc={nmc} />
              {item.finding.evidence_quote && (
                <p className="mt-2 text-[13px] italic leading-snug text-faint">
                  «{item.finding.evidence_quote}»
                  {item.finding.evidence_section && (
                    <span className="ml-1 not-italic">— {item.finding.evidence_section}</span>
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ACTION_TEXT_TONE: Record<RequirementAction["tone"], string> = {
  good: "text-olive-fg",
  warn: "text-mustard-fg",
  bad: "text-brick-fg",
  neutral: "text-muted-foreground",
};

/** Строка «Что делать» под требованием: вывод и действие простым языком. */
function WhatToDo({ check, nmc }: { check: ProfileCheck; nmc: number | null }) {
  const action = requirementAction(check, { nmc });
  return (
    <p className="mt-1.5 text-sm text-foreground">
      <span className="text-faint">Что делать: </span>
      <span className={cn("font-medium", ACTION_TEXT_TONE[action.tone])}>{action.text}</span>
    </p>
  );
}

function FindingsList({
  summary,
  skipRequirements = false,
}: {
  summary: DeepAnalysisSummary;
  /** Требования к участнику уже показаны сверкой с профилем — второй раз не повторяем. */
  skipRequirements?: boolean;
}) {
  const groups = skipRequirements
    ? summary.findingGroups.filter((g) => g.category !== "blocker" && g.category !== "requirement")
    : summary.findingGroups;

  /*
    Одна приглушённая строка вместо россыпи типовых «рисков»: видно, что условия 44-ФЗ
    проверены и отклонений нет (`findingNoise.ts`).
  */
  const standardLine = summary.standardLine ? (
    <p className="muted text-[13px] leading-snug" data-testid="standard-conditions">
      {summary.standardLine}
    </p>
  ) : null;

  if (groups.length === 0) {
    if (summary.state !== "completed") return null;
    if (skipRequirements) return standardLine;
    return (
      <div className="space-y-3">
        <p className="muted text-sm">
          Значимых факторов в документации не найдено. Это не гарантия: анализ
          отвечает только за то, что указано в тексте извещения.
        </p>
        {standardLine}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => {
        /*
          Лента из двух десятков рисков с цитатами не читается: высокие — сверху и целиком,
          остальное одной строкой-раскрывашкой. Нет высоких — «средние» становятся главными,
          а раскрывашкой уходят низкие.
        */
        const sorted = [...group.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
        const hasHigh = sorted.some((f) => f.severity === "high");
        const main = sorted.filter((f) => f.severity === (hasHigh ? "high" : "medium"));
        const minor = hasHigh ? sorted.filter((f) => f.severity !== "high") : sorted.filter((f) => f.severity === "low");
        // Десять высоких подряд — снова лента: сверху пять, остальные уходят в ту же раскрывашку первыми.
        const lead = main.slice(0, MAX_LEAD_FINDINGS);
        const overflow = main.slice(MAX_LEAD_FINDINGS);
        const rest = [...overflow, ...minor];
        const minorLabel = hasHigh ? "средних и низких" : "низких";
        const restLabel =
          overflow.length === 0
            ? `${hasHigh ? "Средние и низкие" : "Низкие"}: ${String(minor.length)}`
            : `Ещё ${hasHigh ? "высоких" : "средних"}: ${String(overflow.length)}` +
              (minor.length > 0 ? `, ${minorLabel}: ${String(minor.length)}` : "");
        return (
          <section key={group.category}>
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
              {findingCategoryLabels[group.category]}
              <span className="num ml-2 text-[13px] font-normal text-faint">{group.findings.length}</span>
            </h3>
            {lead.length > 0 && (
              <ul className="mt-2 divide-y divide-border border-y border-border">
                {lead.map((finding, index) => (
                  <FindingItem key={`${finding.title}-${String(index)}`} finding={finding} />
                ))}
              </ul>
            )}
            {rest.length > 0 && (
              <details className="mt-2" data-testid="findings-rest">
                <summary className="cursor-pointer py-1 text-[13.5px] text-muted-foreground hover:text-foreground">
                  {restLabel}
                </summary>
                <ul className="mt-1 divide-y divide-border border-y border-border">
                  {rest.map((finding, index) => (
                    <FindingItem key={`${finding.title}-${String(index)}`} finding={finding} compact />
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
      {standardLine}
    </div>
  );
}

/** Сколько главных выводов группы показано сразу, без раскрытия. */
const MAX_LEAD_FINDINGS = 5;

const SEVERITY_RANK: Record<AnalysisFinding["severity"], number> = { high: 0, medium: 1, low: 2 };

/** Подробность длиннее этого после двух строк обрезается — полный текст лежит в раскрывашке. */
const DETAIL_CLAMP_CHARS = 150;

/** Один вывод: название и важность, суть в две строки, цитата и источник — по клику. */
function FindingItem({ finding, compact = false }: { finding: AnalysisFinding; compact?: boolean }) {
  const { sources, legal_note: legalNote } = finding as Partial<ConsolidatedFinding>;
  const longDetail = finding.detail.length > DETAIL_CLAMP_CHARS;
  const hasProof =
    longDetail || finding.evidence_quote !== "" || finding.evidence_section !== "" || (sources?.length ?? 0) > 0;
  return (
    <li className={compact ? "py-2.5" : "py-4"}>
      <div className="flex items-start justify-between gap-4">
        <span className={cn("font-medium text-foreground", compact ? "text-[14.5px]" : "text-[15px]")}>{finding.title}</span>
        <Badge tone={severityTone[finding.severity]}>{findingSeverityLabels[finding.severity]}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground" title={longDetail ? finding.detail : undefined}>
        {finding.detail}
      </p>
      <FindingProvenance legalNote={legalNote} />
      {hasProof && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[13px] text-faint hover:text-muted-foreground">Цитата и источник</summary>
          {longDetail && <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{finding.detail}</p>}
          {(finding.evidence_quote !== "" || finding.evidence_section !== "") && (
            <p className="mt-1.5 text-[13px] italic leading-snug text-faint">
              {finding.evidence_quote !== "" && <>«{finding.evidence_quote}»</>}
              {finding.evidence_section !== "" && <span className="ml-1 not-italic">— {finding.evidence_section}</span>}
            </p>
          )}
          <FindingProvenance sources={sources} />
        </details>
      )}
    </li>
  );
}

/**
 * Оговорка о доверии к выводам. Какая именно модель и на каком сервере это
 * сделала, читателю не нужно: важно, что вывод автоматический и цитату надо
 * сверить с первоисточником.
 */
function PanelFooter({ summary }: { summary: DeepAnalysisSummary }) {
  if (summary.state === "unsupported" || summary.state === "not_started")
    return null;
  return (
    <p className="muted text-xs">
      Выводы сделаны автоматически по тексту документов и могут быть неполными:
      проверяйте цитаты по первоисточнику.
    </p>
  );
}
