"use client";

import {
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/* ============================== Button ============================== */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "ink";
type Size = "sm" | "md" | "lg";

/*
  Кнопка-пилюля — главный узнаваемый элемент референса (Orbit CRM). Заливки
  плоские, контраст текста к заливке >= AA; тень есть только у primary и ink —
  это единственные элементы, которым позволено казаться «нажимаемыми».

  primary залит --accent-strong, а не ярким --accent: белый текст на ярком
  оранжевом даёт 3.1:1 и не проходит AA. Яркий оранжевый остаётся на графике.
*/
const variants: Record<Variant, string> = {
  primary:
    "bg-accent-strong text-white hover:bg-accent-hover border border-transparent shadow-[0_1px_2px_rgb(28_25_23_/_0.12)]",
  secondary:
    "bg-panel text-foreground hover:bg-panel-raised border border-border hover:border-border-strong",
  ghost: "bg-transparent text-muted-foreground hover:bg-panel-raised border border-transparent",
  danger: "bg-brick text-white hover:bg-brick-fg border border-transparent",
  outline: "bg-transparent text-accent-fg hover:bg-accent-subtle border border-accent-line",
  // Тёмная тёплая заливка: действия поверх выделения и «сильные» вторичные CTA.
  ink: "bg-ink text-white hover:bg-ink/90 border border-transparent shadow-[0_1px_2px_rgb(28_25_23_/_0.16)]",
};

const sizes: Record<Size, string> = {
  sm: "px-3.5 py-1.5 text-[14.5px]",
  md: "px-[18px] py-2.5 text-sm",
  lg: "px-6 py-3 text-[16px]",
};

/** Размер спиннера под размер кнопки — иконка не должна спорить с подписью. */
const spinnerSizes: Record<Size, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /**
   * Действие выполняется.
   *
   * Живёт в примитиве, а не в местах вызова: ожидание показывают минимум два
   * экрана (поиск закупок и синхронизация), и две рукописные копии спиннера
   * разошлись бы размером и отступом в первый же день. Кнопка сама становится
   * `disabled` — «ждём» и «можно нажать ещё раз» одновременно не бывает.
   */
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-accent/35 focus:ring-offset-1 focus:ring-offset-background",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && (
        <Loader2
          className={cn("shrink-0 animate-spin motion-reduce:animate-none", spinnerSizes[size])}
          strokeWidth={2}
          aria-hidden
        />
      )}
      {children}
    </button>
  );
}

/* ============================== Card ============================== */

export function Card({
  children,
  className,
  title,
  actions,
  /** Убрать внутренние отступы тела — для таблиц и списков во всю карточку. */
  flush = false,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className={cn("card", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <h2 className="text-[16px] font-semibold text-foreground tracking-tight">{title}</h2>
          {actions}
        </header>
      )}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

/* ============================== Badge ============================== */

/*
  Статус — слово с узкой цветной меткой слева, без заливки и без рамки.

  Раньше это была пилюля: мягкая заливка, граница в тон, скруглённые края. Так
  выглядит статус в каждом втором интерфейсе, и на плотной странице десяток
  таких плашек превращается в цветной шум. Метка занимает три пикселя ширины,
  а читает человек слово: цвет — подсказка, а не единственный носитель смысла
  (текст остаётся тёмным и проходит контраст на любом тоне).
*/
type Tone = "olive" | "mustard" | "brick" | "neutral" | "accent";
const tones: Record<Tone, string> = {
  olive: "bg-olive",
  mustard: "bg-mustard",
  brick: "bg-brick",
  neutral: "bg-border-strong",
  accent: "bg-accent",
};

export function Badge({
  children,
  tone = "neutral",
  className,
  dot = true,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[13.5px] font-medium text-foreground whitespace-nowrap",
        className,
      )}
    >
      {dot && <span className={cn("h-3.5 w-[3px] shrink-0 rounded-full", tones[tone])} aria-hidden />}
      {children}
    </span>
  );
}

/* ============================== Stat strip ============================== */

/**
 * Показатель в сводной полосе.
 *
 * `delta` — изменение к прошлому периоду: печатается тоном результата, потому
 * что «+12%» и «−12%» отличаются одним символом и на скорости не различаются.
 */
