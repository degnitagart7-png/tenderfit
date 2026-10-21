import { describe, expect, it } from "vitest";

import { buildSendPreview } from "@/domain/companyFacts/preview";
import { planExtraction } from "@/domain/companyFacts/extraction";
import { scrubPii } from "@/domain/companyFacts/scrubPii";

const REGISTRY = {
  id: "d1",
  name: "Реестр.pdf",
  category: "experience" as const,
  text: "Капитальный ремонт кровли школы № 5, 12 450 000 руб., 2024. Контакт: Сергеева Н. А., +7 913 123-45-67, sergeeva@omsk.ru",
};

describe("buildSendPreview", () => {
  it("показывает очищенный текст и считает скрытое", () => {
    const preview = buildSendPreview([REGISTRY]);
    const doc = preview.documents[0];
    expect(doc?.sentText).not.toMatch(/Сергеева|913|sergeeva@/u);
    expect(doc?.sentText).toContain("12 450 000");
    expect(doc?.stats).toMatchObject({ fio: 1, phone: 1, email: 1 });
    expect(preview.stats).toMatchObject({ fio: 1, phone: 1, email: 1 });
    expect(doc?.status).toBe("sent");
    expect(preview.calls).toBe(1);
  });

  it("предпросмотр совпадает с тем, что планирует серверная часть (по очищенному браузером тексту)", () => {
    const preview = buildSendPreview([REGISTRY]);
    // Браузер отправляет очищенный текст; сервер чистит его ещё раз и планирует запросы.
    const clientText = preview.documents[0]?.cleanText ?? "";
    const serverScrubbed = scrubPii(clientText).text;
    const plan = planExtraction([{ id: "d1", name: "x", category: "experience", text: serverScrubbed }]);
    expect(plan.batches.flat().map((piece) => piece.text).join("\n\n")).toBe(preview.documents[0]?.sentText);
    expect(plan.sentChars).toBe(preview.sentChars);
  });

  it("документ без читаемого текста помечен как не уходящий", () => {
    const preview = buildSendPreview([{ id: "d2", name: "Скан.pdf", category: "other", text: "Иванов Иван Иванович" }]);
    expect(preview.documents[0]?.status).toBe("skipped");
    expect(preview.documents[0]?.note).toMatch(/почти не осталось/u);
    expect(preview.calls).toBe(0);
  });

  it("длинный документ уходит частично, и это сказано", () => {
    const big = { id: "d3", name: "Большой.pdf", category: "experience" as const, text: "Выполнен ремонт кровли школы на 12 450 000 руб.\n".repeat(4000) };
    const preview = buildSendPreview([big]);
    expect(preview.documents[0]?.status).toBe("partial");
    expect(preview.documents[0]?.note).toMatch(/начало/u);
    expect(preview.sentChars).toBeLessThanOrEqual(120_000);
  });

  it("название компании из анкеты остаётся в тексте", () => {
    const preview = buildSendPreview(
      [{ id: "d4", name: "Акт.pdf", category: "other", text: "ИП Иванов Иван Иванович выполнил работы по акту № 3 на 1 200 000 руб." }],
      { keep: ["ИП Иванов Иван Иванович"] },
    );
    expect(preview.documents[0]?.sentText).toContain("ИП Иванов Иван Иванович");
  });
});
