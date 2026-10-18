import { describe, expect, it } from "vitest";

import {
  applyLegalRules,
  buildConsolidationPrompt,
  finalizeConsolidated,
  parseConsolidationResponse,
  readConsolidated,
  type ConsolidationTender,
} from "@/domain/analysisConsolidation";
import type { AnalysisFinding } from "@/types/database";

const tender: ConsolidationTender = {
  regNumber: "0302300083426000012",
  subject: "Капитальный ремонт лыжной базы",
  price: 9_831_629.07,
  law: "FZ_44",
  submissionEnd: "2026-10-20T00:00:00Z",
  region: "Республика Бурятия",
};

function finding(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    category: "risk",
    title: "Фактор",
    detail: "",
    evidence_quote: "цитата",
    evidence_section: "п. 1",
    severity: "medium",
    ...patch,
  };
}

const sro = finding({
  category: "blocker",
  severity: "high",
  title: "Обязательное членство в СРО в области капитального ремонта",
  evidence_quote: "Участник закупки должен являться членом саморегулируемой организации",
  requirement_kind: "SRO",
});

describe("правила закона: СРО", () => {
  it("НМЦК до 10 млн — блокер СРО становится риском с пояснением и вопросом заказчику", () => {
    const { findings, questions } = applyLegalRules([sro], tender);

    expect(findings[0]!.category).toBe("risk");
    expect(findings[0]!.legal_note).toMatch(/ч\. 2\.1 ст\. 52 ГрК РФ/);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/не требуется/);
  });

  it("НМЦК больше 10 млн или неизвестна — СРО остаётся блокером", () => {
    expect(applyLegalRules([sro], { price: 25_000_000 }).findings[0]!.category).toBe("blocker");
    expect(applyLegalRules([sro], { price: null }).findings[0]!.category).toBe("blocker");
  });

  it("СРО узнаётся и по тексту без вида требования; посторонние выводы не трогаются", () => {
    const byText = finding({ category: "blocker", title: "Требуется членство в СРО" });
    const other = finding({ category: "blocker", title: "Лицензия МЧС", requirement_kind: "LICENSE" });
    const rose = finding({ category: "blocker", title: "Поставка роз и сроков" });
    const { findings, questions } = applyLegalRules([byText, other, rose], tender);

    expect(findings.map((f) => f.category)).toEqual(["risk", "blocker", "blocker"]);
    expect(questions).toHaveLength(1);
  });
});

describe("ответ модели", () => {
  const answer = `Вот сводка:
\`\`\`json
{"summary":"Участвовать можно: допуск есть, главный риск — сжатые сроки.",
 "findings":[
   {"category":"blocker","severity":"high","title":"Членство в СРО","detail":"…","evidence_quote":"членом саморегулируемой организации","evidence_section":"9","requirement_kind":"SRO","required_value":null,"sources":["ТЗ.docx"]},
   {"category":"чепуха","title":"битый"},
   {"category":"risk","severity":"medium","title":"Гарантия 60 месяцев","detail":"…","evidence_quote":"60 месяцев","evidence_section":"","requirement_kind":null,"sources":["Проект контракта.docx","ТЗ.docx"]}
 ],
 "conflicts":[{"topic":"Срок выполнения","values":[{"value":"до 20.11.2026","source":"Проект контракта.docx"},{"value":"до 30.11.2026","source":"ТЗ.docx"}],"resolution":"по проекту контракта — до 20.11.2026","needs_question":true}],
 "questions":["Уточните срок выполнения работ: 20.11 или 30.11?"],
 "facts":{"work_end":"2026-11-20","warranty_months":"60","contract_security_percent":5,"warranty_security_percent":"5,0","bid_security_percent":null}}
\`\`\``;

  it("разбирается с прозой вокруг; битый вывод отбрасывается, числа из строк читаются", () => {
    const parsed = parseConsolidationResponse(answer);

    expect(parsed.findings.map((f) => f.title)).toEqual(["Членство в СРО", "Гарантия 60 месяцев"]);
    expect(parsed.findings[1]!.sources).toEqual(["Проект контракта.docx", "ТЗ.docx"]);
    expect(parsed.conflicts[0]!.values).toHaveLength(2);
    expect(parsed.facts).toMatchObject({
      work_end: "2026-11-20",
      warranty_months: 60,
      contract_security_percent: 5,
      warranty_security_percent: 5,
      bid_security_percent: null,
      payment_days: null,
    });
  });

  it("после правил закона СРО — риск, а вопрос про СРО добавлен один раз", () => {
    const final = finalizeConsolidated(parseConsolidationResponse(answer), tender);

    expect(final.findings[0]!.category).toBe("risk");
    expect(final.questions).toHaveLength(2);
    expect(final.questions.filter((q) => /СРО/.test(q))).toHaveLength(1);
  });

  it("сводка из строки базы читается; обычный разбор документа — не сводка", () => {
    const final = finalizeConsolidated(parseConsolidationResponse(answer), tender);
    expect(readConsolidated(JSON.parse(JSON.stringify(final)))?.conflicts).toHaveLength(1);
    expect(readConsolidated({ findings: [], summary: "" })).toBeNull();
    expect(readConsolidated(null)).toBeNull();
  });
});

