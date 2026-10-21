"use client";

import { useEffect, useState } from "react";

import type { LlmCostCardData } from "@/app/api/llm-cost/route";
import { Button, Card, Field, Input } from "@/components/ui/primitives";
import { formatRub } from "@/domain/llmCostReport";
import { describeError } from "@/lib/errors";
import { llmCostApiService } from "@/services/llmCostApiService";

/** Тот же ключ в памяти браузера, что у карточки профилей сбора. */
const TOKEN_KEY = "tenderfit.adminToken";

const PURPOSE_NAMES: Record<string, string> = {
  deep_analysis: "Глубокий анализ",
  estimate_bill: "Смета (ведомость)",
  estimate_norm_pick: "Смета (подбор норм)",
  estimate_implied: "Смета (работы по технологии)",
  search_assist: "Помощник поиска",
  rerank: "Оценка по смыслу",
  company_facts: "Факты компании (из документов)",
  company_fit: "Соответствие компании закупке",
  other: "Прочее",
};

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Память браузера недоступна: ключ придётся ввести снова, на показ это не влияет.
  }
}

/**
 * Расход на ИИ за 30 дней (раздел администрирования).
 *
 * Цифры берутся из журнала llm_usage_log через закрытую ключом ручку
 * /api/llm-cost: по видам работ, на один глубокий анализ и итог за период.
 * Списка дорогих закупок здесь нет — он в scripts/llm-cost-report.ts.
 */
export function LlmCostCard() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<LlmCostCardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(readToken());
  }, []);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await llmCostApiService.fetch(token.trim());
      rememberToken(token.trim());
      setData(result);
    } catch (err) {
      setData(null);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = data?.summary;
  const deep = summary?.deepAnalysis;

  return (
    <Card title="Расход на ИИ">
      <p className="text-sm text-muted-foreground">
        Сколько денег ушло на языковую модель за последние 30 дней: по каждому вызову, в рублях.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <Field label="Ключ владельца">
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Button onClick={() => void load()} disabled={token.trim() === "" || busy}>
          {busy ? "Загружаю…" : "Показать"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-mustard-fg">
          {error}
        </p>
      )}

      {summary && deep && (
        <div className="mt-4 space-y-3 text-sm">
          <p>
            Итого за {data?.windowDays} дн.: <strong>{formatRub(summary.totalRub)}</strong>, вызовов{" "}
            {summary.totalCalls}; в среднем в день {formatRub(summary.avgPerDayRub)}.
          </p>

          <div>
            <p className="font-medium">Один глубокий анализ</p>
            {deep.count === 0 ? (
              <p className="text-muted-foreground">Анализов за период не было.</p>
            ) : (
              <p className="text-muted-foreground">
                {deep.count} шт.: в среднем {formatRub(deep.avgRub)}, медиана {formatRub(deep.medianRub)}, 90-й
                перцентиль {formatRub(deep.p90Rub)}, максимум {formatRub(deep.maxRub)}; в среднем{" "}
                {Math.round(deep.avgInputChars).toLocaleString("ru-RU")} знаков текста.
              </p>
            )}
          </div>

          <div>
            <p className="font-medium">По видам работ</p>
            {summary.byPurpose.length === 0 ? (
              <p className="text-muted-foreground">Вызовов не было.</p>
            ) : (
              <ul className="text-muted-foreground">
                {summary.byPurpose.map((entry) => (
                  <li key={entry.purpose}>
                    {PURPOSE_NAMES[entry.purpose] ?? entry.purpose}: {formatRub(entry.costRub)}, вызовов{" "}
                    {entry.calls}
                    {entry.failedCalls > 0 ? ` (с ошибкой ${entry.failedCalls})` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
