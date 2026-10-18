"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, X } from "lucide-react";

import { LogoMark } from "@/components/brand/LogoMark";
import { LawSwitcher } from "@/components/tenders/LawSwitcher";
import { TenderTable } from "@/components/tenders/TenderTable";
import { VerdictScore } from "@/components/tenders/VerdictScore";
import { Button } from "@/components/ui/primitives";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { countRowsByLaw, defaultFilters, filterRows, sortRows, type SortField, type TenderRow } from "@/domain/filtering";
import type { TenderLaw, TenderVerdict } from "@/domain/enums";
import { TENDER_VERDICTS } from "@/domain/enums";
import { verdictLabels } from "@/lib/labels";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { demoTenders } from "@/mocks/tenders";
import { formatNumber } from "@/utils/format";

/**
 * Демо-лента для гостя: закупки с вердиктами без регистрации.
 *
 * Зачем. Крупные агрегаторы дают потрогать ленту до регистрации и закрывают
 * только карточку. У нас гость упирался в форму входа и не видел продукта.
 * Здесь он видит ленту такой, какой её увидит после регистрации: оценка,
 * причина, срок, цена. Карточка, глубокий анализ и смета — после регистрации,
 * и предложение зарегистрироваться появляется ровно в момент клика по строке.
 *
 * Данные — демонстрационная база `src/mocks/tenders.ts` и профиль-пример
 * «ТехноПоставка»: вердикты считает тот же детерминированный подбор, что и в
 * тестах ленты. К серверу страница не ходит вовсе, поэтому открывать её
 * безопасно: ни одной ручки с данными настоящих пользователей она не трогает.
 */

const REGISTER_HREF = "/login?mode=register";

/** Вердикты считаются один раз: подбор по 40 закупкам — заметная работа для главного потока. */
function buildRows(): TenderRow[] {
  const now = new Date();
  return demoTenders.map((tender) => ({
    tender,
    analysis: analyzeTender(tender, demoCompanyProfile, now),
    pipelineStatus: "NEW" as const,
  }));
}