describe("норма закона и обычай не находка", () => {
  const rnp = finding({ category: "blocker", severity: "high", title: "Отсутствие в реестре недобросовестных поставщиков" });
  const treasury = finding({ severity: "high", title: "Казначейское сопровождение аванса" });
  const winter = finding({ title: "Работы в зимний период" });

  it("в запрос модели не попадает типовое допуска, а условия 44-ФЗ идут с пометкой «только для facts»", () => {
    const prompt = buildConsolidationPrompt(tender, [
      { document: "Извещение", finding: rnp },
      { document: "Проект контракта", finding: treasury },
      { document: "Проект контракта", finding: winter },
    ]);

    expect(prompt).not.toContain("недобросовестных поставщиков");
    expect(prompt).toContain("Казначейское сопровождение аванса (типовое по закону — только для facts)");
    expect(prompt).toContain("Работы в зимний период");
    expect(prompt).toContain("## Что НЕ является находкой");
    expect(prompt).toContain("Отклонение от нормы — находка");
    expect(prompt).toMatch(/записывай только в facts, в findings их не включай/);
  });

  it("для 223-ФЗ казначейство остаётся обычным выводом без пометки", () => {
    const prompt = buildConsolidationPrompt({ ...tender, law: "FZ_223" }, [{ document: "Контракт", finding: treasury }]);
    expect(prompt).toContain("Казначейское сопровождение аванса");
    expect(prompt).not.toContain("только для facts)");
  });

  it("после сведения типовое допуска убрано, условия 44-ФЗ в пределах закона остаются в данных для блока «Деньги»", () => {
    const bid = finding({ category: "requirement", title: "Обеспечение заявки", required_value: "1 % НМЦК" });
    const final = finalizeConsolidated(
      {
        kind: "consolidated",
        summary: "",
        findings: [rnp, bid, winter].map((f) => ({ ...f, sources: [] })),
        conflicts: [],
        questions: [],
        facts: parseConsolidationResponse("{}").facts,
      },
      tender,
    );
    expect(final.findings.map((f) => f.title)).toEqual(["Обеспечение заявки", "Работы в зимний период"]);
  });
});

describe("запрос к модели", () => {
  it("называет закупку, документы каждого вывода и приоритет документов", () => {
    const prompt = buildConsolidationPrompt(tender, [
      { document: "ТЗ.docx", finding: sro },
      { document: "Проект контракта.docx", finding: finding({ title: "Пеня от цены контракта" }) },
    ]);

    expect(prompt).toContain("9831629.07 ₽");
    expect(prompt).toContain("документ: ТЗ.docx");
    expect(prompt).toContain("извещение и его реквизиты > проект контракта");
    expect(prompt.indexOf("Обязательное членство в СРО")).toBeLessThan(prompt.indexOf("Пеня от цены контракта"));
    // НМЦК до 10 млн: правило закона про СРО — прямо в запросе, чтобы и итог его не нарушал.
    expect(prompt).toContain("ч. 2.1 ст. 52 ГрК РФ");
    expect(buildConsolidationPrompt({ ...tender, price: 25_000_000 }, [])).not.toContain("ч. 2.1 ст. 52 ГрК РФ");
  });
});

describe("СРО проектировщиков и итог", () => {
  const designSro = finding({
    category: "blocker",
    severity: "high",
    title: "Обязательное членство в СРО по архитектурно-строительному проектированию",
    requirement_kind: "SRO",
  });

  it("СРО по проектированию правилом «до 10 млн» не понижается: у него своя норма (ч. 4.1 ст. 48 ГрК)", () => {
    const { findings, questions } = applyLegalRules([designSro, sro], tender);
    expect(findings.map((f) => f.category)).toEqual(["blocker", "risk"]);
    expect(findings[0]!.legal_note).toBeUndefined();
    expect(questions).toHaveLength(1);
  });

  it("итог, называющий строительную СРО условием, получает предложение закона; без СРО в итоге — нет", () => {
    const base = parseConsolidationResponse("{}");
    const withSro = finalizeConsolidated(
      { ...base, summary: "Идти можно только при членстве в СРО.", findings: [{ ...sro, sources: [] }] },
      tender,
    );
    expect(withSro.summary).toMatch(/ч\. 2\.1 ст\. 52 ГрК РФ/);
    const noSro = finalizeConsolidated(
      { ...base, summary: "Можно участвовать, главный риск — сроки.", findings: [{ ...sro, sources: [] }] },
      tender,
    );
    expect(noSro.summary).toBe("Можно участвовать, главный риск — сроки.");
  });
});

