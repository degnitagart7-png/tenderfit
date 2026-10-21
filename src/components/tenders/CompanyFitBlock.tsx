"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/primitives";
import type { CompanyFitResult, FitRequirement, FitVerdict } from "@/domain/companyFacts/fit";
import { essenceOf, groupedRequirements, riskLines, shortTitle, summaryShort, verdictLine, type FitTone } from "@/domain/companyFacts/fitView";
import type { CompanyFitState } from "@/hooks/useCompanyFit";
import { cn } from "@/lib/cn";
import { formatDate, formatNumber } from "@/utils/format";

/**
 * «Соответствие вашей компании» в глубоком анализе — читается за секунды.
 *
 * Сверху главное: точка-светофор и итог одной строкой, под ним — одно предложение сути. Дальше только то, что требует внимания:
 * «не подходит», затем «нужно уточнить» — по строке на пункт (название — суть), подробности (что требует закупка, полное
 * основание, цитата, контракты) раскрываются по клику. «Подходит» — одной свёрнутой строкой; опыт по теме и риски — под
 * раскрытием, риски не больше трёх. Общий разбор закупки один на всех, а этот блок — свой у каждого.
 */

const VERDICT_DOT: Record<FitVerdict, string> = { ok: "bg-olive", check: "bg-mustard", fail: "bg-brick" };
const VERDICT_WORD: Record<FitVerdict, string> = { ok: "подходит", check: "нужно уточнить", fail: "не подходит" };
const TONE_DOT: Record<FitTone, string> = { good: "bg-olive", warn: "bg-mustard", bad: "bg-brick", neutral: "bg-border-strong" };

export interface CompanyFitBlockProps {
  state: CompanyFitState;
  /** Есть ли у человека факты из документов: нет — вместо результата приглашение загрузить документы. */
  hasFacts: boolean;
  onCheck: (force: boolean) => void;
}

