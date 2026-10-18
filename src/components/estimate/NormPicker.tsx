"use client";

import { useEffect, useState } from "react";

import { Button, Input } from "@/components/ui/primitives";
import type { NormPick } from "@/domain/estimate/billEdits";
import type { NormSearchHit } from "@/domain/estimate/normSearch";
import type { EstimateMethod } from "@/domain/estimate/types";
import { readJsonOrThrow } from "@/lib/readJson";

/**
 * Поиск нормы по базе ФСНБ-2022: шифр («06-01-001-01», «ГЭСНм 08-01-001-01») или слова.
 *
 * В базисно-индексном методе (`method="BASE_INDEX"`) ищется расценка ФЕР-2020 («ФЕР 06-01-001-01», «ФЕРм 08-01-001-01»): смета
 * по этому методу считается по ФЕР, и норма ГЭСН в ней ничего не значила бы.
 *
 * Поиск идёт на сервере (`/api/estimate/norms`): база норм весит сотни мегабайт и в браузер не
 * едет. Запрос уходит через паузу в наборе, короткий запрос не ищется. Выбранная норма — всегда
 * запись из базы: придумать шифр здесь нельзя.
 */

const PAUSE_MS = 300;
const MIN_QUERY = 2;

type Hit = NormSearchHit & { readonly unitOk?: boolean };

interface SearchResponse {
  readonly items: readonly Hit[];
  readonly note: string | null;
}

export function NormPicker({
  unit,
  onPick,
  method = "RESOURCE_INDEX",
  placeholder = method === "BASE_INDEX" ? "Шифр (ФЕР 06-01-001-01) или слова: демонтаж стен" : "Шифр (06-01-001-01) или слова: демонтаж стен",
}: {
  /** Единица позиции: нормы с другой единицей помечаются предупреждением. */
  readonly unit?: string;
  readonly onPick: (pick: NormPick, hit: Hit) => void;
  /** Метод сметы: от него зависит, где искать (нормы ГЭСН или расценки ФЕР-2020). */
  readonly method?: EstimateMethod;
  readonly placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly Hit[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const text = query.trim();
    if (text.length < MIN_QUERY) {
      setItems([]);
      setNote(null);
      setError(null);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ q: text, limit: "8" });
          if (unit !== undefined && unit !== "") params.set("unit", unit);
          if (method === "BASE_INDEX") params.set("method", method);
          const response = await fetch(`/api/estimate/norms?${params.toString()}`);
          const payload = await readJsonOrThrow<SearchResponse>(response);
          if (cancelled) return;
          setItems(payload.items);
          setNote(payload.note);
          setError(null);
        } catch (err) {
          if (cancelled) return;
          setItems([]);
          setError(err instanceof Error ? err.message : "Поиск не удался");
        } finally {
          if (!cancelled) setBusy(false);
        }
      })();
    }, PAUSE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, unit, method]);

  return (
    <div className="space-y-2" data-testid="norm-picker">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={method === "BASE_INDEX" ? "Найти расценку ФЕР по шифру или словам" : "Найти норму по шифру или словам"}
      />
      {busy && <p className="text-xs text-muted-foreground">Ищем…</p>}
      {error !== null && <p className="text-xs text-brick-fg">{error}</p>}
      {!busy && error === null && note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
      {items.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60" data-testid="norm-results">
          {items.map((hit) => (
            <li key={`${hit.baseType}-${hit.code}`} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">
                  {hit.baseType} {hit.code}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">ед. нормы: {hit.unit}</span>
                </p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{hit.name}</p>
                {hit.unitOk === false && (
                  <p className="text-xs text-mustard-fg">Единица нормы не совпадает с единицей позиции — позиция не войдёт в расчёт</p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onPick({ code: hit.code, baseType: hit.baseType }, hit)}
              >
                Выбрать
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
