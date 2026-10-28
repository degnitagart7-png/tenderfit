"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { Check, X } from "lucide-react";
import { Badge, Input } from "@/components/ui/primitives";
import { RF_REGIONS, normalizeRegionText } from "@/domain/regions";
import { cn } from "@/lib/cn";

/**
 * Выбор регионов из списка субъектов РФ.
 *
 * Раньше регион набирали свободным текстом, а в ленте выбирали только из тех,
 * что уже встретились в базе: Калмыкию нельзя было выбрать, пока по ней не
 * собрали ни одной закупки (замечание 05.10.2026). Теперь список один на все
 * экраны — все 85 субъектов, — и в профиль сохраняется каноническое название,
 * которое понимают и лента, и сборщик.
 *
 * Список показывается целиком, по группам, и регион выбирается кликом: человек
 * не обязан помнить, как называется субъект. Ввод только сужает список и
 * понимает короткие названия: «калмык», «Якутия», «ХМАО».
 */

interface Option {
  name: string;
  /** Название и варианты в нормализованном виде — по ним идёт поиск. */
  haystack: string[];
}

interface Group {
  title: string;
  options: Option[];
}

const GROUP_ORDER = ["Республики", "Края", "Области", "Города федерального значения", "Автономные округа и область"];

function groupOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("автономн")) return "Автономные округа и область";
  if (lower.includes("республик")) return "Республики";
  if (lower.includes(" край")) return "Края";
  if (lower.includes("область")) return "Области";
  return "Города федерального значения";
}

/** Ключ сортировки: «Республика Калмыкия» стоит на «К», а не среди двадцати «Р». */
function sortKey(name: string): string {
  return name.replace(/^Республика\s+/, "");
}

const GROUPS: readonly Group[] = (() => {
  const byTitle = new Map<string, Option[]>();
  for (const region of RF_REGIONS) {
    const title = groupOf(region.canonical);
    const list = byTitle.get(title) ?? [];
    list.push({
      name: region.canonical,
      haystack: [region.canonical, ...region.aliases].map(normalizeRegionText),
    });
    byTitle.set(title, list);
  }
  return GROUP_ORDER.map((title) => ({
    title,
    options: (byTitle.get(title) ?? []).sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name), "ru")),
  })).filter((group) => group.options.length > 0);
})();

function matches(option: Option, words: readonly string[]): boolean {
  return words.every((w) => option.haystack.some((h) => h.split(" ").some((part) => part.startsWith(w))));
}

export function RegionPicker({
  values,
  onChange,
  placeholder = "Выберите регион или начните вводить",
  max,
  id,
  ariaLabel = "Регион",
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Сколько регионов можно выбрать; не задано — без ограничения. */
  max?: number;
  id?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);

  const query = normalizeRegionText(draft);
  const groups = useMemo(() => {
    if (query === "") return GROUPS;
    const words = query.split(" ");
    return GROUPS.map((g) => ({ ...g, options: g.options.filter((o) => matches(o, words)) })).filter(
      (g) => g.options.length > 0,
    );
  }, [query]);
  const firstMatch = groups[0]?.options[0];

  const full = max !== undefined && values.length >= max;

  const toggle = (name: string) => {
    if (values.includes(name)) {
      onChange(values.filter((v) => v !== name));
      return;
    }
    if (full) return;
    onChange([...values, name]);
    // Выбрали из найденного по набранному слову («Бурят» → «Республика Бурятия») —
    // поиск сделал своё дело. Открытый после этого полный список перекрывал
    // кнопку под полем, и следующий клик попадал в соседний регион. Из полного
    // списка (запрос пуст) регионы по-прежнему выбираются подряд, без закрытия.
    if (draft.trim() !== "") setOpen(false);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (firstMatch !== undefined && draft.trim() !== "" && !values.includes(firstMatch.name)) toggle(firstMatch.name);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-autocomplete="list"
          value={draft}
          placeholder={
            full ? `Выбрано ${String(max)} — больше нельзя` : values.length === 0 ? `${placeholder} (пусто — вся Россия)` : placeholder
          }
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className={cn("w-full", values.length === 0 && "border-dashed")}
        />
        {open && (
          <div
            role="listbox"
            aria-multiselectable="true"
            // Клик по заголовку группы или полям списка не уводит фокус с поля:
            // иначе список закрылся бы посреди выбора.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute left-0 z-30 mt-1 max-h-80 w-full min-w-[18rem] overflow-auto rounded-control border border-border bg-panel py-1 shadow-card"
          >
            {groups.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">Такого региона в списке нет</p>
            )}
            {groups.map((group) => (
              <div key={group.title} role="group" aria-label={group.title}>
                <p className="sticky top-0 bg-panel px-3 pb-1 pt-2 text-[11.5px] font-semibold uppercase tracking-wide text-faint">
                  {group.title}
                </p>
                {group.options.map((o) => {
                  const selected = values.includes(o.name);
                  const disabled = !selected && full;
                  return (
                    <button
                      key={o.name}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={disabled}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                        selected ? "text-accent-fg" : "text-foreground",
                        disabled ? "cursor-not-allowed opacity-40" : "hover:bg-accent-subtle",
                      )}
                      // mousedown, а не click: иначе поле теряет фокус и список
                      // закрывается раньше, чем выбор успевает примениться.
                      // При просмотре полного списка он остаётся открытым: несколько
                      // регионов выбираются подряд. Если выбор сделан из результатов
                      // поиска по набранному слову, список закрывается (см. toggle).
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (!disabled) toggle(o.name);
                      }}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {selected && <Check className="h-4 w-4" aria-hidden />}
                      </span>
                      {o.name}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      {/*
        Выбранные — под полем, а не над ним: строка выбранных растёт при каждом
        клике и, стоя сверху, сдвигала бы список под курсором — следующий клик
        попадал бы в соседний регион.
      */}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            // Длинное название («Ханты-Мансийский автономный округ — Югра»)
            // переносится, а не обрезается краем колонки.
            <Badge key={v} tone="accent" className="max-w-full whitespace-normal text-left">
              {v}
              <button
                type="button"
                aria-label={`Убрать регион ${v}`}
                className="ml-0.5 shrink-0 opacity-60 hover:opacity-100"
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
