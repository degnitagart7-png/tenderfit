"use client";

import { KONTUR_ENABLED } from "@/domain/features";
import { useCallback, useEffect, useState } from "react";
import { Calculator, Download, ExternalLink, RefreshCw } from "lucide-react";
import { EstimateResult } from "@/components/estimate/EstimateResult";
import { useEstimateJob } from "@/hooks/useEstimateJob";
import { DAILY_ANALYSIS_LIMIT } from "@/domain/analysisQuota";
import { cn } from "@/lib/cn";
import {
  deepAnalysisFingerprint,
  groupDocuments,
  summarizeDeepAnalysis,
  type DeepAnalysisState,
  type DeepAnalysisSummary,
  type DocumentGroup,
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
  deepAnalysisStateLabels,
  documentSkippedLabel,
  findingCategoryLabels,
  findingSeverityLabels,
  parsedStatusLabels,
  verdictShort,
} from "@/lib/labels";
import { formatDateTime, formatFileSize, pluralRu } from "@/utils/format";

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

const POLL_INTERVAL_MS = 15_000;

/** Состояния, в которых результат может появиться без участия пользователя. */
const ACTIVE_STATES: readonly DeepAnalysisState[] = [
  "queued",
  "analyzing",
  "resuming",
];

const stateTone: Record<
  DeepAnalysisState,
  "olive" | "mustard" | "brick" | "neutral" | "accent"
> = {
  unsupported: "neutral",
  not_started: "neutral",
  queued: "mustard",
  analyzing: "accent",
  resuming: "accent",
  completed: "olive",
  failed: "brick",
};

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
}

