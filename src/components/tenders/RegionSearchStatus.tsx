"use client";

import { useEffect, useState } from "react";

import { searchAssistApiService } from "@/services/searchAssistApiService";

/**
 * Выбранный регион пуст — ищем в нём на площадках сразу.
 *
 * Раньше пустой регион молча подменялся всей Россией: лента откатывалась к
 * полной выдаче, и человек видел чужие регионы вместо честного «здесь пока
 * ничего». Теперь пустота названа, а поиск по региону запускается сам: ЕИС
 * принимает регион заказчика кодом, и найденное ложится в базу с этим регионом.
 *
 * Один и тот же запрос с теми же регионами за сеанс запускается один раз:
 * поиск идёт минуты и стоит прогона по чужим площадкам, а лента
 * перерисовывается при каждом обновлении.
 */

const started = new Set<string>();

/** Как часто спрашиваем о задании и сколько ждём всего. */
const POLL_MS = 10_000;
const MAX_WAIT_MS = 8 * 60_000;

type Phase =
  | { kind: "no-query" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export function RegionSearchStatus({
  query,
  keywords,
  regions,
  onDone,
}: {
  /** Что искать; null — человек не задал ни запроса, ни слов профиля. */
  query: string | null;
  /** Остальные слова профиля: идут в поиск вместе с запросом. */
  keywords: readonly string[];
  regions: readonly string[];
  /** Поиск закончен: лента перечитывает базу. */
  onDone: () => void;
}) {
  const key = `${query ?? ""}|${regions.join("|")}`;
  const [phase, setPhase] = useState<Phase>(() =>
    query === null ? { kind: "no-query" } : started.has(key) ? { kind: "done" } : { kind: "running" },
  );

  useEffect(() => {
    if (query === null) {
      setPhase({ kind: "no-query" });
      return;
    }
    if (started.has(key)) return;
    started.add(key);
    setPhase({ kind: "running" });

    let cancelled = false;
    void (async () => {
      try {
        const job = await searchAssistApiService.startLive(query, regions, keywords.slice(0, 10));
        if (job.cached !== true) {
          const deadline = Date.now() + MAX_WAIT_MS;
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            if (cancelled) return;
            const state = await searchAssistApiService.liveStatus(job.jobId);
            if (state.failed || state.status === "failed") {
              setPhase({ kind: "error", message: "Поиск на площадках не удался. Попробуйте позже." });
              return;
            }
            if (state.status === "completed") break;
            if (Date.now() > deadline) {
              setPhase({ kind: "error", message: "Поиск идёт дольше обычного. Обновите страницу через несколько минут." });
              return;
            }
          }
        }
        if (cancelled) return;
        setPhase({ kind: "done" });
        onDone();
      } catch (error) {
        // Повторить можно будет после перезагрузки: отказ (занято, лимит) не
        // должен навсегда запирать этот запрос в сеансе.
        started.delete(key);
        if (!cancelled) {
          setPhase({
            kind: "error",
            message: error instanceof Error ? error.message : "Поиск на площадках не запустился.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `keywords` и `onDone` намеренно не в зависимостях: новый массив на
    // каждой перерисовке перезапускал бы поиск.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const where = regions.join(", ");
  switch (phase.kind) {
    case "no-query":
      return (
        <p className="muted">
          Укажите, что вы ищете, — в строке поиска или в профиле поиска, — и мы найдём закупки на площадках в
          регионе {where}.
        </p>
      );
    case "running":
      return (
        <p className="muted" role="status">
          Ищу «{query}» на площадках в регионе {where} — обычно это занимает до пяти минут. Лента обновится сама.
        </p>
      );
    case "done":
      return (
        <p className="muted" role="status">
          На площадках по запросу «{query}» в регионе {where} открытых закупок сейчас нет. Попробуйте другие
          слова, соседний регион или загляните позже: новые закупки публикуются каждый день.
        </p>
      );
    case "error":
      return (
        <p className="text-[14px] text-brick-fg" role="alert">
          {phase.message}
        </p>
      );
  }
}
