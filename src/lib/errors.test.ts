import { describe, it, expect } from "vitest";
import { describeError } from "./errors";

/** Ошибка сети в том виде, в каком её бросает fetch. */
function networkError(message: string, code: string): Error {
  const err = new Error(message);
  (err as Error & { cause: { code: string } }).cause = { code };
  return err;
}

describe("describeError", () => {
  it("обычная ошибка остаётся собой", () => {
    expect(describeError(new Error("не прочитался JSON"))).toBe("не прочитался JSON");
  });

  it("не Error приводится к строке", () => {
    expect(describeError("timeout")).toBe("timeout");
    expect(describeError(42)).toBe("42");
    expect(describeError(NaN)).toBe("NaN");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("код причины добавляется к сообщению", () => {
    expect(describeError({ message: "boom", code: "EPROTO" })).toBe("boom (EPROTO)");
    expect(describeError(networkError("boom", "EPROTO"))).toBe("boom (EPROTO)");
  });

  it("обрыв соединения объясняется адресом, а не только кодом", () => {
    // Именно так ЕИС отвечает зарубежному адресу: без этой подписи в логе
    // остаётся «fetch failed», по которому причину не найти.
    for (const code of ["ETIMEDOUT", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]) {
      const text = describeError(networkError("fetch failed", code));

      expect(text).toContain(`fetch failed (${code})`);
      expect(text).toContain("источник не пускает наш адрес");
    }
  });

  it("сбой DNS не выдаётся за отказ источника", () => {
    expect(describeError(networkError("fetch failed", "EAI_AGAIN"))).toBe(
      "fetch failed (EAI_AGAIN)",
    );
  });

  it("ошибка PostgREST — объект, и он не превращается в [object Object]", () => {
    // Именно такой объект возвращает supabase-js, когда миграция не применена.
    // Прежде воркер печатал «Критическая ошибка: [object Object]», и причину
    // неприменённой миграции приходилось угадывать.
    expect(
      describeError({
        message: "Could not find the table public.sync_jobs",
        details: "",
        hint: "",
        code: "PGRST205",
      }),
    ).toBe("Could not find the table public.sync_jobs (PGRST205)");
  });

  it("детали ошибки базы попадают в строку", () => {
    expect(
      describeError({
        message: "new row violates row-level security policy",
        details: "Failing row contains (id)",
        code: "42501",
      }),
    ).toBe("new row violates row-level security policy — Failing row contains (id) (42501)");
  });

  it("объект без сообщения раскрывается JSON-ом", () => {
    expect(describeError({ reason: "нет связи" })).toContain("нет связи");
  });

  it("нечитаемая причина не роняет расшифровку", () => {
    const withNullCause = new Error("boom");
    (withNullCause as Error & { cause: null }).cause = null;

    expect(describeError(withNullCause)).toBe("boom");
    expect(describeError(null)).toBe("null");
  });
});
