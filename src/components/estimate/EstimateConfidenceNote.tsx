import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/primitives";
import type { EstimateConfidence } from "@/domain/estimate/estimateConfidence";

/**
 * Насколько расчёту можно верить, рядом с итоговой суммой.
 *
 * «Расчёт по смете заказчика» — спокойная метка: сумма сходится с заказчиком в пределах 5 %. «Примерная оценка» — горчичная
 * плашка с пояснением прямо в тексте, а не во всплывающей подсказке: на телефоне наведения нет. Без суммы («unknown») ничего
 * не рисуется.
 */
export function EstimateConfidenceNote({ confidence }: { confidence: EstimateConfidence }) {
  if (confidence.level === "unknown") return null;

  if (confidence.level === "customer") {
    return (
      <div className="mt-3 max-w-xl" data-testid="estimate-confidence" data-level="customer">
        <Badge tone="olive">{confidence.title}</Badge>
        <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{confidence.explanation}</p>
      </div>
    );
  }

  return (
    <div
      className="mt-3 max-w-xl rounded-card border border-mustard-line bg-mustard-subtle px-3 py-2.5"
      data-testid="estimate-confidence"
      data-level="approximate"
    >
      <p className="flex items-center gap-2 text-[13.5px] font-semibold text-mustard-fg">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {confidence.title}
      </p>
      {confidence.range !== undefined && (
        <p className="mt-1 text-[13.5px] font-medium tabular-nums text-foreground" data-testid="estimate-confidence-range">
          {confidence.range.text}
        </p>
      )}
      <p className="mt-1 text-[13px] leading-snug text-foreground/80" data-testid="estimate-confidence-text">
        {confidence.explanation}
      </p>
    </div>
  );
}
