"use client";

import { WorkProgress } from "@/components/ui/WorkProgress";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Calculator, ChevronDown, FileText, ShieldCheck, Upload, X } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { Badge, Button, Input } from "@/components/ui/primitives";
import { CustomerAuditCard } from "@/components/estimate/CustomerAuditCard";
import { EstimateHistoryList } from "@/components/estimate/EstimateHistoryList";
import { EstimateMethodSelect } from "@/components/estimate/EstimateMethodSelect";
import { EstimateRegionPicker } from "@/components/estimate/EstimateRegionPicker";
import { EstimateResult } from "@/components/estimate/EstimateResult";
import { SsrAuditCard } from "@/components/estimate/SsrAuditCard";
import { WorkConditionsBlock } from "@/components/estimate/WorkConditionsBlock";
import { parseCustomerEstimates } from "@/domain/estimate/customerEstimate";
import { summarizeCustomerConditions } from "@/domain/estimate/customerCoefficients";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet, lsrSourceInfo } from "@/domain/estimate/customerLsrSet";
import { hasEstimateOptions, NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import { computeSsrLayer } from "@/domain/estimate/ssrLayer";
import { useBillEdits } from "@/hooks/useBillEdits";
import { useEstimateHistory } from "@/hooks/useEstimateHistory";
import { useEstimateAuditJob, useEstimateJob, type EstimateJobView } from "@/hooks/useEstimateJob";
import { usePriceZones } from "@/hooks/usePriceZones";
import { cn } from "@/lib/cn";
import { readJsonOrThrow } from "@/lib/readJson";
import { isUnreadableText } from "@/services/documentParser";
import { parseDocumentSmart } from "@/services/serverDocumentParse";
import type { ArchiveReport } from "@/types/database";
import { formatDateTime, formatFileSize } from "@/utils/format";

/**
 * Расчёт сметы по своей документации.
 *
 * Зачем отдельный экран, когда кнопка есть в карточке закупки. Закупка нужна не
 * всегда: сметой проверяют своё коммерческое предложение, считают объект вне
 * торгов, пересчитывают чужую смету. Требовать ради этого завести закупку
 * значит заставить выдумать номер, которого нет.
 *
 * Возможности те же, что у сметы в глубоком анализе: метод расчёта, условия
 * работ, правки ведомости с пересчётом, сводный расчёт, сравнение со сметой
 * заказчика и её проверка по ценам зоны. Расхождение экранов означало бы, что
 * одна и та же ведомость даёт разные числа в зависимости от того, где её загрузили.
 *
 * Файлы разбираются в браузере, а не отправляются целиком: документация
 * закупки — это десятки мегабайт, из которых серверу нужен только текст.
 * Исключение — старый бинарный .doc и архивы (zip, rar, 7z): браузер их не
 * читает, и они уходят на серверный разбор (`/api/documents/parse`, до 50 МБ,
 * без распознавания сканов). Для закупок Сбербанк-АСТ, Фабриканта и ЭТП ГПБ
 * документы робот не скачивает, человек берёт их на площадке — как правило,
 * архивом. Скан внутри архива пропускается с причиной, и она показана в списке.
 *
 * Под формой — «Мои расчёты»: прежние расчёты этого человека от нового к старому (раньше результат жил
 * только на экране и терялся вместе с вкладкой). Расчёт открывается на этой же странице, адрес
 * `?job=<номер>` его хранит: так ведёт ссылка из письма «смета готова», и обновление страницы не
 * теряет открытый результат. Чужой или несуществующий номер — «Расчёт не найден»: сервер не отличает одно
 * от другого (см. `/api/estimate`). Открытый из списка расчёт показывается без сравнения со сметой
 * заказчика и без сводного расчёта: они строятся из файлов, которые сейчас лежат в форме, а у прежнего
 * расчёта текстов файлов нет — сервер их не отдаёт, и сравнивать пришлось бы с чужим набором.
 */

/** Расчёт, который показан на странице вне формы: открытый из списка, по ссылке или только что поставленный. */
interface OpenedJob {
  readonly id: string;
  /** Только что поставлен с этого экрана: файлы формы — его файлы, сравнение со сметой заказчика уместно. */
  readonly fresh: boolean;
  readonly subject: string | null;
  readonly createdAt: string | null;
}

/**
 * Номер расчёта в адресе страницы: `?job=…`. Пишется через историю браузера: Next 14 сводит
 * `pushState` с `useSearchParams`, так что роутер и экран видят один и тот же адрес.
 */
function writeJobToUrl(id: string | null, mode: "push" | "replace"): void {
  try {
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete("job");
    else url.searchParams.set("job", id);
    if (url.href === window.location.href) return;
    if (mode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  } catch {
    // Адрес — удобство, а не условие работы: без него расчёт открывается так же.
  }
}

interface LoadedDocument {
  readonly name: string;
  readonly text: string;
  readonly size: number;
  /** В файле нашлась смета (ЛСР или сводная) — её можно сравнить и проверить. */
  readonly hasEstimate: boolean;
  /** Для архива: сколько файлов прочитано из скольких и какие пропущены. */
  readonly archive?: ArchiveReport;
}

/** Архив, из которого ничего не прочитано: в расчёт он не идёт, но что в нём было — человеку показываем. */
interface UnreadArchive {
  readonly name: string;
  readonly report: ArchiveReport;
}

/**
 * Что в архиве не прочитано, и почему. Свёрнуто: список бывает в сотни строк (в
 * архиве проектной документации чертежей и сканов больше, чем текста), а нужен
 * он, когда непонятно, почему смета вышла без части документов.
 */
function SkippedFiles({ report }: { report: ArchiveReport }) {
  const skipped = report.skipped ?? [];
  if (skipped.length === 0) return null;
  return (
    <details className="mt-1.5 text-[13px]" data-testid="archive-skipped">
      <summary className="muted cursor-pointer select-none">Не прочитано: {skipped.length}</summary>
      <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto pl-4">
        {skipped.map((entry, index) => (
          <li key={`${entry.name}-${String(index)}`} className="muted">
            <span className="break-all text-foreground">{entry.name}</span> — {entry.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

/*
  Форматы выбора файла. Браузерный разбор (documentParser.parseDocument) читает
  всё, кроме старого .doc и архивов: их читает сервер (serverDocumentParse.ts).
  Сканы-картинки в список намеренно не входят: распознавание на этом экране
  выключено, и файл прошёл бы выбор и тут же вернулся бы «Неподдерживаемый
  формат». Скан внутри архива не ошибка — он попадает в список пропущенных.
*/
const ACCEPT = ".pdf,.docx,.doc,.xlsx,.xls,.xlsm,.ods,.ots,.odt,.ott,.rtf,.csv,.txt,.zip,.rar,.7z";

/** «1 файла», «5 файлов»: после «из» стоит родительный падеж. */
function filesWord(total: number): string {
  return total % 10 === 1 && total % 100 !== 11 ? "файла" : "файлов";
}

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-4 gap-y-3 py-5 first:pt-0 last:pb-0 sm:grid-cols-[2rem_1fr]">
      <span
        aria-hidden
        className="num hidden h-7 w-7 items-center justify-center rounded-full border border-accent-line bg-accent-subtle text-[13px] font-semibold text-accent-fg sm:flex"
      >
        {n}
      </span>
      <div className="min-w-0 space-y-3">
        <div>
          <h2 className="text-[15.5px] font-semibold tracking-tight text-foreground">{title}</h2>
          {hint !== undefined && <p className="muted mt-0.5 text-[13.5px]">{hint}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

export function EstimateUploadView() {
  const [documents, setDocuments] = useState<LoadedDocument[]>([]);
  const [subject, setSubject] = useState("");
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreadArchives, setUnreadArchives] = useState<UnreadArchive[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const job = useEstimateJob();
  const auditJob = useEstimateAuditJob();
  const history = useEstimateHistory();
  const { show: showEstimate, reset: resetEstimate } = job;
  const { show: showAudit, reset: resetAudit } = auditJob;
  const { refresh: refreshHistory } = history;

  const [opened, setOpened] = useState<OpenedJob | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const openTicket = useRef(0);
  const requested = useRef<string | null>(null);
  const resultTop = useRef<HTMLDivElement>(null);
  const priceZones = usePriceZones();
  const [pickedZone, setPickedZone] = useState<number | null>(null);
  const [options, setOptions] = useState<EstimateOptions>(NO_ESTIMATE_OPTIONS);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const calculating = job.status === "queued" || job.status === "running";
  const auditing = auditJob.status === "queued" || auditJob.status === "running";

  /*
    Список перечитывается, когда меняется состояние расчёта на экране: поставили (появилась строка
    сверху), закончился (строка стала «готово» с суммой). Первый запуск — это и есть первая загрузка.
  */
  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory, job.status, auditJob.status]);

  /** Открыть расчёт по номеру: прочитать, показать хуком его режима, записать номер в адрес. */
  const openJob = useCallback(
    async (id: string, options: { push: boolean; scroll: boolean }): Promise<void> => {
      const ticket = ++openTicket.current;
      setOpening(true);
      setOpenError(null);
      requested.current = id;
      if (options.push) writeJobToUrl(id, "push");
      try {
        const response = await fetch(`/api/estimate?jobId=${encodeURIComponent(id)}`);
        const payload = await readJsonOrThrow<{ job?: EstimateJobView | null }>(response);
        // Пока шёл ответ, открыли другой расчёт: этот ответ устарел.
        if (ticket !== openTicket.current) return;
        const view = payload.job ?? null;
        if (view === null) {
          resetEstimate();
          resetAudit();
          setOpened(null);
          setOpenError("Расчёт не найден: такого номера нет, или он посчитан другим пользователем.");
          return;
        }
        setOpened({ id: view.id, fresh: false, subject: view.subject ?? null, createdAt: view.createdAt ?? null });
        if ((view.mode ?? "estimate") === "audit") {
          resetEstimate();
          showAudit(view);
        } else {
          resetAudit();
          showEstimate(view);
        }
        if (options.scroll) setTimeout(() => resultTop.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
      } catch (err) {
        if (ticket !== openTicket.current) return;
        setOpenError(err instanceof Error ? err.message : "Расчёт не открылся");
      } finally {
        if (ticket === openTicket.current) setOpening(false);
      }
    },
    [resetEstimate, resetAudit, showEstimate, showAudit],
  );

  /*
    Номер в адресе — источник правды для того, что открыто. Ссылка из письма или обновлённая страница
    открывают расчёт сразу; «назад» и переход по ссылке «Смета» в меню меняют адрес — и страница
    следует за ним. `requested` помнит номер, который открыла сама страница (клик в списке, только
    что поставленный расчёт): его появление в адресе — не новая команда, повторно читать расчёт не надо.
  */
  const searchParams = useSearchParams();
  const rawUrlJob = searchParams?.get("job")?.trim() ?? "";
  const urlJobId = rawUrlJob === "" ? null : rawUrlJob;
  useEffect(() => {
    if (urlJobId === requested.current) return;
    requested.current = urlJobId;
    if (urlJobId === null) {
      openTicket.current += 1;
      resetEstimate();
      resetAudit();
      setOpened(null);
      setOpening(false);
      setOpenError(null);
    } else {
      void openJob(urlJobId, { push: false, scroll: false });
    }
  }, [urlJobId, openJob, resetEstimate, resetAudit]);

  const closeOpened = (): void => {
    openTicket.current += 1;
    resetEstimate();
    resetAudit();
    setOpened(null);
    setOpening(false);
    setOpenError(null);
    requested.current = null;
    writeJobToUrl(null, "push");
  };

  /** Расчёт, поставленный с этого экрана, становится «открытым»: адрес с номером переживёт обновление. */
  const adopt = (id: string | null): void => {
    if (id === null) return;
    openTicket.current += 1;
    setOpening(false);
    setOpenError(null);
    setOpened({ id, fresh: true, subject: null, createdAt: null });
    requested.current = id;
    writeJobToUrl(id, "push");
  };

  // Прежний расчёт из списка: файлов, на которые он опирался, в форме нет.
  const historic = opened !== null && !opened.fresh;

  // Правки ведомости без закупки живут на экране: объём поправили — смета пересчитана без модели.
  const billEditor = useBillEdits({ tenderId: undefined, jobId: job.jobId, result: job.result });
  const shownEstimate = billEditor?.effective ?? job.result;

  const docs = useMemo(() => documents.map((item) => ({ name: item.name, text: item.text })), [documents]);
  const documentsText = useMemo(() => docs.map((item) => item.text).join("\n"), [docs]);

  // Альтернативные сметы среди загруженного: с ними сравнивается наш расчёт, их же проверяет аудит.
  const customerEstimates = useMemo(() => parseCustomerEstimates(docs), [docs]);
  const lsrSet = useMemo(() => buildLsrSet(parseCustomerLsr(docs).estimates), [docs]);
  const customerLsrs = useMemo(() => lsrSet.entries.map(lsrSourceInfo), [lsrSet]);
  const customerCoefficients = useMemo(() => {
    const items = lsrSet.entries.flatMap((entry) => lsrBillSection(entry, 1).section.items);
    const summary = summarizeCustomerConditions(items);
    return { positions: summary.positions, confirmed: summary.confirmed, rejected: summary.rejected };
  }, [lsrSet]);
  const canAudit = customerEstimates.some((estimate) => estimate.sections.length > 0);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const ssrLayer = useMemo(
    () =>
      computeSsrLayer({
        estimate: shownEstimate?.document ?? null,
        options,
        // НМЦК у расчёта без закупки нет: сводный расчёт строится, сравнивать его не с чем.
        nmc: null,
        nmcIncludesVat: true,
        priceDate: null,
        today,
        documents: docs,
      }),
    [shownEstimate, options, today, docs],
  );

  const zoneNeeded = priceZones.zones.length > 0 && pickedZone === null;

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setReading(true);
    setError(null);
    setUnreadArchives([]);
    const loaded: LoadedDocument[] = [];
    const failed: string[] = [];
    const unread: UnreadArchive[] = [];

    for (const file of files) {
      try {
        const parsed = await parseDocumentSmart(file);
        /*
          Разбор не бросает исключение: он возвращает объяснение в поле текста.
          Отправить такое объяснение на сервер значит получить смету на ноль
          рублей, которая выглядит как настоящая, — поэтому нечитаемый файл
          попадает в список неудач, а не в расчёт.
        */
        if (isUnreadableText(parsed.text)) {
          failed.push(`${file.name}: ${parsed.text.trim()}`);
          if (parsed.archive) unread.push({ name: file.name, report: parsed.archive });
          continue;
        }
        if (parsed.text.trim().length === 0) {
          failed.push(`${file.name}: текста не нашлось`);
          continue;
        }
        const one = [{ name: file.name, text: parsed.text }];
        const hasEstimate =
          parseCustomerLsr(one).estimates.length > 0 ||
          parseCustomerEstimates(one).some((estimate) => estimate.sections.length > 0);
        loaded.push({
          name: file.name,
          text: parsed.text,
          size: file.size,
          hasEstimate,
          ...(parsed.archive ? { archive: parsed.archive } : {}),
        });
      } catch (err) {
        failed.push(`${file.name}: ${err instanceof Error ? err.message : "не читается"}`);
      }
    }

    setDocuments((current) => [...current, ...loaded]);
    setUnreadArchives(unread);
    if (failed.length > 0) setError(`Не прочитано — ${failed.join("; ")}`);
    setReading(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (reading) return;
    void addFiles([...event.dataTransfer.files]);
  };

  const zonePart = pickedZone === null ? {} : { priceZoneId: pickedZone };

  const calculate = async (): Promise<void> => {
    setError(null);
    const id = await job.start({
      subject: subject.trim() === "" ? "Расчёт по документации" : subject,
      documents: docs,
      ...zonePart,
      ...(hasEstimateOptions(options) ? { options } : {}),
    });
    adopt(id);
  };

  const audit = async (): Promise<void> => {
    setError(null);
    const id = await auditJob.start({
      subject: subject.trim() === "" ? "Проверка сметы" : subject,
      documents: docs,
      ...zonePart,
    });
    adopt(id);
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Смета</h1>
        <p className="muted mt-1 max-w-2xl">
          Локальный сметный расчёт по форме 421/пр из ваших документов — без закупки.
        </p>
      </div>

      <div className="card p-5 sm:p-6">
        <div className="divide-y divide-border">
          <Step n={1} title="Объект" hint="Название печатается в шапке сметы.">
            <Input
              aria-label="Наименование объекта"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Например: реконструкция запорных колодцев"
            />
          </Step>

          <Step
            n={2}
            title="Документы"
            hint="Ведомость объёмов работ, техническое задание или готовая смета — её сравним с нашим расчётом и проверим по ценам зоны."
          >
            <div
              role="button"
              tabIndex={0}
              aria-label="Добавить документы"
              onClick={() => fileInput.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileInput.current?.click();
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                "flex cursor-pointer flex-col items-center gap-1.5 rounded-control border border-dashed px-4 py-6 text-center transition-colors",
                dragging ? "border-accent bg-accent-subtle" : "border-border hover:border-accent-line hover:bg-panel-raised",
                reading && "pointer-events-none opacity-60",
              )}
            >
              <Upload className="h-5 w-5 text-faint" strokeWidth={1.75} aria-hidden />
              <p className="text-[14.5px] text-foreground">
                {reading ? (
                  "Читаем файлы…"
                ) : (
                  <>
                    Перетащите файлы сюда или <span className="text-accent-fg underline-offset-2 hover:underline">выберите</span>
                  </>
                )}
              </p>
              <p className="muted text-[12.5px]">
                PDF, Word (docx, doc), Excel (xlsx, xls), OpenDocument (odt, ods), RTF, CSV · файлы читаются у вас в браузере, отправляется только текст
              </p>
              <p className="muted text-[12.5px]">
                Архивы (zip, rar, 7z) и старые .doc читает сервер, до 50 МБ: загрузите архив документации с площадки как есть. Сканы внутри
                архива и сканы-картинки не распознаются — они попадут в список «Не прочитано». Родные файлы сметных программ (.gsfx, .xml)
                тоже не читаются — выгрузите смету в Excel или PDF.
              </p>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                tabIndex={-1}
                data-testid="estimate-files"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  // Сбрасываем input, иначе тот же файл второй раз не выберется.
                  event.target.value = "";
                  void addFiles(files);
                }}
              />
            </div>

            {documents.length > 0 && (
              <ul className="divide-y divide-border rounded-control border border-border">
                {documents.map((item, index) => (
                  <li key={`${item.name}-${String(index)}`} className="px-3 py-2 text-sm">
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 shrink-0 text-faint" strokeWidth={1.75} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-foreground">{item.name}</span>
                      {item.hasEstimate && (
                        <Badge tone="accent" dot={false} className="text-[12px]">
                          смета
                        </Badge>
                      )}
                      <span className="muted num hidden text-xs sm:inline">
                        {formatFileSize(item.size)} · {item.text.length.toLocaleString("ru-RU")} знаков
                      </span>
                      <button
                        type="button"
                        aria-label={`Убрать ${item.name}`}
                        onClick={() => setDocuments((current) => current.filter((_, at) => at !== index))}
                        className="text-faint hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {item.archive !== undefined && (
                      <div className="pl-7">
                        <p className="muted text-[13px]" data-testid="archive-summary">
                          Прочитано {item.archive.parsed} из {item.archive.total} {filesWord(item.archive.total)}
                        </p>
                        <SkippedFiles report={item.archive} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Step>

          <Step n={3} title="Регион" hint="По нему берутся цены ресурсов ФГИС ЦС.">
            <EstimateRegionPicker zones={priceZones} picked={pickedZone} onPick={setPickedZone} />
          </Step>

          <Step
            n={4}
            title="Метод и условия работ"
            hint={
              hasEstimateOptions(options)
                ? "Настроено вручную — учтём при расчёте."
                : "Необязательно. По умолчанию — ресурсно-индексный метод по ФСНБ-2022, без начислений сверх норм."
            }
          >
            {/* Двадцать контролов условий нужны редко: свёрнуты, пока человек сам не открыл. */}
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-[14.5px] text-accent-fg underline-offset-2 hover:underline"
              aria-expanded={optionsOpen}
              aria-controls="estimate-options"
              onClick={() => setOptionsOpen((open) => !open)}
            >
              {optionsOpen ? "Свернуть" : "Настроить"}
              <ChevronDown className={cn("h-4 w-4 transition-transform", optionsOpen && "rotate-180")} aria-hidden />
            </button>
            {optionsOpen && (
              <div id="estimate-options" className="space-y-3">
                <EstimateMethodSelect options={options} onChange={setOptions} text={documentsText} />
                <WorkConditionsBlock
                  options={options}
                  onChange={setOptions}
                  text={documentsText}
                  subject={subject}
                  customerCoefficients={customerCoefficients}
                />
              </div>
            )}
          </Step>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <Button
            onClick={() => void calculate()}
            disabled={documents.length === 0 || calculating || reading || zoneNeeded}
            className="gap-1.5"
          >
            <Calculator className="h-4 w-4" />
            {calculating ? "Считаем…" : "Рассчитать смету"}
          </Button>
          {canAudit && (
            <Button
              variant="secondary"
              onClick={() => void audit()}
              disabled={auditing || reading || zoneNeeded}
              className="gap-1.5"
            >
              <ShieldCheck className="h-4 w-4" />
              {auditing ? "Проверяем…" : "Проверить смету по ценам зоны"}
            </Button>
          )}
          {documents.length > 0 && zoneNeeded && <span className="muted text-sm">Выберите регион объекта</span>}
        </div>

        {(calculating || auditing || error !== null || job.error !== null || auditJob.error !== null) && (
          <div className="mt-3 space-y-1 text-sm">
            {calculating && (
              <WorkProgress
                title="Считаем смету"
                hint="Обычно это несколько минут. Страницу можно закрыть: результат сохранится."
                steps={["Принимаем расчёт", "Читаем ведомость и считаем"]}
                current={job.status === "queued" ? 0 : 1}
              />
            )}
            {auditing && (
              <WorkProgress
                title="Проверяем смету"
                hint="Это быстро: цены и арифметика сверяются автоматически."
                steps={["Сверяем цены и нормативы"]}
                current={0}
              />
            )}
            {error !== null && <p className="text-brick-fg">{error}</p>}
            {unreadArchives.map((item) => (
              <div key={item.name} className="muted">
                <p>
                  {item.name}: прочитано {item.report.parsed} из {item.report.total} {filesWord(item.report.total)}
                </p>
                <SkippedFiles report={item.report} />
              </div>
            ))}
            {job.error !== null && <p className="text-brick-fg">{job.error}</p>}
            {auditJob.error !== null && <p className="text-brick-fg">{auditJob.error}</p>}
          </div>
        )}
      </div>

      <div ref={resultTop} className="scroll-mt-4 space-y-5 empty:hidden">
        {opening && (
          <p className="muted text-sm" role="status" data-testid="estimate-opening">
            Открываем расчёт…
          </p>
        )}
        {openError !== null && (
          <div className="card p-4 text-sm" role="alert" data-testid="estimate-open-error">
            <p className="text-brick-fg">{openError}</p>
            <button type="button" className="mt-1 text-accent-fg underline-offset-2 hover:underline" onClick={closeOpened}>
              Закрыть
            </button>
          </div>
        )}
        {historic && !opening && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-accent-line bg-accent-subtle px-4 py-2.5 text-sm" data-testid="estimate-opened-banner">
            <span className="min-w-0 flex-1 text-foreground">
              Открыт расчёт{opened.createdAt !== null ? ` от ${formatDateTime(opened.createdAt)}` : ""}
              {opened.subject !== null && opened.subject.trim() !== "" ? ` — ${opened.subject}` : ""}
            </span>
            <button type="button" className="text-accent-fg underline-offset-2 hover:underline" onClick={closeOpened}>
              Закрыть
            </button>
          </div>
        )}

        {auditJob.result !== null && <CustomerAuditCard audit={auditJob.result} />}
        {!historic && ssrLayer.audits.length > 0 && <SsrAuditCard reports={ssrLayer.audits} />}
        {shownEstimate !== null && (
          <EstimateResult
            data={shownEstimate}
            editor={billEditor}
            regNumber={(historic ? opened.subject?.trim() : "") || subject || "расчёт"}
            customerEstimates={!historic && customerEstimates.length > 0 ? customerEstimates : undefined}
            customerLsrs={historic ? [] : customerLsrs}
            ssr={
              historic || ssrLayer.ssr === null
                ? null
                : { result: ssrLayer.ssr, comparison: ssrLayer.comparison, audits: ssrLayer.audits }
            }
          />
        )}
      </div>

      <EstimateHistoryList
        history={history}
        selectedId={opened?.id ?? null}
        onOpen={(id) => void openJob(id, { push: true, scroll: true })}
      />
    </div>
  );
}
