import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // Распознавание сканов в тестах выключено: Tesseract на машине разработчика
    // не должен запускаться сам. Тесты ocr.ts подставляют свой порт запуска.
    // Так же выключен дисковый путь распаковки (7z, unrar): на машине разработчика
    // программы могут быть, и тесты не должны зависеть от этого. Тесты дискового
    // пути подставляют свой запуск команд.
    // Затвор запросов к ЕИС по умолчанию пишет data/eis-gate.json в проекте: тесты,
    // которые случайно поймают блокировку, не должны трогать настоящий файл.
    env: {
      TENDERFIT_OCR: "off",
      TENDERFIT_ARCHIVE_CLI: "off",
      EIS_GATE_FILE: path.join(os.tmpdir(), "tenderfit-vitest-eis-gate.json"),
      // Кэш ответов модели (llmResponseCache.ts) в тестах выключен: он ходит в базу, а тесты базу не трогают.
      // Тесты самого кэша подставляют своё окружение и хранилище.
      LLM_CACHE_DISABLED: "1",
      // Журнал действий (services/userEventLog.ts) ходит в базу: в тестах выключен, его тесты включают его сами.
      USER_EVENTS_DISABLED: "1",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
