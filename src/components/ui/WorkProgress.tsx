import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Индикатор долгой работы: разбор документации, расчёт сметы.
 *
 * Задача — чтобы человек, не читая ни слова, понял: сейчас идёт работа, и она
 * движется. Слева лист документа с бегущей линией чтения, справа — что именно
 * происходит и на каком этапе. Этапы называют то, что видит пользователь
 * («Читаем текст»), а не то, что делает система.
 *
 * Анимация только CSS и отключается при `prefers-reduced-motion`: тогда этапы и
 * подписи остаются, а линия и полоска стоят.
 */
export function WorkProgress({
  title,
  hint,
  steps,
  current,
  progress,
  className,
}: {
  title: string;
  hint?: string;
  steps: readonly string[];
  /** Индекс текущего этапа; предыдущие считаются выполненными. */
  current: number;
  /** Доля 0..1, если известна; нет — бегущая полоска без конца. */
  progress?: number | null;
  className?: string;
}) {
  const known = typeof progress === "number" && progress >= 0;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={title}
      className={cn("flex items-start gap-5", className)}
      data-testid="work-progress"
    >
      <div className="wp-doc shrink-0" aria-hidden>
        <span className="wp-sheet wp-sheet-3" />
        <span className="wp-sheet wp-sheet-2" />
        <span className="wp-sheet wp-sheet-1">
          <i style={{ width: "78%" }} />
          <i style={{ width: "92%" }} />
          <i style={{ width: "64%" }} />
          <i style={{ width: "86%" }} />
          <i style={{ width: "48%" }} />
          <b className="wp-scan" />
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold tracking-tight text-foreground">
          {title}
        </p>
        {hint && (
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">{hint}</p>
        )}

        <div className="wp-track mt-3" aria-hidden>
          {known ? (
            <span
              className="wp-fill"
              style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }}
            />
          ) : (
            <span className="wp-run" />
          )}
        </div>

        <ol className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
          {steps.map((label, i) => {
            const done = i < current;
            const now = i === current;
            return (
              <li
                key={label}
                aria-current={now ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1.5",
                  done
                    ? "text-muted-foreground"
                    : now
                      ? "font-medium text-foreground"
                      : "text-faint",
                )}
              >
                {done ? (
                  <Check
                    className="h-3.5 w-3.5 text-olive"
                    strokeWidth={2.5}
                    aria-hidden
                  />
                ) : (
                  <span
                    className={cn("wp-dot", now && "wp-dot-now")}
                    aria-hidden
                  />
                )}
                {label}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
