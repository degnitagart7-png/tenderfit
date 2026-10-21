import { describe, expect, it, vi } from "vitest";

import { FactsExtractionError, extractCompanyFacts, type FactsInputDocument } from "@/services/companyFactsService";
import type { ChatFn } from "@/services/searchAssistService";

const NOW = new Date("2026-10-21T12:00:00Z");

const REGISTRY: FactsInputDocument = {
  id: "d1",
  name: "Реестр контрактов Иванов Иван Иванович.pdf",
  category: "experience",
  text: [
    "Реестр исполненных контрактов ООО «СтройОмск», ИНН 5503123456",
    "1. Капитальный ремонт кровли школы № 5, Администрация Кировского округа, 12 450 000 руб., 2024 год, 44-ФЗ",
    "Контактное лицо заказчика: Сергеева Н. А., тел. 8 (3812) 22-33-44, sergeeva@omsk.ru",
    "Исполнитель: главный инженер Петров Пётр Петрович, паспорт 5215 123456",
  ].join("\n"),
};

const PRICE: FactsInputDocument = {
  id: "d2",
  name: "Прайс.xlsx",
  category: "price",
  text: "Демонтаж кровельного покрытия | м2 | 340\nУстройство пароизоляции | м2 | 210\n".repeat(3),
};

function chatReturning(...contents: string[]): ChatFn & ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(async () => ({ content: contents[Math.min(index++, contents.length - 1)] ?? "{}", tokens: 1000 })) as never;
}

describe("extractCompanyFacts", () => {
  it("в модель уходит только очищенный текст: ни ФИО, ни телефона, ни почты, ни паспорта, ни имени файла", async () => {
    const chat = chatReturning(JSON.stringify({ contracts: [{ subject: "Капитальный ремонт кровли школы № 5", year: 2024, sum_rub: 12_450_000, law: "44-ФЗ" }] }));
    const result = await extractCompanyFacts({ documents: [REGISTRY], companyInn: "5503123456", userId: "u1", now: NOW }, { chat });

    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = String(chat.mock.calls[0]?.[0]);
    expect(prompt).not.toMatch(/Сергеева|Петров|Пётр|22-33-44|sergeeva@|5215 123456|Иванов Иван/u);
    expect(prompt).toContain("Капитальный ремонт кровли школы № 5");
    expect(prompt).toContain("ИНН 5503123456");
    expect(prompt).toContain("12 450 000");
    expect(prompt).toContain("[ФИО]");

    expect(result.facts.scrubStats.fio).toBeGreaterThanOrEqual(2);
    expect(result.facts.scrubStats.phone).toBe(1);
    expect(result.facts.scrubStats.email).toBe(1);
    expect(result.facts.scrubStats.passport).toBe(1);
    expect(result.facts.sourceDocuments).toEqual(["Реестр контрактов Иванов Иван Иванович.pdf"]);
    expect(result.facts.contracts[0]).toMatchObject({ id: "c1", sumRub: 12_450_000, year: 2024, law: "44-FZ" });
  });

  it("вызов идёт с видом работы company_facts, без «рассуждений», с пользователем", async () => {
    const chat = chatReturning("{}");
    await extractCompanyFacts({ documents: [REGISTRY], userId: "u1", now: NOW }, { chat });
    const [, maxTokens, context, options] = chat.mock.calls[0] ?? [];
    expect(maxTokens).toBeGreaterThanOrEqual(8000);
    expect(context).toEqual({ purpose: "company_facts", userId: "u1" });
    expect(options).toMatchObject({ reasoning: false });
  });

  it("прайс-лист уходит отдельным запросом, ответы сливаются", async () => {
    const chat = chatReturning(
      JSON.stringify({ contracts: [{ subject: "Ремонт кровли школы", year: 2024, sum_rub: 5_000_000 }] }),
      JSON.stringify({ prices: [{ name: "Демонтаж кровельного покрытия", unit: "м2", price_rub: 340, kind: "work" }] }),
    );
    const result = await extractCompanyFacts({ documents: [PRICE, REGISTRY], userId: "u1", now: NOW }, { chat });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.calls).toBe(2);
    expect(result.facts.contracts).toHaveLength(1);
    expect(result.facts.prices).toHaveLength(1);
    expect(result.facts.prices[0]).toMatchObject({ name: "Демонтаж кровельного покрытия", unit: "м2", priceRub: 340 });
  });

  it("один запрос не удался — остальное сохраняется, сбой виден", async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(new Error("шлюз 502"))
      .mockResolvedValueOnce({ content: JSON.stringify({ prices: [{ name: "Кирпич", unit: "шт", price_rub: 18 }] }), tokens: 10 }) as unknown as ChatFn;
    const result = await extractCompanyFacts({ documents: [REGISTRY, PRICE], userId: "u1", now: NOW }, { chat });
    expect(result.failedCalls).toBe(1);
    expect(result.facts.prices).toHaveLength(1);
  });

  it("все запросы упали — ошибка, а не пустой «успех», который стёр бы прежние факты", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("шлюз 502")) as unknown as ChatFn;
    await expect(extractCompanyFacts({ documents: [REGISTRY], userId: "u1", now: NOW }, { chat })).rejects.toBeInstanceOf(FactsExtractionError);
  });

  it("ответ не по формату считается сбоем запроса", async () => {
    const chat = chatReturning("не JSON вообще");
    await expect(extractCompanyFacts({ documents: [REGISTRY], userId: "u1", now: NOW }, { chat })).rejects.toThrow(/не вернула факты/u);
  });

  it("нет текста — ошибка без вызова модели", async () => {
    const chat = chatReturning("{}");
    await expect(
      extractCompanyFacts({ documents: [{ id: "x", name: "пусто", category: "other", text: "Иванов Иван Иванович" }], userId: "u1", now: NOW }, { chat }),
    ).rejects.toBeInstanceOf(FactsExtractionError);
    expect(chat).not.toHaveBeenCalled();
  });

  it("модель домыслила личное — запись выбрасывается, счётчик растёт", async () => {
    const chat = chatReturning(
      JSON.stringify({
        contracts: [
          { subject: "Ремонт для Кузнецова Алексея Сергеевича", year: 2024, sum_rub: 1_000_000 },
          { subject: "Ремонт кровли школы", year: 2024, sum_rub: 2_000_000 },
        ],
      }),
    );
    const result = await extractCompanyFacts({ documents: [REGISTRY], userId: "u1", now: NOW }, { chat });
    expect(result.droppedForPii).toBe(1);
    expect(result.facts.contracts.map((item) => item.subject)).toEqual(["Ремонт кровли школы"]);
  });

  it("название компании из анкеты (ИП) остаётся в тексте", async () => {
    const chat = chatReturning("{}");
    await extractCompanyFacts(
      {
        documents: [{ id: "d", name: "Акт.pdf", category: "other", text: "ИП Иванов Иван Иванович выполнил работы по акту № 3 на сумму 1 200 000 руб. ИНН 550312345678" }],
        companyInn: "550312345678",
        companyName: "ИП Иванов Иван Иванович",
        userId: "u1",
        now: NOW,
      },
      { chat },
    );
    const prompt = String(chat.mock.calls[0]?.[0]);
    expect(prompt).toContain("ИП Иванов Иван Иванович");
    expect(prompt).toContain("ИНН 550312345678");
  });
});
