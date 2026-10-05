"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";
import type { RerankCandidate, RerankVerdict } from "@/domain/searchAssist";
import { searchAssistApiService } from "@/services/searchAssistApiService";

/**
 * Помощник поиска: расширить запрос и проверить выдачу по смыслу.
 *
 * Обе кнопки платные: за каждой стоит вызов языковой модели, поэтому ничего не
 * происходит само — ни при вводе запроса, ни при открытии страницы. Без
 * запроса панели нет: помогать не с чем.
 *
 * Зачем она нужна. Слова запроса ищутся по основе и не знают смысла: «юридические
 * услуги» не находит «правовое сопровождение» и находит «услуги юридическому
 * лицу». Первая кнопка лечит нехватку (предлагает, как ещё могли назвать),
 * вторая — лишнее (читает названия целиком и отмечает, что подходит).
 */
interface Props {
  query: string;
  /** Ключевые слова, уже добавленные в поиск: их повторно не предлагаем. */
  keywords?: readonly string[];
  /** Регионы, в которых искать на площадках; пусто — по всей России. */
  regions?: readonly string[];
  /** Первые закупки выдачи, не больше тридцати: токены растут линейно. */
  candidates: readonly RerankCandidate[];
  /** О чём компания, одной-двумя фразами: помогает модели понять «подходит ли нам». */
  companyNote?: string;
  verdicts: Record<string, RerankVerdict> | null;
  hideNo: boolean;
  onAddKeywords: (terms: string[]) => void;
  onVerdicts: (verdicts: Record<string, RerankVerdict> | null) => void;
  onHideNo: (hide: boolean) => void;
  /** Живой поиск закончен: лента должна перечитать базу, там появились закупки. */
  onLiveDone: () => void;
  /** Как часто опрашивать состояние задания; в тестах — почти без ожидания. */
  livePollMs?: number;
}

/** Дольше этого не ждём: прогон по четырём площадкам идёт минуты, но не десятки. */
const LIVE_MAX_WAIT_MS = 8 * 60_000;

function countFits(verdicts: Record<string, RerankVerdict>): { yes: number; maybe: number; no: number } {
  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const verdict of Object.values(verdicts)) counts[verdict.fit] += 1;
  return counts;
}