export function CompanyFitBlock({ state, hasFacts, onCheck }: CompanyFitBlockProps) {
  const { result, status } = state;
  const loading = status === "loading";

  return (
    <section className="space-y-3" aria-label="Соответствие вашей компании" data-testid="company-fit">
      {/* На узком экране кнопка уходит под заголовок. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Соответствие вашей компании</h3>
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          loading={loading}
          disabled={loading}
          onClick={() => onCheck(result !== null && result.hasCompanyData)}
        >
          {result !== null && result.hasCompanyData ? "Проверить заново" : "Проверить соответствие"}
        </Button>
      </div>

      {status === "error" && (
        <p className="text-sm text-brick-fg" role="alert">
          {state.error}
        </p>
      )}

      {loading && result === null && <p className="text-[14px] text-muted-foreground">Сверяем требования закупки с вашей компанией…</p>}

      {result === null || !result.hasCompanyData ? (
        !loading &&
        status !== "error" && <NoDocumentsHint hasFacts={hasFacts} asked={result !== null} />
      ) : (
        <FitBody result={result} degraded={state.degraded} />
      )}
    </section>
  );
}

function NoDocumentsHint({ hasFacts, asked }: { hasFacts: boolean; asked: boolean }) {
  return (
    <p className="text-[14.5px] leading-relaxed text-muted-foreground" data-testid="company-fit-hint">
      {hasFacts && !asked ? "Нажмите «Проверить соответствие» — сверим требования закупки с вашей компанией." : "Загрузите документы компании — анализ учтёт ваш опыт: СРО, лицензии, контракты, кадры и технику."}{" "}
      <Link href="/settings/profile" className="text-accent-fg underline underline-offset-2">
        {hasFacts ? "Документы компании" : "Загрузить документы"}
      </Link>
    </p>
  );
}

/** « · 2025, 8 000 000 ₽, Администрация города» — что известно о контракте помимо предмета. */
function experienceFacts(item: CompanyFitResult["experience"][number]): string {
  const parts = [item.year === null ? null : String(item.year), item.sumRub === null ? null : `${formatNumber(item.sumRub)} ₽`, item.customer].filter(
    (part): part is string => part !== null && part !== "",
  );
  return parts.length === 0 ? "" : ` · ${parts.join(", ")}`;
}

/** Раскрывающийся список под одной строкой-заголовком: «Подходит · 3», «Риски · 2». */
function Disclosure({ title, count, testId, children }: { title: string; count: number; testId: string; children: React.ReactNode }) {
  return (
    <details className="group border-t border-border" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2.5 text-[14px] font-medium text-foreground [&::-webkit-details-marker]:hidden">
        <span>
          {title} <span className="font-normal text-muted-foreground">· {count}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-faint transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="pb-3">{children}</div>
    </details>
  );
}

/** Пункт: строка «название — суть» с точкой; подробности раскрываются. */
function RequirementRow({ item, experience }: { item: FitRequirement; experience: CompanyFitResult["experience"] }) {
  const matched = experience.filter((entry) => item.contractIds.includes(entry.contractId));
  return (
    <li data-verdict={item.verdict}>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-2.5 py-2.5 [&::-webkit-details-marker]:hidden">
          <span className={cn("mt-[7px] h-2 w-2 shrink-0 rounded-full", VERDICT_DOT[item.verdict])} aria-hidden />
          <span className="min-w-0 flex-1 text-[14.5px] leading-snug">
            <span className="sr-only">{VERDICT_WORD[item.verdict]}: </span>
            <span className="line-clamp-2 break-words sm:line-clamp-1">
              <span className="font-medium text-foreground">{shortTitle(item.title, 70)}</span>
              <span className="text-muted-foreground"> — {essenceOf(item.basis)}</span>
            </span>
          </span>
          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-faint transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-1 pb-3 pl-[18px] text-[13.5px]">
          <p className="font-medium text-foreground">{item.title}</p>
          {item.required !== null && <p className="text-muted-foreground">Требуется: {item.required}</p>}
          <p className="text-foreground">{item.basis}</p>
          {matched.length > 0 && (
            <p className="text-muted-foreground">
              Подтверждают: {matched.map((entry) => `${entry.subject}${experienceFacts(entry)}`).join("; ")}
            </p>
          )}
          {item.quote !== null && <p className="italic text-faint">«{item.quote}»</p>}
        </div>
      </details>
    </li>
  );
}

function FitBody({ result, degraded }: { result: CompanyFitResult; degraded: boolean }) {
  const line = verdictLine(result);
  const { fails, checks, oks } = groupedRequirements(result);
  const summary = summaryShort(result);
  const risks = riskLines(result);

  return (
    <div className="space-y-3">
      <div>
        <p className="flex items-start gap-2.5 text-[16px] font-semibold leading-snug tracking-tight text-foreground" data-testid="company-fit-overall" data-overall={result.overall}>
          <span className={cn("mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full", TONE_DOT[line.tone])} aria-hidden />
          <span className="min-w-0 break-words">{line.text}</span>
        </p>
        {summary.short !== "" && (
          <div className="mt-1.5 pl-5 text-[14px] leading-relaxed text-foreground" data-testid="company-fit-summary">
            <p className="line-clamp-3 sm:line-clamp-none">{summary.short}</p>
            {summary.full !== null && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[12.5px] text-accent-fg hover:underline">Подробнее</summary>
                <p className="mt-1 text-muted-foreground">{summary.full}</p>
              </details>
            )}
          </div>
        )}
        {degraded && (
          <p className="mt-1.5 pl-5 text-[13px] text-mustard-fg">ИИ сейчас не ответил: показаны проверки по правилам, этот результат не сохранён — нажмите «Проверить заново».</p>
        )}
      </div>

      {(fails.length > 0 || checks.length > 0) && (
        <ul className="divide-y divide-border border-y border-border" data-testid="company-fit-requirements">
          {[...fails, ...checks].map((item) => (
            <RequirementRow key={item.id} item={item} experience={result.experience} />
          ))}
        </ul>
      )}

      <div>
        {oks.length > 0 && (
          <Disclosure title="Подходит" count={oks.length} testId="company-fit-ok">
            <ul className="space-y-1.5" data-testid="company-fit-ok-items">
              {oks.map((item) => (
                <li key={item.id} data-verdict="ok" className="flex items-start gap-2.5 text-[13.5px] leading-snug">
                  <span className={cn("mt-[6px] h-2 w-2 shrink-0 rounded-full", VERDICT_DOT.ok)} aria-hidden />
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-foreground">{shortTitle(item.title, 70)}</span>
                    <span className="text-muted-foreground"> — {essenceOf(item.basis)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {result.experience.length > 0 && (
          <Disclosure title="Опыт по теме закупки" count={result.experience.length} testId="company-fit-experience">
            <ul className="space-y-1.5">
              {result.experience.map((item) => (
                <li key={item.contractId} className="text-[13.5px] leading-snug text-foreground">
                  <span className="break-words">{item.subject}</span>
                  <span className="text-muted-foreground">{experienceFacts(item)}</span>
                  {item.why !== "" && <span className="block text-[12.5px] text-muted-foreground">{item.why}</span>}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {risks.length > 0 && (
          <Disclosure title="Риски" count={risks.length} testId="company-fit-risks">
            <ul className="list-disc space-y-1 pl-5 text-[13.5px] leading-snug text-foreground">
              {risks.map((risk) => (
                <li key={risk} className="break-words">
                  {risk}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>

      <p className="text-[12px] leading-snug text-faint">
        {result.basisNote} {result.llmUsed ? "Правила и ИИ" : "Правила"}
        {result.computedAt !== "" ? ` · ${formatDate(result.computedAt)}` : ""}
      </p>
    </div>
  );
}
