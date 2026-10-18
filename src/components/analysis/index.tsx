"use client";

import { useState } from "react";
import { FileText, Search, ThumbsUp, ThumbsDown, AlertTriangle } from "lucide-react";
import type {
  AnalysisScore,
  ContractRisk,
  Evidence,
  EvidenceSource,
  HardBlocker,
  TenderVerdict,
  Uncertainty,
} from "@/domain/entities";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import {
  DISCLAIMER,
  evidenceSourceLabels,
  riskSeverityLabels,
  verdictLabels,
  verdictShort,
} from "@/lib/labels";

const stampTone: Record<TenderVerdict, { bar: string; text: string }> = {
  RECOMMENDED: { bar: "bg-olive", text: "text-olive-fg" },
  MANUAL_REVIEW: { bar: "bg-mustard", text: "text-mustard-fg" },
  NOT_RECOMMENDED: { bar: "bg-brick", text: "text-brick-fg" },
};

/*
  Вердикт: слово тона результата с цветной меткой слева. Без пилюли, заливки и
  рамки — так вердикт не сливается с остальными плашками страницы, а слово
  читается само, без опоры на цвет.
*/
export function VerdictBadge({
  verdict,
  className,
  full = false,
  short = false,
}: {
  verdict: TenderVerdict;
  className?: string;
  full?: boolean;
  short?: boolean;
}) {
  const t = stampTone[verdict];
  const text = short ? verdictShort[verdict] : verdictLabels[verdict];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[14px] font-semibold whitespace-nowrap",
        t.text,
        className,
      )}
    >
      <span className={cn("h-4 w-[3px] shrink-0 rounded-full", t.bar)} aria-hidden />
      {full ? verdictLabels[verdict] : text}
    </span>
  );
}