export function SearchAssistBar({
  query,
  keywords = [],
  regions = [],
  candidates,
  companyNote,
  verdicts,
  hideNo,
  onAddKeywords,
  onVerdicts,
  onHideNo,
  onLiveDone,
  livePollMs = 5000,
}: Props) {
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    Живой поиск. Прогон идёт минуты, поэтому страница опрашивает состояние
    задания и по окончании просит ленту перечитать базу. Опрос обрывается при
    уходе со страницы: иначе таймер продолжал бы стучаться в ручку.
  */
  const [live, setLive] = useState<{ phase: "idle" | "running" | "done" | "error"; message: string }>({
    phase: "idle",
    message: "",
  });
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  if (query.trim() === "") return null;

  const searchLive = async () => {
    setLive({ phase: "running", message: "" });
    try {
      const started = await searchAssistApiService.startLive(query.trim(), regions);
      if (started.cached === true) {
        setLive({ phase: "done", message: "Этот запрос уже искали недавно: найденное уже в базе." });
        onLiveDone();
        return;
      }

      const deadline = Date.now() + LIVE_MAX_WAIT_MS;
      while (!cancelled.current) {
        await new Promise((resolve) => setTimeout(resolve, livePollMs));
        if (cancelled.current) return;
        const state = await searchAssistApiService.liveStatus(started.jobId);
        if (state.failed || state.status === "failed") {
          setLive({ phase: "error", message: "Поиск не удался. Попробуйте ещё раз позже." });
          return;
        }
        if (state.status === "completed") {
          setLive({ phase: "done", message: state.note ?? "Поиск завершён." });
          onLiveDone();
          return;
        }
        if (Date.now() > deadline) {
          setLive({ phase: "error", message: "Поиск идёт дольше обычного. Обновите страницу через несколько минут." });
          return;
        }
      }
    } catch (e) {
      setLive({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const expand = async () => {
    setExpanding(true);
    setError(null);
    try {
      setSuggestions(await searchAssistApiService.expand(query.trim()));
    } catch (e) {
      setError(`Не удалось получить формулировки: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExpanding(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      onVerdicts(
        await searchAssistApiService.rerank({
          query: query.trim(),
          ...(companyNote === undefined || companyNote.trim() === "" ? {} : { companyNote }),
          candidates,
        }),
      );
    } catch (e) {
      setError(`Не удалось проверить по смыслу: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  const known = new Set(keywords.map((word) => word.toLowerCase()));
  const fresh = (suggestions ?? []).filter((word) => !known.has(word.toLowerCase()));
  const counts = verdicts === null ? null : countFits(verdicts);

  return (
    <div className="card space-y-3 p-4" data-testid="search-assist">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14.5px] font-medium text-foreground">Помощник поиска</span>
        <Button size="sm" variant="secondary" onClick={() => void expand()} disabled={expanding}>
          {expanding ? "Думаю…" : "Предложить формулировки"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void check()}
          disabled={checking || candidates.length === 0}
          title="Модель прочитает названия первых закупок и отметит, какие подходят по смыслу"
        >
          {checking ? "Проверяю…" : `Проверить по смыслу (первые ${String(Math.min(candidates.length, 30))})`}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void searchLive()}
          disabled={live.phase === "running"}
          title="Запрос уйдёт в ЕИС, Сбербанк-АСТ, Росэлторг и Фабрикант; найденное добавится в базу."
        >
          {live.phase === "running" ? "Ищу на площадках…" : "Искать на площадках"}
        </Button>
      </div>

      {error !== null && (
        <p className="text-[14px] text-brick-fg" role="alert">
          {error}
        </p>
      )}

      {live.phase === "running" && (
        <p className="muted" role="status">
          Запрос ищется на площадках — обычно это занимает до пяти минут. Страницу можно не закрывать:
          новые закупки появятся здесь сами.
        </p>
      )}
      {live.phase === "done" && (
        <p className="text-[14px] text-olive-fg" role="status">
          {live.message}
        </p>
      )}
      {live.phase === "error" && (
        <p className="text-[14px] text-brick-fg" role="alert">
          {live.message}
        </p>
      )}

      {suggestions !== null && (
        <div className="space-y-2">
          {fresh.length === 0 ? (
            <p className="muted">Новых формулировок нет.</p>
          ) : (
            <>
              <p className="muted">Так же заказчик мог назвать эту закупку. Нажмите, чтобы добавить в поиск:</p>
              <div className="flex flex-wrap items-center gap-2">
                {fresh.map((word) => (
                  <button
                    key={word}
                    type="button"
                    className="rounded-full border border-border bg-panel px-3 py-1 text-[14px] text-foreground hover:border-accent"
                    onClick={() => onAddKeywords([word])}
                  >
                    {word}
                  </button>
                ))}
                <button
                  type="button"
                  className="text-[14px] text-accent-fg hover:underline"
                  onClick={() => onAddKeywords(fresh)}
                >
                  Добавить все
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {counts !== null && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px] text-muted-foreground">
          <span>
            Модель проверила {counts.yes + counts.maybe + counts.no}: подходят: {counts.yes}, возможно:{" "}
            {counts.maybe}, не подходят: {counts.no}
          </span>
          <label className="flex items-center gap-2 text-foreground">
            <input
              type="checkbox"
              checked={hideNo}
              onChange={(e) => onHideNo(e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--accent))]"
            />
            Скрыть неподходящие
          </label>
          <button
            type="button"
            className="text-accent-fg hover:underline"
            onClick={() => {
              onVerdicts(null);
              onHideNo(false);
            }}
          >
            Сбросить оценки
          </button>
        </div>
      )}
    </div>
  );
}
