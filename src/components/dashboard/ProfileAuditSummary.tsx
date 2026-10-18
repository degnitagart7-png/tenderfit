"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Info } from "lucide-react";
import type { CompanyProfile } from "@/domain/entities";
import { auditCompanyProfile } from "@/domain/profileAudit";
import { ProfileAuditNotice } from "@/components/settings/ProfileAuditNotice";
import { cn } from "@/lib/cn";
import { pluralRu } from "@/utils/format";

/**
 * Замечания к профилю одной свёрнутой строкой.
 *
 * Два развёрнутых предупреждения сверху выталкивали весь экран за первую
 * страницу, хотя решение «что делать сегодня» от них не зависит. Теперь
 * на виду только факт и число пунктов; подробности — в раскрытии, и это тот же
 * `ProfileAuditNotice`, что стоит в форме профиля, поэтому счёт пунктов и тексты
 * берутся из одной проверки (`auditCompanyProfile`) и разойтись не могут.
 * Замечаний нет — ничего не печатается, как и раньше.
 */
export function ProfileAuditSummary({ profile }: { profile: CompanyProfile }) {
  const [open, setOpen] = useState(false);
  const issues = useMemo(() => auditCompanyProfile(profile), [profile]);

  if (issues.length === 0) return null;
  // Предупреждение (отбор теряет закупки) красит плашку золотом; одни подсказки — нет.
  const hasWarning = issues.some((issue) => issue.severity === "warning");
  const Icon = hasWarning ? AlertTriangle : Info;

  return (
    <div
      className={cn(
        "rounded-control border px-3.5 py-2",
        hasWarning ? "border-mustard-line bg-mustard-subtle" : "border-border bg-panel",
      )}
      data-testid="profile-audit-summary"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 basis-[15rem] items-center gap-2 text-left"
        >
          <Icon
            className={cn("h-4 w-4 shrink-0", hasWarning ? "text-mustard-fg" : "text-accent-fg")}
            aria-hidden
          />
          <span className="text-[14.5px] font-medium text-foreground">
            Профиль заполнен не полностью — {issues.length}{" "}
            {pluralRu(issues.length, ["пункт", "пункта", "пунктов"])}
          </span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-faint transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
        <Link
          href="/settings/profile"
          className="shrink-0 text-[13.5px] font-medium text-accent-fg hover:underline"
        >
          Исправить в профиле
        </Link>
      </div>
      {open && (
        <div className="mt-2.5 border-t border-border/70 pt-2.5">
          <ProfileAuditNotice profile={profile} />
        </div>
      )}
    </div>
  );
}
