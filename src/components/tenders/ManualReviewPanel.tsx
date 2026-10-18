"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import type { ManualReviewDecision, ManualReviewOutcome, TenderVerdict } from "@/domain/entities";
import {
  MANUAL_REVIEW_CHECKLIST,
  canConfirm,
  canDecideWithoutConfirm,
  checklistProgress,
} from "@/domain/review";
import { reviewRepository } from "@/repositories/reviewRepository";
import { Badge, Button, Card, Checkbox, ProgressBar, Textarea } from "@/components/ui/primitives";
import { manualReviewOutcomeLabels, verdictLabels } from "@/lib/labels";
import { formatDateTime } from "@/utils/format";

/**
 * Рабочий сценарий ручной проверки: чек-лист, комментарий аналитика,
 * три исхода решения и полная история решений закупки (localStorage).
 */
export function ManualReviewPanel({
  tenderId,
  systemVerdict,
  onDecided,
}: {
  tenderId: string;
  systemVerdict: TenderVerdict;
  /** Вызывается после сохранения решения — родитель может обновить воронку. */
  onDecided?: (outcome: ManualReviewOutcome) => void;
}) {
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [comment, setComment] = useState("");
  const [history, setHistory] = useState<ManualReviewDecision[]>([]);
  const [saved, setSaved] = useState<ManualReviewDecision | null>(null);

  useEffect(() => {
    setHistory(reviewRepository.forTender(tenderId));
    setChecklist({});
    setComment("");
    setSaved(null);
  }, [tenderId]);

  const progress = checklistProgress(checklist);
  const confirmReady = canConfirm(checklist, comment);
  const decideReady = canDecideWithoutConfirm(comment);

  const decide = (outcome: ManualReviewOutcome) => {
    const decision = reviewRepository.add(
      tenderId,
      outcome,
      outcome === "CONFIRMED" ? checklist : {},
      comment,
      systemVerdict,
    );
    setHistory(reviewRepository.forTender(tenderId));
    setSaved(decision);
    setComment("");
    setChecklist({});
    onDecided?.(outcome);
  };

  const outcomeTone: Record<ManualReviewOutcome, "olive" | "brick" | "mustard"> = {
    CONFIRMED: "olive",
    REJECTED: "brick",
    CLARIFICATION_REQUESTED: "mustard",
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Чек-лист ручной проверки">
        <div className="flex items-center gap-3 mb-3">
          <ProgressBar value={progress.percent} />
          <span className="muted text-xs whitespace-nowrap num">
            {progress.done}/{progress.total}
          </span>
        </div>
        <ul className="space-y-2">
          {MANUAL_REVIEW_CHECKLIST.map((item) => (
            <li key={item.id}>
              <Checkbox
                label={item.label}
                checked={Boolean(checklist[item.id])}
                onChange={(e) =>
                  setChecklist((c) => ({ ...c, [item.id]: e.target.checked }))
                }
              />
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <label className="label mb-1 block" htmlFor="review-comment">
            Комментарий аналитика
          </label>
          <Textarea
            id="review-comment"
            rows={3}
            value={comment}
            placeholder="Что проверили, какие риски приняли, что уточнить у заказчика…"
            onChange={(e) => setComment(e.target.value)}
          />
          {saved && (
            <p role="status" className="text-xs text-olive-fg mt-2">
              Решение «{manualReviewOutcomeLabels[saved.outcome]}» сохранено в историю.
            </p>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => decide("CONFIRMED")}
            disabled={!confirmReady}
            title={
              confirmReady
                ? undefined
                : "Для подтверждения нужны все пункты чек-листа и комментарий от 5 символов"
            }
          >
            <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            Подтверждено вручную
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => decide("REJECTED")}
            disabled={!decideReady}
          >
            <XCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            Отклонено вручную
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => decide("CLARIFICATION_REQUESTED")}
            disabled={!decideReady}
          >
            <HelpCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            Нужно запросить разъяснение
          </Button>
        </div>
      </Card>

      <Card title="История ручных решений" actions={<span className="muted">{history.length}</span>}>
        {history.length === 0 ? (
          <p className="muted">
            Ручных решений пока нет.
          </p>
        ) : (
          <ol className="space-y-3">
            {history.map((d) => (
              <li key={d.id} className="rounded-sm border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={outcomeTone[d.outcome]}>
                    {manualReviewOutcomeLabels[d.outcome]}
                  </Badge>
                  <span className="muted text-xs num">{formatDateTime(d.decidedAt)}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1.5">{d.comment}</p>
                <p className="muted text-xs mt-1">
                  Вердикт системы на момент решения: {verdictLabels[d.systemVerdict]}
                  {d.outcome === "CONFIRMED" && " · чек-лист выполнен полностью"}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
