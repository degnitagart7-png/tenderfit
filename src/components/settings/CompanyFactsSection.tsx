"use client";

import { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";

import { CompanyFactsEditor } from "@/components/settings/CompanyFactsEditor";
import { DocumentUploader } from "@/components/settings/DocumentUploader";
import { Button } from "@/components/ui/primitives";
import { buildSendPreview } from "@/domain/companyFacts/preview";
import { formatScrubStats, totalScrubStats } from "@/domain/companyFacts/scrubPii";
import { COMPANY_DOCUMENT_CATEGORY_LABELS, factsHaveContent, type CompanyFacts } from "@/domain/companyFacts/types";
import type { CompanyDocument } from "@/domain/entities";
import { cn } from "@/lib/cn";
import { companyApiService, type FactsApiResult } from "@/services/companyApiService";
import { formatDate } from "@/utils/format";

/**
 * «Документы компании для анализа»: загрузка документов, предпросмотр «Что уйдёт в ИИ», обновление профиля и сводка фактов.
 *
 * Порядок для человека:
 *  1. загружает документы (прайс, контракты, СРО, лицензии, кадры, техника — что захочет);
 *  2. нажимает «Обновить профиль по документам» — и видит, ЧТО уйдёт в ИИ: очищенный текст каждого документа, сколько личного
 *     скрыто и что в лимит не вошло. Отправка — только после второго нажатия;
 *  3. получает факты о компании (виды работ, контракты, СРО, лицензии, цены…), правит или удаляет строки.
 *
 * Приватность. Очистка выполняется здесь, в браузере, теми же функциями, что и на сервере: серверу уходит уже очищенный текст,
 * необработанный не покидает устройство; сервер чистит его ещё раз. Модель получает только деловые сведения.
 * Факты сохраняются в анкете тем же путём синхронизации, что и остальное (`onFactsChange` → сохранение анкеты).
 */

export const FACTS_CONSENT_LINE =
  "В ИИ отправляются только деловые сведения; ФИО, телефоны, почта и паспортные данные удаляются заранее.";

type Stage = "idle" | "preview" | "loading";

export interface CompanyFactsSectionProps {
  documents: CompanyDocument[];
  onDocumentsChange: (documents: CompanyDocument[]) => void;
  facts: CompanyFacts | undefined;
  /**
   * Факты изменились (получены или поправлены). Возвращает, удалось ли сохранить анкету: нет — человеку сказано, что
   * изменения пока только на экране (нужно согласие на обработку ПД и верный ИНН — их проверяет форма).
   */
  onFactsChange: (facts: CompanyFacts | undefined) => boolean;
  companyInn: string;
  companyName: string;
}

export function CompanyFactsSection({ documents, onDocumentsChange, facts, onFactsChange, companyInn, companyName }: CompanyFactsSectionProps) {
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Omit<FactsApiResult, "facts"> | null>(null);
  const [saved, setSaved] = useState<boolean | null>(null);

  const preview = useMemo(
    () =>
      stage === "idle"
        ? null
        : buildSendPreview(
            documents.map((document) => ({ id: document.id, name: document.fileName, category: document.category, text: document.text })),
            { companyInn, ...(companyName.trim() === "" ? {} : { keep: [companyName] }) },
          ),
    [stage, documents, companyInn, companyName],
  );

  const send = async (): Promise<void> => {
    if (preview === null) return;
    setStage("loading");
    setError(null);
    try {
      // Серверу уходит ровно очищенный текст, показанный в предпросмотре.
      const result = await companyApiService.extractFacts({
        documents: preview.documents.map((document) => ({ id: document.id, name: document.name, category: document.category, text: document.cleanText })),
        ...(companyInn.trim() === "" ? {} : { companyInn }),
        ...(companyName.trim() === "" ? {} : { companyName }),
      });
      const { facts: next, ...rest } = result;
      setOutcome(rest);
      setSaved(onFactsChange(next));
      setStage("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось обновить профиль по документам");
      setStage("preview");
    }
  };

  const edit = (next: CompanyFacts): void => setSaved(onFactsChange(next));

  const hasDocuments = documents.length > 0;
  const hasFacts = factsHaveContent(facts);

  return (
    <div className="space-y-4" data-testid="company-facts-section">
      <p className="flex items-start gap-2 text-[14px] leading-relaxed text-ink-soft">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-olive-fg" aria-hidden />
        <span>
          {FACTS_CONSENT_LINE} Загрузите прайс-лист, реестр контрактов, выписки СРО, лицензии, сведения о кадрах и технике — анализ закупок
          будет учитывать ваш опыт.
        </span>
      </p>

      <DocumentUploader documents={documents} onChange={onDocumentsChange} />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={hasFacts ? "secondary" : "primary"}
          size="sm"
          disabled={!hasDocuments || stage === "loading"}
          loading={stage === "loading"}
          onClick={() => {
            setError(null);
            setStage("preview");
          }}
        >
          Обновить профиль по документам
        </Button>
        {!hasDocuments && <span className="muted">Сначала добавьте документы.</span>}
      </div>

      {error !== null && (
        <p className="text-[13.5px] text-brick-fg" role="alert">
          {error}
        </p>
      )}

      {preview !== null && stage !== "idle" && (
        <section className="space-y-3 rounded-card border border-border bg-panel-raised p-4" aria-label="Что уйдёт в ИИ" data-testid="send-preview">
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Что уйдёт в ИИ</h3>
            <p className="mt-1 text-[13.5px] text-muted-foreground" data-testid="send-preview-summary">
              {preview.calls === 0
                ? "Из загруженных документов в ИИ нечего отправлять: после очистки читаемого текста не осталось."
                : `Ровно этот очищенный текст: ${preview.sentChars.toLocaleString("ru-RU")} знаков, запросов к ИИ — ${String(preview.calls)}.`}{" "}
              {totalScrubStats(preview.stats) > 0 ? `Скрыто: ${formatScrubStats(preview.stats)}.` : "Личных данных в тексте не найдено."}
            </p>
          </div>

          <ul className="divide-y divide-border border-y border-border">
            {preview.documents.map((document) => (
              <li key={document.id} className="py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[14px] font-medium text-foreground">
                    {document.name}{" "}
                    <span className="font-normal text-muted-foreground">· {COMPANY_DOCUMENT_CATEGORY_LABELS[document.category]}</span>
                  </span>
                  <span className={cn("text-[12.5px]", document.status === "sent" ? "text-muted-foreground" : "text-mustard-fg")}>
                    {document.status === "skipped" ? "не уйдёт" : document.status === "partial" ? "уйдёт частично" : "уйдёт целиком"}
                    {totalScrubStats(document.stats) > 0 ? ` · скрыто: ${formatScrubStats(document.stats)}` : ""}
                  </span>
                </div>
                {document.note !== null && <p className="mt-0.5 text-[12.5px] text-mustard-fg">{document.note}</p>}
                {document.sentText !== "" && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-[12.5px] text-accent-fg hover:underline">Показать текст, который уйдёт в ИИ</summary>
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-panel p-2 text-[12.5px] text-muted-foreground">
                      {document.sentText}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>

          <p className="text-[12.5px] text-muted-foreground">
            Метки вроде [ФИО] и [телефон] — место, где было личное. Проверьте текст: если увидели что-то личное, что скрыто не было, удалите документ
            или исправьте файл и загрузите заново.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void send()} disabled={preview.calls === 0 || stage === "loading"} loading={stage === "loading"}>
              Отправить в ИИ и обновить профиль
            </Button>
            <Button size="sm" variant="ghost" disabled={stage === "loading"} onClick={() => setStage("idle")}>
              Отмена
            </Button>
          </div>
        </section>
      )}

      {outcome !== null && stage === "idle" && (
        <div className="space-y-1 text-[13.5px]" data-testid="facts-outcome">
          {outcome.failedCalls > 0 && (
            <p className="text-mustard-fg">Часть документов обработать не удалось ({outcome.failedCalls} из {outcome.calls} запросов): результат неполный, повторите позже.</p>
          )}
          {outcome.truncated && <p className="text-mustard-fg">Не весь текст вошёл в лимит объёма — прочитано начало длинных документов.</p>}
          {outcome.skipped.map((item) => (
            <p key={item.id} className="text-mustard-fg">
              {item.name}: {item.reason}.
            </p>
          ))}
          {outcome.droppedForPii > 0 && (
            <p className="text-muted-foreground">Записей отброшено как содержащих личные данные: {outcome.droppedForPii}.</p>
          )}
          {saved === false && (
            <p className="text-mustard-fg">
              Изменения пока только на экране: поставьте согласие на обработку персональных данных вверху страницы и нажмите «Сохранить».
            </p>
          )}
          {saved === true && <p className="text-olive-fg">Профиль по документам обновлён и сохранён.</p>}
        </div>
      )}

      {facts !== undefined && (
        <section className="space-y-2" aria-label="Что мы поняли о компании">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Что мы поняли о компании</h3>
            <button
              type="button"
              className="text-[12.5px] text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => setSaved(onFactsChange(undefined))}
            >
              Очистить факты
            </button>
          </div>
          <p className="text-[12.5px] text-muted-foreground" data-testid="facts-meta">
            Обновлено {formatDate(facts.extractedAt)}
            {facts.sourceDocuments.length > 0 ? ` · из документов: ${facts.sourceDocuments.join(", ")}` : ""}
            {totalScrubStats(facts.scrubStats) > 0 ? ` · перед отправкой скрыто: ${formatScrubStats(facts.scrubStats)}` : ""}
          </p>
          {hasFacts ? (
            <CompanyFactsEditor facts={facts} onChange={edit} />
          ) : (
            <p className="text-[13.5px] text-muted-foreground">В документах деловых фактов не нашлось. Проверьте, что файлы читаются и содержат нужные сведения.</p>
          )}
          {saved === false && outcome === null && (
            <p className="text-[12.5px] text-mustard-fg">Правки пока только на экране: нажмите «Сохранить» вверху страницы.</p>
          )}
        </section>
      )}
    </div>
  );
}
