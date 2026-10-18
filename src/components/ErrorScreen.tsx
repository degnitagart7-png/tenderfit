"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { isChunkLoadError, nextChunkReloadDelay } from "@/lib/chunkReload";

/**
 * Экран вместо голого «Application error».
 *
 * Устаревшая вкладка после выкладки перезагружается сама, при надобности —
 * несколько раз, пока сервер не дособерётся (см. chunkReload). Любой
 * другой сбой показывает человеку понятный текст, кнопку «Обновить страницу» и
 * саму ошибку мелким шрифтом: по ней сбой можно найти, не прося открыть консоль
 * браузера.
 */
export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    console.error(error);
    if (!isChunkLoadError(error)) return;
    const delay = nextChunkReloadDelay();
    if (delay === null) return;
    setReloading(true);
    const timer = setTimeout(() => window.location.reload(), delay);
    return () => clearTimeout(timer);
  }, [error]);

  if (reloading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6 text-center">
        <RefreshCw className="h-5 w-5 animate-spin text-accent motion-reduce:animate-none" aria-hidden />
        <p className="text-[16px] font-medium text-foreground">Обновляем сервис, подождите…</p>
        <p className="text-[14px] text-muted-foreground">Страница откроется сама, обычно меньше чем через минуту.</p>
      </div>
    );
  }

  const detail = [error.name !== "Error" ? error.name : null, error.message, error.digest ? `код ${error.digest}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-card border border-border bg-panel p-8 text-center">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Что-то пошло не так</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
          Страница не смогла открыться. Чаще всего помогает обновить её: возможно, вышло обновление сервиса.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[15px] font-semibold text-white hover:opacity-90"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Обновить страницу
          </button>
          {reset ? (
            <button
              type="button"
              onClick={reset}
              className="rounded-full border border-border px-5 py-2.5 text-[15px] font-medium text-foreground hover:border-border-strong"
            >
              Попробовать снова
            </button>
          ) : null}
        </div>
        {detail ? <p className="mt-6 break-words text-[12px] leading-snug text-faint">{detail}</p> : null}
      </div>
    </div>
  );
}