/*
  Соответствие — число тона результата, без плашки: оно и так читается, а
  рамка вокруг двузначного числа лишь добавляла ещё одну цветную коробку в
  каждую строку таблицы.
*/
export function FitScore({
  value,
  size = "md",
}: {
  value: number;
  size?: "sm" | "md" | "lg";
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const tone =
    clamped >= 75
      ? { text: "text-olive-fg" }
      : clamped >= 50
        ? { text: "text-mustard-fg" }
        : { text: "text-brick-fg" };
  const dims = size === "lg" ? "text-xl" : size === "sm" ? "text-[13px]" : "text-[16px]";

  return (
    <span
      className={cn("num inline-flex items-center font-semibold", tone.text, dims)}
      title={`Соответствие компании ${clamped} из 100`}
      aria-label={`Соответствие компании ${clamped} из 100`}
      role="img"
    >
      {clamped}
    </span>
  );
}

/*
  Четыре показателя из пяти начинаются со 100 и падают только при явном
  препятствии — они отвечают «нет ли запрета», а не «умеем ли мы». Названия
  вроде «Операционное соответствие 100» читались как подтверждение
  способности выполнить работу, хотя проверены были только регион и срок
  поставки. Названия приведены к тому, что показатель действительно измеряет.
*/
const scoreLabels: { key: keyof AnalysisScore; label: string; invert?: boolean }[] = [
  { key: "subjectFit", label: "Совпадение предмета с профилем" },
  { key: "legalEligibility", label: "Нет юридических препятствий" },
  { key: "operationalFit", label: "Нет операционных препятствий" },
  { key: "financialFit", label: "Цена и условия в рамках профиля" },
  { key: "contractRisk", label: "Риск договора", invert: true },
];

function barTone(displayed: number): string {
  return displayed >= 75 ? "bg-olive" : displayed >= 50 ? "bg-mustard" : "bg-brick";
}

export function FitScoreBreakdown({ scores }: { scores: AnalysisScore }) {
  return (
    <div className="space-y-3">
      {scoreLabels.map((s) => {
        const raw = scores[s.key];
        const displayed = s.invert ? 100 - raw : raw;
        return (
          <div key={s.key}>
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-muted-foreground">
                {s.label}
                {s.invert && <span className="text-faint"> (меньше — лучше)</span>}
              </span>
              <span className="num font-medium text-foreground">{raw}</span>
            </div>
            <div className="h-1.5 w-full rounded-sm bg-panel-raised overflow-hidden">
              <div
                className={cn("h-full", barTone(displayed))}
                style={{ width: `${displayed}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RiskBadge({ severity }: { severity: ContractRisk["severity"] }) {
  const tone =
    severity === "CRITICAL" || severity === "HIGH"
      ? "brick"
      : severity === "MEDIUM"
        ? "mustard"
        : "neutral";
  return <Badge tone={tone}>{riskSeverityLabels[severity]}</Badge>;
}

const confidenceLabels: Record<Evidence["confidence"], string> = {
  HIGH: "высокая",
  MEDIUM: "средняя",
  LOW: "низкая",
};

const sourceTone: Record<EvidenceSource, "olive" | "accent" | "mustard" | "neutral"> = {
  TENDER_DOCUMENT: "olive",
  COMPANY_PROFILE: "accent",
  AI_CONCLUSION: "mustard",
  SYSTEM_RULE: "neutral",
};

/** Компактный тег типа источника: Факт из документа / Данные профиля / Вывод AI. */
export function SourceTag({ source }: { source: EvidenceSource }) {
  return (
    <Badge tone={sourceTone[source]} dot={false}>
      {evidenceSourceLabels[source]}
    </Badge>
  );
}

export function EvidenceCard({
  evidence,
  onShowInDocument,
}: {
  evidence: Evidence;
  /** Открывает документ и подсвечивает раздел/страницу. Необязательно. */
  onShowInDocument?: (evidence: Evidence) => void;
}) {
  return (
    <div className="rounded-sm border border-border bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs mb-1.5">
        <SourceTag source={evidence.source} />
        {evidence.documentTitle && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <FileText className="h-3 w-3" strokeWidth={1.75} aria-hidden />
            {evidence.documentTitle}
          </span>
        )}
        {evidence.page != null && (
          <span className="text-faint num">стр. {evidence.page}</span>
        )}
        {evidence.section && <span className="text-faint">· {evidence.section}</span>}
      </div>
      <blockquote className="text-sm text-foreground border-l-2 border-accent/50 pl-2.5">
        «{evidence.quote}»
      </blockquote>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="muted text-xs">
          Уверенность: {confidenceLabels[evidence.confidence]}
        </span>
        {onShowInDocument && evidence.documentId && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onShowInDocument(evidence)}
            className="text-xs"
          >
            <Search className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            Показать в документе
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Строка вывода (фактор/причина) с тегом типа источника и раскрывающимся
 * доказательством. Если доказательство не привязано — это вывод AI.
 */
export function FindingRow({
  text,
  evidence,
  onShowInDocument,
}: {
  text: string;
  evidence?: Evidence;
  onShowInDocument?: (evidence: Evidence) => void;
}) {
  const [open, setOpen] = useState(false);
  const source: EvidenceSource = evidence?.source ?? "AI_CONCLUSION";
  return (
    <li className="text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="text-muted-foreground flex-1">{text}</span>
        <SourceTag source={source} />
      </div>
      {evidence && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-accent-fg hover:underline"
            aria-expanded={open}
          >
            {open ? "Скрыть доказательство" : "Показать доказательство"}
          </button>
          {open && (
            <div className="mt-1.5">
              <EvidenceCard evidence={evidence} onShowInDocument={onShowInDocument} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function HardBlockerCard({
  blocker,
  evidence,
  onShowInDocument,
}: {
  blocker: HardBlocker;
  evidence?: Evidence;
  onShowInDocument?: (evidence: Evidence) => void;
}) {
  return (
    <div
      className={cn(
        "rounded-sm border p-3",
        blocker.critical ? "border-brick/50 bg-brick/10" : "border-mustard/40 bg-mustard/10",
      )}
    >
      <div className="flex items-center gap-2 font-medium text-sm">
        <span
          className={cn(
            "h-2 w-2 shrink-0",
            blocker.critical ? "bg-brick" : "bg-mustard",
          )}
          aria-hidden
        />
        <span className={blocker.critical ? "text-brick-fg" : "text-mustard-fg"}>
          {blocker.reason}
        </span>
        {blocker.critical && <Badge tone="brick">Критично</Badge>}
        {evidence && <SourceTag source={evidence.source} />}
      </div>
      <p className="text-sm text-muted-foreground mt-1">{blocker.detail}</p>
      {evidence && (
        <p className="muted text-xs mt-1.5">
          {evidence.documentTitle ? `${evidence.documentTitle} · ` : ""}
          {evidence.page != null ? `стр. ${evidence.page} · ` : ""}
          {evidence.section ?? ""}
          {onShowInDocument && evidence.documentId && (
            <button
              type="button"
              onClick={() => onShowInDocument(evidence)}
              className="ml-1 text-accent-fg hover:underline"
            >
              показать в документе
            </button>
          )}
        </p>
      )}
    </div>
  );
}

export function UncertaintyCard({
  uncertainty,
  evidence,
  onShowInDocument,
}: {
  uncertainty: Uncertainty;
  evidence?: Evidence;
  onShowInDocument?: (evidence: Evidence) => void;
}) {
  return (
    <div className="rounded-sm border border-mustard/40 bg-mustard/10 p-3">
      <div className="flex items-center gap-2 font-medium text-sm text-mustard-fg">
        <AlertTriangle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        {uncertainty.question}
        {uncertainty.material && <Badge tone="mustard">Существенно</Badge>}
        {evidence && <SourceTag source={evidence.source} />}
      </div>
      <p className="text-sm text-muted-foreground mt-1">{uncertainty.detail}</p>
      {evidence && (
        <p className="muted text-xs mt-1.5">
          {evidence.documentTitle ? `${evidence.documentTitle} · ` : ""}
          {evidence.page != null ? `стр. ${evidence.page} · ` : ""}
          {evidence.section ?? ""}
          {onShowInDocument && evidence.documentId && (
            <button
              type="button"
              onClick={() => onShowInDocument(evidence)}
              className="ml-1 text-accent-fg hover:underline"
            >
              показать в документе
            </button>
          )}
        </p>
      )}
    </div>
  );
}

export function DisclaimerAlert() {
  return (
    <div className="rounded-sm border border-border bg-panel p-3 text-xs text-muted-foreground flex gap-2">
      <AlertTriangle className="h-4 w-4 text-faint shrink-0 mt-0.5" strokeWidth={1.75} aria-hidden />
      <p>{DISCLAIMER}</p>
    </div>
  );
}

export function FeedbackButtons({
  onFeedback,
  disabled,
}: {
  onFeedback: (useful: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Вердикт полезен?</span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => onFeedback(true)}
        disabled={disabled}
        aria-label="Вердикт полезен"
      >
        <ThumbsUp className="h-4 w-4" strokeWidth={1.75} aria-hidden /> Да
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => onFeedback(false)}
        disabled={disabled}
        aria-label="Вердикт ошибочен"
      >
        <ThumbsDown className="h-4 w-4" strokeWidth={1.75} aria-hidden /> Нет
      </Button>
    </div>
  );
}

/*
  Metric card: число крупно, иконка — в цветном чипе сверху. Тень карточки
  задаёт приподнятость, цветная полоска-костыль больше не нужна.
*/
export function StatCard({
  label,
  value,
  tone = "neutral",
  icon: Icon,
  change,
  changeType,
  context,
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "olive" | "mustard" | "brick" | "accent";
  icon?: typeof FileText;
  change?: string;
  changeType?: "positive" | "negative";
  context?: string;
}) {
  const valueTone = {
    neutral: "text-foreground",
    olive: "text-olive-fg",
    mustard: "text-mustard-fg",
    brick: "text-brick-fg",
    accent: "text-accent-fg",
  }[tone];

  const chip = {
    neutral: "bg-panel-raised text-muted-foreground",
    olive: "bg-olive-subtle text-olive-fg",
    mustard: "bg-mustard-subtle text-mustard-fg",
    brick: "bg-brick-subtle text-brick-fg",
    accent: "bg-accent-subtle text-accent-fg",
  }[tone];

  return (
    <Card className="!p-0">
      <div className="p-4">
        {Icon && (
          <div className={cn("mb-2.5 inline-flex h-8 w-8 items-center justify-center rounded-control", chip)}>
            <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </div>
        )}
        <div className="flex items-baseline gap-2">
          <p className={cn("num text-2xl font-semibold leading-none", valueTone)}>{value}</p>
          {change && (
            <span
              className={cn(
                "num text-[12.5px]",
                changeType === "negative"
                  ? "text-brick-fg"
                  : changeType === "positive"
                    ? "text-olive-fg"
                    : "text-muted-foreground",
              )}
            >
              {changeType === "negative"
                ? `↓ ${change}`
                : changeType === "positive"
                  ? `↑ ${change}`
                  : change}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[14.5px] text-muted-foreground">{label}</p>
        {context && (
          <p className="mt-1 text-[13.5px] leading-snug text-faint">{context}</p>
        )}
      </div>
    </Card>
  );
}