export function DeepAnalysisPanel({
  tenderId,
  dataSource,
  subject,
  onStarted,
}: DeepAnalysisPanelProps) {
  const [status, setStatus] = useState<DeepAnalysisStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [card, setCard] = useState<KonturCardStatus | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Итог последней ручной проверки: когда и что изменилось. */
  const [lastCheck, setLastCheck] = useState<{
    at: Date;
    changed: boolean;
  } | null>(null);

  /*
    `announce` отличает ручную проверку от фоновой.

    Опрос раз в 15 секунд обязан молчать: строка «изменений нет», мигающая сама
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
      })
    : null;
  const isActive = summary !== null && ACTIVE_STATES.includes(summary.state);

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

  const exportDocx = async (current: DeepAnalysisSummary) => {
    setExporting(true);
    try {
      const { buildDeepAnalysisDocx, deepAnalysisFileName } = await import(
        "@/services/deepAnalysisExport"
      );
      const generatedAt = new Date();
      const bytes = await buildDeepAnalysisDocx({
        regNumber: tenderId,
        subject,
        summary: current,
        generatedAt,
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

  return (
    <Card
      title="Глубокий анализ документации"
      actions={
        summary ? (
          <Badge tone={stateTone[summary.state]}>
            {deepAnalysisStateLabels[summary.state]}
          </Badge>
        ) : null
      }
    >
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
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              {summary.title}
            </p>
            <p className="muted text-sm mt-1">{summary.detail}</p>
            {error && <p className="text-xs text-brick-fg mt-1">{error}</p>}
          </div>

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
            canEstimate={summary.documentsWithText > 0}
            estimating={
              estimateJob.status === "queued" ||
              estimateJob.status === "running"
            }
            onEstimate={() => void estimateJob.start({ tenderId, subject })}
          />

          {(estimateJob.status === "queued" ||
            estimateJob.status === "running") && (
            <p className="muted text-sm">
              {estimateJob.status === "queued"
                ? "Расчёт в очереди — его заберёт сервер с базой нормативов."
                : "Сервер читает ведомость объёмов и считает смету."}{" "}
              Страницу можно закрыть: результат сохранится в закупке.
            </p>
          )}
          {estimateJob.error !== null && (
            <p className="text-sm text-brick-fg">{estimateJob.error}</p>
          )}
          {estimateJob.result !== null && (
            <EstimateResult data={estimateJob.result} regNumber={tenderId} />
          )}

          {KONTUR_ENABLED && (
            <KonturCardBlock
              tenderId={tenderId}
              card={card}
              cardError={cardError}
              onRetry={() => void loadCard()}
              refresh={refreshAfterPurchase}
            />
          )}

          {summary.verdictChange && (
            <div className="rounded-md border border-brick/45 bg-brick/5 px-3 py-2">
              <p className="text-sm font-medium text-brick-fg">
                Вердикт пересмотрен по итогам разбора документации
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {summary.verdictChange.from
                  ? `${verdictShort[summary.verdictChange.from]} → `
                  : ""}
                {verdictShort[summary.verdictChange.to]} ·{" "}
                {summary.verdictChange.reason}
              </p>
              <p className="muted text-xs mt-0.5">
                {formatDateTime(summary.verdictChange.at)}
              </p>
            </div>
          )}

          <DocumentsList summary={summary} dataSource={dataSource} />
          <FindingsList summary={summary} />
          <PanelFooter summary={summary} />
        </div>
      )}
    </Card>
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
  canEstimate,
  estimating,
  onEstimate,
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
  canEstimate: boolean;
  estimating: boolean;
  onEstimate: () => void;
}) {
  if (summary.state === "unsupported") return null;

  /*
    Выгрузка предлагается, только когда в документе будет что читать.

    Файл Word с одной строкой «разбор не запускался» партнёру не нужен, а кнопка
    рядом с пустым разбором обещает результат, которого нет.
  */
  const canExport = summary.documents.length > 0 || summary.findings.length > 0;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {canStart && (
          <Button size="sm" onClick={onStart} disabled={starting}>
            {starting ? "Ставим в очередь..." : "Запустить глубокий анализ"}
          </Button>
        )}
        <Button
          variant="secondary"
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
        {canEstimate && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onEstimate}
            disabled={estimating}
            className="gap-1.5"
          >
            <Calculator className="h-3.5 w-3.5" />
            {estimating ? "Читаем ведомость..." : "Рассчитать смету"}
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
  return `Текст загружен сервером в России ${origin}.`;
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
          Задание поставлено: сервер в России откроет карточку Контур.Закупок,
          скачает документацию и сразу запустит разбор моделью.
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
        ЕИС не публикует вкладку документов для коммерческих закупок, а плановая
        синхронизация берёт файлы только оттуда. Единственный источник —
        карточка Контур.Закупок: один платный запрос, после которого
        документацию скачает сервер в России и разберёт модель.
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
    return "Задача разбора уже стоит в очереди: новый расход суточного лимита не понадобится.";
  }
  return (
    `Разбор моделью стоит около 6 ₽ и входит в суточный лимит: осталось ${remaining} ` +
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
  if (!archive) {
    return "В разбор попала часть текста: бюджет знаков на закупку кончился.";
  }
  return (
    `В разбор попала часть текста: бюджет знаков на закупку кончился, ` +
    `из архива прочитано ${archive.parsed} из ${archive.total} ` +
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

function FindingsList({ summary }: { summary: DeepAnalysisSummary }) {
  if (summary.findingGroups.length === 0) {
    if (summary.state !== "completed") return null;
    return (
      <p className="muted text-sm">
        Значимых факторов в документации не найдено. Это не гарантия: модель
        отвечает только за то, что указано в тексте извещения.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {summary.findingGroups.map((group) => (
        <div key={group.category}>
          <p className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1.5">
            {findingCategoryLabels[group.category]}
            <span className="muted font-normal normal-case ml-1.5">
              {group.findings.length}{" "}
              {pluralRu(group.findings.length, [
                "фактор",
                "фактора",
                "факторов",
              ])}
            </span>
          </p>
          <ul className="space-y-2">
            {group.findings.map((finding, index) => (
              <li
                key={`${finding.title}-${index}`}
                className="rounded-md border border-border p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {finding.title}
                  </span>
                  <Badge tone={severityTone[finding.severity]}>
                    {findingSeverityLabels[finding.severity]}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {finding.detail}
                </p>
                <blockquote className="mt-2 border-l-2 border-olive/60 pl-2 text-xs text-muted-foreground italic">
                  «{finding.evidence_quote}»
                  <span className="muted not-italic ml-1">
                    — {finding.evidence_section}
                  </span>
                </blockquote>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Чем именно сделан вывод: без этого факторы из документа неотличимы от скоринга
 * по метаданным, а уровень доверия к ним разный.
 */
function PanelFooter({ summary }: { summary: DeepAnalysisSummary }) {
  if (summary.state === "unsupported" || summary.state === "not_started")
    return null;
  return (
    <p className="muted text-xs">
      Документацию скачивает сервер в России, текст разбирает модель
      {summary.modelUsed ? ` ${summary.modelUsed}` : ""}. Выводы могут быть
      неполными: проверяйте цитаты по первоисточнику.
    </p>
  );
}
