import { describe, expect, it } from "vitest";

import { sanitizePgText, sanitizePgTextOrNull } from "@/lib/sanitizeText";

describe("sanitizePgText", () => {
  it("убирает нулевой символ, который Postgres не принимает в text", () => {
    expect(sanitizePgText("Срок\u0000 поставки\u0000")).toBe("Срок поставки");
  });

  it("убирает прочие управляющие знаки, кроме табуляции и переводов строки", () => {
    expect(sanitizePgText("а\u0001б\u0008в\u000bг\u000cд\u001fе")).toBe(
      "абвгде",
    );
    expect(sanitizePgText("строка\tтаб\nновая\r\nещё")).toBe(
      "строка\tтаб\nновая\r\nещё",
    );
  });

  it("убирает одиночные суррогаты, но не трогает настоящие пары", () => {
    expect(sanitizePgText("a\uD800b\uDC00c")).toBe("abc");
    expect(sanitizePgText("смайл 😀 цел")).toBe("смайл 😀 цел");
  });

  it("обычный текст не меняется", () => {
    const text = "Ведомость объёмов № 1 — 125,5 м²";
    expect(sanitizePgText(text)).toBe(text);
  });

  it("версия для null", () => {
    expect(sanitizePgTextOrNull(null)).toBeNull();
    expect(sanitizePgTextOrNull("а\u0000б")).toBe("аб");
  });
});
