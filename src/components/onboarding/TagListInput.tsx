"use client";

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Badge, Input } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

/**
 * Поле ввода списка строк: добавление по Enter или запятой, удаление крестиком.
 * Используется для ключевых слов, регионов, ОКПД2 и т.п.
 */
export function TagListInput({
  values,
  onChange,
  placeholder,
  id,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  id?: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...values];
    for (const p of parts) {
      if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <Badge key={v} tone="accent">
            {v}
            <button
              type="button"
              aria-label={`Удалить ${v}`}
              className="ml-0.5 opacity-60 hover:opacity-100"
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        className={cn(values.length === 0 && "border-dashed")}
      />
    </div>
  );
}
