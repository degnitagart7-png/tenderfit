import type { TenderVerdict } from "@/domain/enums";
import { verdictLabels, verdictShort } from "@/lib/labels";
import { cn } from "@/lib/cn";

/** Тон оценки: пилюля вердикта и число рядом с ней окрашены одинаково. */
const VERDICT_TONE: Record<TenderVerdict, { pill: string; text: string }> = {
  RECOMMENDED: { pill: "bg-olive-subtle text-olive-fg", text: "text-olive-fg" },
  MANUAL_REVIEW: { pill: "bg-mustard-subtle text-mustard-fg", text: "text-mustard-fg" },
  NOT_RECOMMENDED: { pill: "bg-brick-subtle text-brick-fg", text: "text-brick-fg" },
};

/** Подсказка к оценке: полное название вердикта и число словами. */
export function verdictScoreTitle(verdict: TenderVerdict, fitScore: number): string {
  return `${verdictLabels[verdict]} · соответствие профилю компании ${fitScore} из 100`;
}

/**
 * Оценка закупки: короткая цветная пилюля вердикта и число 0–100.
 *
 * Один компонент на таблицу закупок и шапку карточки: оценка выглядит
 * одинаково везде, где её показывают. `stack` — число под пилюлей (колонка
 * таблицы), `inline` — рядом (шапка карточки).
 */
export function VerdictScore({
  verdict,
  fitScore,
  layout = "stack",
}: {
  verdict: TenderVerdict;
  fitScore: number;
  layout?: "stack" | "inline";
}) {
  const tone = VERDICT_TONE[verdict];
  const inline = layout === "inline";
  return (
    <>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-[12.5px] font-medium whitespace-nowrap",
          inline && "px-2.5 py-1 text-[13.5px]",
          tone.pill,
        )}
      >
        {verdictShort[verdict]}
      </span>
      <span
        className={cn(
          "num font-semibold",
          inline ? "ml-2 text-[18px]" : "mt-1 block px-2 text-[14.5px]",
          tone.text,
        )}
      >
        {fitScore}
      </span>
    </>
  );
}
