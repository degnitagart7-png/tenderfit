import { describe, expect, it, vi } from "vitest";

/**
 * Обёртка скрипта повторного разбора: при импорте она не запускается и не
 * ходит ни в базу, ни в сеть. Сама логика — в src/services/documentReparse.ts
 * (отбор по причинам, бюджет, тома, dry-run) и проверена там на портах.
 */
describe("scripts/reparse-unreadable", () => {
  it("импорт не запускает прогон и не обращается к базе", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await import("./reparse-unreadable");
      expect(log).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  it("разбор флагов командной строки живёт в сервисе и общий с тестами", async () => {
    const { parseReparseArgs } = await import("../src/services/documentReparse");
    expect(parseReparseArgs(["--dry-run"]).dryRun).toBe(true);
  });
});