export function Stat({
  label,
  value,
  hint,
  delta,
  deltaTone = "neutral",
  icon,
}: {
  label: string;
  value: ReactNode;
  /** Пояснение под числом: период, оговорка, источник. */
  hint?: ReactNode;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  icon?: ReactNode;
}) {
  const deltaClass =
    deltaTone === "up"
      ? "bg-olive-subtle text-olive-fg border-olive-line"
      : deltaTone === "down"
        ? "bg-brick-subtle text-brick-fg border-brick-line"
        : "bg-panel-raised text-muted-foreground border-border";
  return (
    <div className="stat-cell">
      <div className="flex items-start justify-between gap-2">
        <p className="stat-cell-label">{label}</p>
        {icon && <span className="shrink-0 text-faint">{icon}</span>}
      </div>
      <span className="stat-cell-value">{value}</span>
      {(hint || delta) && (
        <p className="stat-cell-foot">
          {hint}
          {delta && (
            <span
              className={cn(
                "num rounded-full border px-1.5 py-[1px] text-[12.5px] font-medium",
                deltaClass,
              )}
            >
              {delta}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Полоса показателей: один контейнер, ячейки разделены линиями.
 *
 * `dense` — для ровно четырёх ячеек: 2×2 на телефоне вместо стопки в один
 * столбец, см. `.stat-strip-dense` в globals.css.
 */
export function StatStrip({
  children,
  className,
  dense = false,
}: {
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return <div className={cn(dense ? "stat-strip-dense" : "stat-strip", className)}>{children}</div>;
}

/* ============================== Toolbar ============================== */

/** Ряд инструментов над таблицей: вид, фильтры, сортировка, экспорт. */
export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>
  );
}

/** Кнопка-пилюля инструментального ряда. `active` подсвечивает применённое. */
export function SegButton({
  children,
  active = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-active={active || undefined}
      className={cn("seg", className)}
      {...props}
    >
      {children}
    </button>
  );
}

/* ============================== Toggle ============================== */

/**
 * Переключатель-тумблер.
 *
 * Отдельно от Checkbox: тумблер означает «режим включён прямо сейчас»
 * (показывать сводку, включить профиль), а галочка — выбор в форме, который
 * ещё надо сохранить. Разные обещания — разные элементы.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex cursor-pointer items-center gap-2.5 text-[14.5px] font-medium text-muted-foreground",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-accent/35 focus:ring-offset-1",
          checked ? "bg-accent" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
            checked ? "left-[19px]" : "left-[3px]",
          )}
          aria-hidden
        />
      </button>
    </label>
  );
}

/* ============================== Counter ============================== */

/**
 * Плитка-счётчик: подпись, крупное число и цвет, если значение требует внимания.
 *
 * Живёт в примитивах, а не в конкретной панели: одинаковыми плитками показаны
 * расход платного источника и состояние очереди заданий, а две копии такого
 * компонента разошлись бы отступами в первый же день.
 */
export function Counter({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warning" | "danger";
}) {
  const valueClass =
    tone === "danger"
      ? "text-brick-fg"
      : tone === "warning"
        ? "text-mustard-fg"
        : "text-foreground";
  return (
    <div className="rounded-control border border-border bg-panel px-3 py-2">
      <p className="text-[12.5px] font-medium uppercase tracking-wide text-faint">{label}</p>
      <p className={`num mt-1 text-lg font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

/* ============================== Form fields ============================== */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      {label && <span className="label">{label}</span>}
      {children}
      {hint && !error && <span className="muted mt-1 block">{hint}</span>}
      {error && (
        <span className="mt-1 block text-xs text-brick-fg" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("input", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("input resize-y", className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn("input", className)} {...props}>
      {children}
    </select>
  );
}

export function Checkbox({
  label,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <input
        type="checkbox"
        /* accent-color из токена, а не хардкод: галочка обязана быть того же
           оранжевого, что и остальной акцент. */
        className="h-4 w-4 rounded border-border bg-panel accent-[rgb(var(--accent-strong))]"
        {...props}
      />
      {label}
    </label>
  );
}

/* ============================== Progress ============================== */

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div
      className={cn("h-1.5 w-full rounded-full bg-panel-raised overflow-hidden", className)}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width]"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

/* ============================== States ============================== */

export function LoadingSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Загрузка">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-12 rounded-control bg-panel-raised animate-pulse motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="text-center py-12">
      <p className="text-foreground font-medium">{title}</p>
      {description && <p className="muted mt-1">{description}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="text-center py-12">
      <p className="text-brick-fg font-medium">Ошибка: {message}</p>
      {onRetry && (
        <Button className="mt-3" variant="secondary" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

/* ============================== Collapsible ============================== */

export function Collapsible({
  title,
  children,
  defaultOpen = false,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="rounded-control border border-border bg-panel">
      <button
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-sm font-medium text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
      >
        {title}
        <span className="text-faint font-mono">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div id={id} className="px-3.5 pb-3.5 border-t border-border">
          {children}
        </div>
      )}
    </div>
  );
}
