"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/** Сбой страницы приложения: меню остаётся, вместо страницы — экран с перезагрузкой: экран с перезагрузкой вместо «Application error». */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} />;
}
