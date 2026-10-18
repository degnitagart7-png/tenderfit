"use client";

import "./globals.css";
import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * Сбой самого корневого макета. Next рисует этот файл вместо всего документа,
 * поэтому html и body — свои.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ru">
      <body>
        <ErrorScreen error={error} reset={reset} />
      </body>
    </html>
  );
}
