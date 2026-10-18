import { describe, expect, it, vi } from "vitest";

/** Обёртка отчёта: при импорте не запускается и не ходит в базу. */
describe("scripts/llm-cost-report", () => {
  it("импорт не запускает отчёт и не обращается к базе", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await import("./llm-cost-report");
      expect(log).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });
});
