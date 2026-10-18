"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { FUNNEL_PERIODS, FUNNEL_PERIOD_LABELS, type FunnelPeriod, type FunnelUserRow } from "@/domain/adminFunnel";
import type { AdminFunnelResponse } from "@/app/api/admin/funnel/route";
import { Card } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { formatDate } from "@/utils/format";

/**
 * Воронка клиентов: сколько людей дошло до каждого шага пилота и кто застрял.
 *
 * Зачем. Владельцу нужно не «конверсия 12%», а «кому позвонить»: клик по шагу
 * раскрывает тех, кто дошёл до него, но дальше не пошёл, с последней активностью и
 * остатком пробного периода. Ширина полосы — доля от зарегистрировавшихся, справа
 * число и проценты. Без плашек и пилюль: переключатель периода — обычные кнопки-слова,
 * подчёркнутая активная.
 */

function percent(share: number): string {
  return `${String(Math.round(share * 100))}%`;
}

function statusText(row: FunnelUserRow): string {
  if (row.status === "paid") return "оплачен";
  if (row.status === "expired") return "пробный истёк";
  return row.trialDaysLeft === null ? "пробный" : `пробный, ещё ${String(row.trialDaysLeft)} дн.`;
}

function StatusDot({ row }: { row: FunnelUserRow }) {
  const tone = row.status === "paid" ? "bg-olive" : row.status === "expired" ? "bg-brick" : "bg-mustard";
  return <span className={cn("h-3.5 w-[3px] shrink-0 rounded-full", tone)} aria-hidden />;
}

function PersonList({ rows, empty }: { rows: FunnelUserRow[]; empty: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.email} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2" data-testid={`funnel-person-${row.email}`}>
          <span className="min-w-0 break-all text-sm font-medium text-foreground">{row.email}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot row={row} />
              {statusText(row)}
            </span>
            <span>{row.lastActivityAt === null ? "не заходил" : `был ${formatDate(row.lastActivityAt)}`}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AdminFunnel({
  data,
  loading,
  error,
  period,
  onPeriodChange,
}: {
  data: AdminFunnelResponse | null;
  loading: boolean;
  error: string | null;
  period: FunnelPeriod;
  onPeriodChange: (period: FunnelPeriod) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  const switcher = (
    <div className="flex items-center gap-4" role="group" aria-label="Период регистрации">
      {FUNNEL_PERIODS.map((value) => {
        const active = value === period;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onPeriodChange(value)}
            className={cn(
              "border-b-2 pb-0.5 text-[13.5px] transition-colors",
              active ? "border-accent font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {FUNNEL_PERIOD_LABELS[value]}
          </button>
        );
      })}
    </div>
  );

  const byEmail = new Map((data?.users ?? []).map((row) => [row.email, row]));
  const rowsOf = (emails: string[]) => emails.flatMap((email) => byEmail.get(email) ?? []);

  return (
    <Card title="Воронка клиентов" actions={switcher}>
      {error && (
        <p role="alert" className="text-sm text-brick-fg">
          Не удалось загрузить воронку: {error}
        </p>
      )}
      {data?.warnings.map((warning) => (
        <p key={warning} className="mb-2 text-sm text-mustard-fg">
          {warning}
        </p>
      ))}
      {data === null ? (
        !error && <p className="muted">{loading ? "Загружаю воронку…" : "Нет данных."}</p>
      ) : data.registered === 0 ? (
        <p className="muted">За выбранный период регистраций нет.</p>
      ) : (
        <div className={cn("space-y-1", loading && "opacity-60")} data-testid="funnel-steps" aria-busy={loading}>
          <p className="muted mb-2">
            Администраторы не учитываются. Нажмите на шаг, чтобы увидеть, кто на нём застрял.
          </p>
          {data.steps.map((step, index) => {
            const open = openKey === step.key;
            const last = index === data.steps.length - 1;
            const people = rowsOf(last ? step.emails : step.stuckEmails);
            return (
              <div key={step.key} data-testid={`funnel-step-${step.key}`}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenKey(open ? null : step.key)}
                  className="block w-full rounded-md px-1 py-2 text-left transition-colors hover:bg-panel-raised"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5 text-[14px] font-medium text-foreground">
                      {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
                      {step.label}
                    </span>
                    <span className="num shrink-0 text-[15px] font-semibold text-foreground">{step.count}</span>
                  </span>
                  <span className="mt-1.5 block h-2 w-full overflow-hidden rounded-full bg-panel-raised" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${String(Math.round(step.shareOfRegistered * 100))}%` }}
                      data-testid={`funnel-bar-${step.key}`}
                    />
                  </span>
                  <span className="mt-1 flex flex-wrap justify-between gap-x-3 text-[13px] text-muted-foreground">
                    <span>{percent(step.shareOfRegistered)} от зарегистрировавшихся</span>
                    {index > 0 && <span>{percent(step.shareOfPrevious)} от предыдущего шага</span>}
                  </span>
                </button>
                {open && (
                  <div className="mb-2 ml-1 border-l-2 border-border pl-3 sm:ml-5" data-testid={`funnel-people-${step.key}`}>
                    <p className="mb-1 text-sm font-medium text-foreground">
                      {last ? `Оплатили: ${String(people.length)}` : `Застряли здесь: ${String(people.length)}`}
                    </p>
                    <PersonList rows={people} empty={last ? "Оплат пока нет." : "Все, кто дошёл до этого шага, пошли дальше."} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