describe("сумма смет заказчика в запросе", () => {
  it("есть сметы — в запросе сумма по всем файлам и указание сравнивать НМЦК с ней", () => {
    const prompt = buildConsolidationPrompt({ ...tender, estimates: { files: 13, positionsTotal: 91_153_338 } }, []);
    const big = buildConsolidationPrompt({ ...tender, price: 127_363_734.84, estimates: { files: 13, positionsTotal: 91_153_338 } }, []);
    expect(big).toContain("файлов 13, сумма позиций 91153338.00 ₽ без НДС");
    expect(big).toContain("≈ 87 % НМЦК");
    expect(big).toMatch(/«отдельная смета не покрывает НМЦК[^»]*» из входных НЕ включай/);
    const small = buildConsolidationPrompt({ ...tender, price: 127_363_734.84, estimates: { files: 2, positionsTotal: 10_000_000 } }, []);
    expect(small).toContain("заметно меньше НМЦК (≈ 10 %)");
    expect(prompt).toContain("сумма позиций 91153338.00 ₽");
  });

  it("смет нет — строки нет", () => {
    expect(buildConsolidationPrompt({ ...tender, estimates: null }, [])).not.toContain("сметы заказчика (посчитано кодом)");
  });
});

describe("ложное «смета не покрывает НМЦК»", () => {
  const big = { ...tender, price: 127_363_734.84, estimates: { files: 13, positionsTotal: 91_153_338 } };
  const claim = finding({
    title: "Смета не покрывает НМЦК",
    detail: "Смета на 14,5 млн ₽ несопоставима с НМЦК 127,36 млн ₽.",
  });
  const other = finding({ title: "Вывоз мусора в смете с нулевой стоимостью", detail: "Строительный мусор 0,00 ₽." });

  it("сумма смет сопоставима с НМЦК — такой вывод не уходит в запрос и отсеивается из ответа", () => {
    const prompt = buildConsolidationPrompt(big, [
      { document: "Смета_2.xlsx", finding: claim },
      { document: "Смета_2.xlsx", finding: other },
    ]);
    expect(prompt).not.toContain("Смета не покрывает НМЦК");
    expect(prompt).toContain("Вывоз мусора в смете с нулевой стоимостью");

    const final = finalizeConsolidated(
      { ...parseConsolidationResponse("{}"), findings: [{ ...claim, sources: [] }, { ...other, sources: [] }] },
      big,
    );
    expect(final.findings.map((f) => f.title)).toEqual(["Вывоз мусора в смете с нулевой стоимостью"]);
  });

  it("сметы заметно меньше НМЦК или суммы нет — вывод остаётся", () => {
    const small = { ...big, estimates: { files: 2, positionsTotal: 10_000_000 } };
    expect(buildConsolidationPrompt(small, [{ document: "Смета.xlsx", finding: claim }])).toContain("Смета не покрывает НМЦК");
    expect(buildConsolidationPrompt(tender, [{ document: "Смета.xlsx", finding: claim }])).toContain("Смета не покрывает НМЦК");
  });
});

describe("вывод из разбора сметы о НМЦК и поправка итога", () => {
  const big = { ...tender, price: 127_363_734.84, estimates: { files: 13, positionsTotal: 91_153_338 } };

  it("любой вывод о НМЦК только из смет при сопоставимой сумме отсекается, из договора — остаётся", () => {
    const fromEstimate = finding({ title: "Расхождение итога сметы и НМЦК", detail: "Итог 14,4 млн против НМЦК 127,4 млн." });
    const fromContract = finding({ title: "Обеспечение 5 % от НМЦК", detail: "6,37 млн до подписания." });
    const prompt = buildConsolidationPrompt(big, [
      { document: "Смета_2.xlsx", finding: fromEstimate },
      { document: "Проект_договора.DOC", finding: fromContract },
    ]);
    expect(prompt).not.toContain("Расхождение итога сметы и НМЦК");
    expect(prompt).toContain("Обеспечение 5 % от НМЦК");
  });

  it("итог сравнивает смету с НМЦК — дописана доля всех смет; без сравнения — без изменений", () => {
    const base = parseConsolidationResponse("{}");
    const withClaim = finalizeConsolidated({ ...base, summary: "Смета покрывает один объект, а НМЦК 127,4 млн ₽." }, big);
    expect(withClaim.summary).toContain("Все сметы заказчика вместе (13 файлов) — ≈ 87 % НМЦК с НДС");
    const plain = finalizeConsolidated({ ...base, summary: "Главный риск — сроки." }, big);
    expect(plain.summary).toBe("Главный риск — сроки.");
  });
});
