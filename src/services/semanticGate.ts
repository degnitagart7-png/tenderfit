import type { ModelFit } from "@/domain/searchAssist";
import { runPool } from "@/lib/runPool";

/**
 * Отбор закупок по смыслу моделью.
 *
 * Слова профиля плохо описывают сферу деятельности: из 291 открытой закупки
 * Бурятии по словам «строительство, ремонт» остались «ремонт автобусов» и
 * «ремонт офисной техники», а «Благоустройство территории», «Устройство
 * тротуара» и «Сети водоснабжения» были выброшены (05.10.2026). Модель решает
 * по смыслу; решения кэшируются по теме и номеру закупки, поэтому каждый
 * прогон платит только за новые закупки.
 */

/** Сколько закупок в одном обращении к модели. */
export const JUDGE_BATCH = 30;
/** Сколько дней помнится решение. */
const CACHE_TTL_DAYS = 30;

export interface JudgeItem {
  id: string;
  subject: string;
  customer?: string;
}

/** Решение модели по пачке: id → оценка. Сбой — исключение. */
export type Judge = (topic: string, batch: readonly JudgeItem[]) => Promise<Record<string, ModelFit>>;

export interface FitCache {
  get(topic: string, id: string): ModelFit | undefined;
  set(topic: string, id: string, fit: ModelFit, atMs?: number): void;
  serialize(nowMs?: number): string;
}

const topicKey = (topic: string): string => topic.replace(/\s+/g, " ").trim().toLowerCase();

/** Кэш решений; `raw` — сохранённый ранее текст. Испорченный текст даёт пустой кэш. */
export function createFitCache(raw?: string): FitCache {
  const entries = new Map<string, { fit: ModelFit; at: number }>();
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (Array.isArray(parsed.entries)) {
        for (const e of parsed.entries as Array<[string, ModelFit, number]>) {
          if (Array.isArray(e) && typeof e[0] === "string" && typeof e[2] === "number") {
            entries.set(e[0], { fit: e[1], at: e[2] });
          }
        }
      }
    } catch {
      // Пустой кэш: модель спросят заново.
    }
  }
  const key = (topic: string, id: string) => `${topicKey(topic)}␟${id}`;
  return {
    get: (topic, id) => entries.get(key(topic, id))?.fit,
    set: (topic, id, fit, atMs = Date.now()) => {
      entries.set(key(topic, id), { fit, at: atMs });
    },
    serialize: (nowMs = Date.now()) => {
      const cutoff = nowMs - CACHE_TTL_DAYS * 86_400_000;
      const kept = [...entries].filter(([, v]) => v.at >= cutoff).map(([k, v]) => [k, v.fit, v.at]);
      return JSON.stringify({ entries: kept });
    },
  };
}

/**
 * Решения модели по закупкам темы: из кэша и новыми обращениями.
 *
 * Сбой пачки — по ней решения нет (вызывающий решит словами), остальные пачки
 * не страдают. `limit` — потолок новых решений за прогон: остальное решится в
 * следующий раз.
 */
export async function judgeBySense(input: {
  topic: string;
  items: readonly JudgeItem[];
  judge: Judge;
  cache: FitCache;
  limit?: number;
  concurrency?: number;
}): Promise<Map<string, ModelFit>> {
  const result = new Map<string, ModelFit>();
  const fresh: JudgeItem[] = [];
  for (const item of input.items) {
    const known = input.cache.get(input.topic, item.id);
    if (known !== undefined) result.set(item.id, known);
    else fresh.push(item);
  }

  const todo = fresh.slice(0, input.limit ?? fresh.length);
  const batches: JudgeItem[][] = [];
  for (let i = 0; i < todo.length; i += JUDGE_BATCH) batches.push(todo.slice(i, i + JUDGE_BATCH));

  await runPool(batches, input.concurrency ?? 3, async (batch) => {
    try {
      const verdicts = await input.judge(input.topic, batch);
      for (const item of batch) {
        const fit = verdicts[item.id];
        if (fit === undefined) continue;
        result.set(item.id, fit);
        input.cache.set(input.topic, item.id, fit);
      }
    } catch {
      // Пачка без решения: вызывающий отберёт её словами.
    }
  });
  return result;
}
