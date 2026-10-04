"use client";

import { useMemo } from "react";
import { AlertTriangle, Info } from "lucide-react";
import type { CompanyProfile } from "@/domain/entities";
import { auditCompanyProfile } from "@/domain/profileAudit";

/**
 * Замечания к профилю компании: противоречия между его собственными полями.
 *
 * Ставится наверху формы, до карточек с полями. Причина именно там: когда
 * демонстрационный поиск не даёт рекомендаций, владелец профиля ищет проблему
 * в закупках, а она чаще в том, что лимит цены ниже допуска СРО или стоп-слово
 * совпало с собственным видом работ.
 */
export function ProfileAuditNotice({ profile }: { profile: CompanyProfile }) {
  const issues = useMemo(() => auditCompanyProfile(profile), [profile]);

  if (issues.length === 0) return null;
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const hints = issues.filter((issue) => issue.severity === "hint");

  return (
    <div className="space-y-2" data-testid="profile-audit">
      {warnings.map((issue) => (
        <div
          key={issue.kind}
          className="flex gap-2 rounded border border-mustard/40 px-3 py-2 text-sm text-muted-foreground"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-mustard-fg" aria-hidden />
          <div>
            <p className="font-medium text-foreground">{issue.title}</p>
            <p className="mt-0.5 text-[14.5px]">{issue.detail}</p>
          </div>
        </div>
      ))}

      {hints.map((issue) => (
        <div
          key={issue.kind}
          className="flex gap-2 rounded border border-border px-3 py-2 text-sm text-muted-foreground"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent-fg" aria-hidden />
          <div>
            <p className="font-medium text-foreground">{issue.title}</p>
            <p className="mt-0.5 text-[14.5px]">{issue.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
