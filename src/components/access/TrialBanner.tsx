import Link from "next/link";
import { Hourglass, Sparkles } from "lucide-react";

import { formatTimeLeft, isLastDay, type AccessInfo } from "@/domain/access";
import { cn } from "@/lib/cn";

/**
 * Узкая полоса над содержимым на время пробного периода.
 *
 * «Пробный период: осталось 2 дня · Выбрать тариф». В последние сутки полоса
 * горчичная и считает часы: предупреждение должно быть заметно, но не красным —
 * ничего не сломано, просто пора выбирать тариф. Оплаченному и администратору
 * полоса не показывается вовсе.
 */
export function TrialBanner({ access }: { access: AccessInfo | null }) {
  if (access === null || access.status !== "trial") return null;
  const last = isLastDay(access);
  const Icon = last ? Hourglass : Sparkles;

  return (
    <div
      role="status"
      data-testid="trial-banner"
      data-last-day={last ? "true" : "false"}
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b px-4 py-1.5 text-center text-[14px] leading-snug",
        last
          ? "border-mustard-line bg-mustard-subtle text-mustard-fg"
          : "border-accent-line bg-accent-subtle text-accent-fg",
      )}
    >
      <Icon className="hidden h-3.5 w-3.5 shrink-0 sm:inline" strokeWidth={2} aria-hidden />
      <span>
        Пробный период: осталось <strong className="font-semibold">{formatTimeLeft(access)}</strong>
      </span>
      <span aria-hidden>·</span>
      <Link
        href="/billing"
        className="font-semibold underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        Выбрать тариф
      </Link>
    </div>
  );
}
