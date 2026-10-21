import { describe, expect, it } from "vitest";

import { CALL_CHAR_BUDGET, TOTAL_CHAR_BUDGET, buildFactsPrompt, chunkText, planExtraction, type ExtractionDocument } from "@/domain/companyFacts/extraction";

const doc = (id: string, category: ExtractionDocument["category"], chars: number, name = `Файл ${id}.pdf`): ExtractionDocument => ({
  id,
  name,
  category,
  text: `${"Выполнен ремонт кровли школы на сумму 12 450 000 руб. ".repeat(Math.ceil(chars / 52))}`.slice(0, chars),
});

describe("chunkText", () => {
  it("короткий текст не режется", () => {
    expect(chunkText("abc", 100)).toEqual(["abc"]);
  });

  it("режет по абзацам, куски не длиннее предела", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Абзац ${String(i)} ${"слово ".repeat(20)}`).join("\n");
    const chunks = chunkText(text, 500);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.join("\n")).toContain("Абзац 29");
  });

  it("абзац длиннее предела режется по словам", () => {
    const chunks = chunkText("слово ".repeat(500), 400);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(400);
    expect(chunks.length).toBeGreaterThan(5);
  });
});

describe("planExtraction", () => {
  it("документы идут по важности: СРО и опыт раньше прочего", () => {
    const plan = planExtraction([doc("a", "other", 500), doc("b", "experience", 500), doc("c", "sro", 500)]);
    expect(plan.included).toEqual(["c", "b", "a"]);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.map((piece) => piece.label)).toEqual(["Документ 1", "Документ 2", "Документ 3"]);
  });

  it("названия файлов в запрос не попадают", () => {
    const plan = planExtraction([doc("a", "experience", 500, "Резюме Иванов Иван.pdf")]);
    const prompt = buildFactsPrompt(plan.batches[0] ?? []);
    expect(prompt).not.toContain("Иванов");
    expect(prompt).toContain("Документ 1 (тип: Опыт и контракты)");
  });

  it("общий бюджет: лишнее не входит и это видно", () => {
    const plan = planExtraction([doc("a", "experience", 80_000), doc("b", "experience", 80_000), doc("c", "other", 5_000)]);
    expect(plan.sentChars).toBe(TOTAL_CHAR_BUDGET);
    expect(plan.truncated).toBe(true);
    expect(plan.skipped.map((item) => item.id)).toContain("c");
    expect(plan.skipped.find((item) => item.id === "c")?.reason).toMatch(/лимит/u);
  });

  it("запрос не длиннее бюджета вызова, прайс-лист — отдельным запросом", () => {
    const plan = planExtraction([doc("a", "experience", 30_000), doc("b", "experience", 30_000), doc("p", "price", 20_000)]);
    for (const batch of plan.batches) {
      const total = batch.reduce((sum, piece) => sum + piece.text.length, 0);
      expect(total).toBeLessThanOrEqual(CALL_CHAR_BUDGET);
    }
    const priceBatch = plan.batches.find((batch) => batch.some((piece) => piece.category === "price"));
    expect(priceBatch).toHaveLength(1);
  });

  it("пустой после очистки документ пропускается с причиной", () => {
    const plan = planExtraction([{ id: "a", name: "пусто.pdf", category: "other", text: "[ФИО]" }]);
    expect(plan.batches).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toMatch(/почти не осталось/u);
  });

  it("промпт требует JSON, запрещает личное и содержит схему", () => {
    const prompt = buildFactsPrompt(planExtraction([doc("a", "price", 300)]).batches[0] ?? []);
    expect(prompt).toContain("ТОЛЬКО один JSON-объект");
    expect(prompt).toContain("Никаких персональных данных");
    expect(prompt).toContain('"price_rub"');
    expect(prompt).toContain("Тип: Прайс-лист".replace("Тип: ", "тип: "));
  });
});