export function DemoFeedView() {
  const rows = useMemo(buildRows, []);
  const [laws, setLaws] = useState<TenderLaw[]>([]);
  const [verdict, setVerdict] = useState<TenderVerdict | null>(null);
  const [sortField, setSortField] = useState<SortField>("fitScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [picked, setPicked] = useState<TenderRow | null>(null);

  const filters = useMemo(() => ({ ...defaultFilters, laws }), [laws]);
  const lawCounts = useMemo(() => countRowsByLaw(rows, filters), [rows, filters]);
  const lawsShown = useMemo(
    () => (["FZ_44", "FZ_223", "PP_RF_615", "COMMERCIAL"] as const).filter((law) => lawCounts[law] > 0 || laws.includes(law)),
    [lawCounts, laws],
  );

  const shown = useMemo(() => {
    const byLaw = filterRows(rows, filters);
    const byVerdict = verdict === null ? byLaw : byLaw.filter((row) => row.analysis.verdict === verdict);
    return sortRows(byVerdict, sortField, sortDir);
  }, [rows, filters, verdict, sortField, sortDir]);

  const verdictCounts = useMemo(() => {
    const counts: Record<TenderVerdict, number> = { RECOMMENDED: 0, MANUAL_REVIEW: 0, NOT_RECOMMENDED: 0 };
    for (const row of filterRows(rows, filters)) counts[row.analysis.verdict] += 1;
    return counts;
  }, [rows, filters]);

  const onSort = (field: SortField): void => {
    setSortDir(field === sortField && sortDir === "desc" ? "asc" : "desc");
    setSortField(field);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
          <Link href="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight text-foreground">
            <LogoMark size={32} />
            ТендерФит
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/login" className="hidden rounded-full border border-border px-4 py-2 text-[14px] font-semibold text-foreground hover:border-foreground sm:inline-flex">
              Войти
            </Link>
            <Link href={REGISTER_HREF} className="inline-flex rounded-full bg-accent-strong px-4 py-2 text-[14px] font-semibold text-white hover:bg-accent-hover">
              Регистрация
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-accent-fg">Демо без регистрации</p>
            <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-foreground">Так выглядит ваша лента закупок</h1>
            <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">
              Профиль-пример «ТехноПоставка»: поставка и обслуживание оргтехники, Москва и область, закупки до 5 млн ₽.
              У каждой закупки уже стоит оценка и причина. Данные вымышленные.
            </p>
          </div>
          <Link href={REGISTER_HREF} className="inline-flex items-center gap-2 rounded-full bg-accent-strong px-5 py-2.5 text-[15px] font-semibold text-white hover:bg-accent-hover">
            Открыть ленту по своей компании
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>

        <LawSwitcher selected={laws} counts={lawCounts} laws={[...lawsShown]} onChange={setLaws} />

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Оценка">
          <span className="text-[13.5px] text-faint">Оценка:</span>
          {TENDER_VERDICTS.map((item) => {
            const active = verdict === item;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={active}
                onClick={() => setVerdict(active ? null : item)}
                className={
                  active
                    ? "rounded-full border border-accent-line bg-accent-subtle px-2.5 py-0.5 text-[13.5px] text-accent-fg"
                    : "rounded-full border border-border bg-panel px-2.5 py-0.5 text-[13.5px] text-muted-foreground hover:text-foreground"
                }
              >
                {verdictLabels[item]} <span className="num">{verdictCounts[item]}</span>
              </button>
            );
          })}
        </div>

        <TenderTable rows={shown} sortField={sortField} sortDir={sortDir} onSort={onSort} onOpen={setPicked} />

        <p className="muted text-[13.5px]">
          Карточка закупки, глубокий анализ документации, риски договора и смета открываются после регистрации.
          Первые семь дней бесплатно, карта не нужна.
        </p>
      </main>

      {picked !== null && <RegisterPrompt row={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

/** Предложение зарегистрироваться — в момент, когда гость захотел открыть карточку. */
function RegisterPrompt({ row, onClose }: { row: TenderRow; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { tender, analysis } = row;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/50 p-4 sm:items-center" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-prompt-title"
        className="card w-full max-w-lg p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12.5px] text-muted-foreground">
              № <span className="num">{tender.regNumber}</span> · НМЦК <span className="num">{formatNumber(tender.financial.price)} ₽</span>
            </p>
            <p className="mt-1 line-clamp-2 text-[15.5px] font-semibold leading-snug text-foreground">{tender.subject}</p>
            <div className="mt-2">
              <VerdictScore verdict={analysis.verdict} fitScore={analysis.fitScore} layout="inline" />
            </div>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="shrink-0 rounded-full p-1.5 text-faint hover:bg-panel-raised hover:text-foreground"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <h2 id="demo-prompt-title" className="mt-5 text-[20px] font-semibold tracking-tight text-foreground">
          Карточка закупки — после регистрации
        </h2>
        <p className="mt-2 text-[14.5px] text-muted-foreground">
          В карточке — почему закупка подходит или нет с цитатами из документов, стоп‑факторы, риски договора, смета по
          документации и цена участия. Это демо на вымышленных данных; после регистрации лента соберётся под вашу
          компанию.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href={REGISTER_HREF} className="inline-flex items-center gap-2 rounded-full bg-accent-strong px-5 py-2.5 text-[15px] font-semibold text-white hover:bg-accent-hover">
            Попробовать 7 дней бесплатно
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link href="/login" className="inline-flex items-center rounded-full border border-border px-5 py-2.5 text-[15px] font-semibold text-foreground hover:border-foreground">
            Войти
          </Link>
          <Button variant="ghost" onClick={onClose}>
            Смотреть дальше
          </Button>
        </div>
      </div>
    </div>
  );
}
