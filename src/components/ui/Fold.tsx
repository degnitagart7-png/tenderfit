import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Раскрывающийся раздел: заголовок, строка смысла и стрелка.
 *
 * Нужен там, где результат состоит из многих частей, а читают его сверху вниз:
 * по заголовкам и строке смысла видно, что внутри и стоит ли открывать, —
 * без чтения самих таблиц. Разделы идут списком с тонкими линиями, а не
 * стопкой коробок.
 *
 * Внутрь кладутся готовые блоки со своей рамкой и заголовком — они остаются
 * как есть (тесты и привычные подписи), но рамка и дубль заголовка гасятся,
 * чтобы не получалась коробка в коробке. Мелкий текст блоков (12 px)
 * поднимается до 13 px: внутри разделов его читают целиком.
 */
export function Fold({
  title,
  summary,
  defaultOpen = false,
  tone,
  children,
  testId,
}: {
  title: string;
  /** Одна строка о содержимом: число, вывод или «для проверки сметчиком». */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Раздел требует внимания — метка слева золотая. */
  tone?: "warn";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <details open={defaultOpen} className="group" data-testid={testId}>
      <summary
        className={cn(
          "flex cursor-pointer list-none items-start justify-between gap-4 py-4 [&::-webkit-details-marker]:hidden",
          tone === "warn" && "border-l-[3px] border-mustard pl-3",
        )}
      >
        <span className="min-w-0">
          <span className="block text-[15.5px] font-semibold tracking-tight text-foreground">
            {title}
          </span>
          {summary !== undefined && (
            <span className="mt-0.5 block text-[13.5px] leading-snug text-muted-foreground">
              {summary}
            </span>
          )}
        </span>
        <ChevronDown
          className="mt-1 h-4 w-4 shrink-0 text-faint transition-transform group-open:rotate-180"
          strokeWidth={2}
          aria-hidden
        />
      </summary>
      <div
        className={cn(
          "space-y-4 pb-6 text-[14px] leading-relaxed",
          "[&>section]:rounded-none [&>section]:border-0 [&>section]:p-0",
          "[&>section_h3]:sr-only",
          "[&_.text-xs]:text-[13px] [&_.text-xs]:leading-snug",
        )}
      >
        {children}
      </div>
    </details>
  );
}
