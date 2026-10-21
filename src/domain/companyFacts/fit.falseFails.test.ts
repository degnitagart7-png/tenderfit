import { describe, expect, it } from "vitest";

import { assembleFit, ruleLayer, saysMissing, type CompanyFitResult, type FitModelAnswer, type FitTender } from "@/domain/companyFacts/fit";
import { confidentHeadcount, evaluatePersonnel, evaluateSecurity, inScope, MAX_SHOWN_REQUIREMENTS } from "@/domain/companyFacts/fitRules";
import { guessDocumentCategory } from "@/domain/companyFacts/guessCategory";
import { parseFactsResponse } from "@/domain/companyFacts/schema";
import { emptyFacts, type CompanyFacts, type FactContract } from "@/domain/companyFacts/types";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import type { CompanyProfile, Tender } from "@/domain/entities";
import { demoTenders } from "@/mocks/tenders";
import type { AnalysisFinding } from "@/types/database";

/**
 * Ложные «не подходит» живой проверки на трёх закупках (21.10.2026) и всё, что к ним относится: обеспечение, кадры,
 * шум обязанностей исполнителя, противоречие «подходит / опыта нет», расхождение анкеты и документов, заголовок.
 */

const NOW = new Date("2026-10-21T12:00:00Z");

function tenderWith(patch: { subject?: string; price?: number; region?: string; law?: Tender["law"] } = {}): Tender {
  const base = demoTenders[0] as Tender;
  return {
    ...base,
    law: patch.law ?? "FZ_44",
    subject: patch.subject ?? "Капитальный ремонт кровли здания школы",
    region: patch.region ?? "Омская область",
    lots: [],
    financial: { ...base.financial, price: patch.price ?? 50_000_000 },
  };
}
const fitTender = (tender: Tender): FitTender => ({ regNumber: "32616457847", subject: tender.subject, region: tender.region, price: tender.financial.price });

function finding(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return { category: "requirement", title: "Требование", detail: "", evidence_quote: "цитата", evidence_section: "раздел", severity: "high", ...patch };
}

function facts(patch: Partial<CompanyFacts> = {}): CompanyFacts {
  return { ...emptyFacts(NOW), regions: ["Омская область"], ...patch };
}

function contract(id: string, subject: string, patch: Partial<FactContract> = {}): FactContract {
  return { id, subject, workType: null, customerType: "municipal", customer: null, year: 2025, sumRub: 12_000_000, law: "44-FZ", region: "Омская область", ...patch };
}

const rules = (findings: AnalysisFinding[], company: CompanyFacts | null, options: { tender?: Tender; profile?: CompanyProfile | null } = {}) =>
  ruleLayer({ tender: options.tender ?? tenderWith(), findings, profile: options.profile ?? null, facts: company, now: NOW });

const rowOf = (layer: ReturnType<typeof ruleLayer>, kind: string) => layer.requirements.filter((item) => item.kind === kind);

describe("A. обеспечение — не допуск", () => {
  const performance = finding({
    category: "requirement",
    title: "Обеспечение исполнения договора",
    requirement_kind: "SECURITY",
    required_value: "10 % от цены договора",
    detail: "Победитель предоставляет обеспечение исполнения договора.",
  });

  it("обеспечение исполнения: не «не подходит» и не про спецсчёт — банковская гарантия или деньги, с суммой", () => {
    const layer = rules([performance], facts());
    const [row] = rowOf(layer, "SECURITY");
    expect(row?.verdict).toBe("ok");
    expect(row?.basis).toMatch(/банковской гарантией или деньгами/u);
    expect(row?.basis).toMatch(/5\s000\s000/u);
    expect(row?.basis).not.toMatch(/спецсч|специальный счёт открыт|не отмечен/iu);
  });

  it("обеспечение заявки по 44-ФЗ: спецсчёта нет — «нужно уточнить: спецсчёт или банковская гарантия», есть — «подходит»", () => {
    const application = finding({ title: "Обеспечение заявки", requirement_kind: "SECURITY", required_value: "1 % от НМЦК", detail: "Электронный аукцион." });
    const without = rowOf(rules([application], facts()), "SECURITY")[0];
    expect(without?.verdict).toBe("check");
    expect(without?.basis).toMatch(/специальный счёт.*банковская гарантия/u);
    const withAccount = rowOf(rules([application], facts(), { profile: { ...emptyCompanyProfile, hasSpecialAccount: true } }), "SECURITY")[0];
    expect(withAccount?.verdict).toBe("ok");
    expect(withAccount?.basis).toMatch(/специальный счёт открыт/u);
  });

  it("223-ФЗ: спецсчёта нет, пока документация сама его не требует", () => {
    const application = finding({ title: "Обеспечение заявки", requirement_kind: "SECURITY", required_value: "2 %", detail: "Перечисление на счёт заказчика." });
    const plain = rowOf(rules([application], facts(), { tender: tenderWith({ law: "FZ_223" }) }), "SECURITY")[0];
    expect(plain?.verdict).toBe("ok");
    expect(plain?.basis).not.toMatch(/спецсч|специальн/iu);
    const demanded = finding({ title: "Обеспечение заявки", requirement_kind: "SECURITY", required_value: "2 %", detail: "Деньги вносятся на специальный банковский счёт участника." });
    expect(rowOf(rules([demanded], facts(), { tender: tenderWith({ law: "FZ_223" }) }), "SECURITY")[0]?.verdict).toBe("check");
  });

  it("обеспечение никогда не «не подходит»", () => {
    for (const law of ["FZ_44", "FZ_223", "COMMERCIAL"] as const) {
      for (const title of ["Обеспечение заявки", "Обеспечение исполнения договора", "Обеспечение"]) {
        const result = evaluateSecurity({ title, detail: "", required: "5 %", law, price: 10_000_000, hasSpecialAccount: false });
        expect(result.verdict).not.toBe("fail");
      }
    }
  });

  it("два одинаковых обеспечения — одна строка", () => {
    const a = finding({ title: "Обеспечение исполнения договора", requirement_kind: "SECURITY", required_value: "10 % от цены договора" });
    const b = finding({ title: "Размер обеспечения исполнения контракта", requirement_kind: "SECURITY", required_value: "10%", detail: "Из проекта контракта." });
    expect(rowOf(rules([a, b], facts()), "SECURITY")).toHaveLength(1);
    const other = finding({ title: "Обеспечение заявки", requirement_kind: "SECURITY", required_value: "1 %" });
    expect(rowOf(rules([a, b, other], facts()), "SECURITY")).toHaveLength(2);
  });
});

describe("B. кадры: «не подходит» только по уверенно прочитанной численности", () => {
  const electrical = finding({
    category: "blocker",
    title: "Персонал с допуском по электробезопасности",
    requirement_kind: "QUALIFIED_PERSONNEL",
    required_value: "работники с группой по электробезопасности, работы на оборудовании до 1000 В",
    detail: "Работники, выполняющие работы на электроустановках до 1000 В, должны иметь группу не ниже III.",
  });
  const roles = [
    { role: "Прораб", count: 3, qualification: null },
    { role: "Электромонтажник", count: 10, qualification: "группа III" },
    { role: "Рабочий", count: 10, qualification: null },
  ];

  it("«до 1000 В» не численность: штат 32 по документам — не fail", () => {
    expect(confidentHeadcount("работы на оборудовании до 1000 В, не менее 3 лет стажа")).toBeNull();
    const layer = rules([electrical], facts({ staff: roles, staffTotal: 32 }));
    const row = rowOf(layer, "QUALIFIED_PERSONNEL")[0];
    expect(row?.verdict).toBe("check");
    expect(row?.basis).not.toMatch(/1000/u);
  });

  it("точный случай из проверки: штат 23 (сумма ролей) при «до 1000 В» — не «не подходит»", () => {
    const layer = rules([electrical], facts({ staff: [{ role: "Работники", count: 23, qualification: null }] }));
    expect(rowOf(layer, "QUALIFIED_PERSONNEL")[0]?.verdict).not.toBe("fail");
  });

  it("число рядом с единицей не численность", () => {
    for (const text of ["не менее 5 лет", "до 1000 В включительно", "не менее 30 %", "площадью не менее 100 м2", "массой не менее 10 т", "стоимостью не менее 5 млн ₽"]) {
      expect(confidentHeadcount(text), text).toBeNull();
    }
  });

  it("число при слове о людях — численность", () => {
    expect(confidentHeadcount("в штате участника не менее 11 человек")).toBe(11);
    expect(confidentHeadcount("не менее 5 квалифицированных специалистов")).toBe(5);
    expect(confidentHeadcount("численность работников не менее 40")).toBe(40);
    expect(confidentHeadcount("не менее 3 (трёх) сотрудников")).toBe(3);
  });

  it("уверенная численность больше заявленного штата — «не подходит»; хватает — «подходит»", () => {
    const need1000 = finding({ title: "Численность персонала", requirement_kind: "QUALIFIED_PERSONNEL", required_value: "в штате не менее 1000 человек" });
    expect(rowOf(rules([need1000], facts({ staffTotal: 32 })), "QUALIFIED_PERSONNEL")[0]?.verdict).toBe("fail");
    const need20 = finding({ title: "Численность персонала", requirement_kind: "QUALIFIED_PERSONNEL", required_value: "в штате не менее 20 человек" });
    expect(rowOf(rules([need20], facts({ staffTotal: 32 })), "QUALIFIED_PERSONNEL")[0]?.verdict).toBe("ok");
  });

  it("только сумма по ролям: может подтвердить, но отказать по ней нельзя", () => {
    const need30 = finding({ title: "Численность", requirement_kind: "QUALIFIED_PERSONNEL", required_value: "в штате не менее 30 человек" });
    const lowerBound = rowOf(rules([need30], facts({ staff: [{ role: "Работники", count: 23, qualification: null }] })), "QUALIFIED_PERSONNEL")[0];
    expect(lowerBound?.verdict).toBe("check");
    expect(lowerBound?.basis).toMatch(/общий штат в документах не указан/iu);
    const need10 = finding({ title: "Численность", requirement_kind: "QUALIFIED_PERSONNEL", required_value: "в штате не менее 10 человек" });
    expect(rowOf(rules([need10], facts({ staff: [{ role: "Работники", count: 23, qualification: null }] })), "QUALIFIED_PERSONNEL")[0]?.verdict).toBe("ok");
  });

  it("численность подходит, но нужна квалификация — «нужно уточнить»", () => {
    const result = evaluatePersonnel({ text: "в штате не менее 5 человек с допуском по электробезопасности", facts: facts({ staffTotal: 32 }), profileStaffTotal: null, nrsCount: 0, noprizCount: 0 });
    expect(result.verdict).toBe("check");
  });

  it("НРС: специалисты есть, но меньше — «не подходит»; данных нет — «уточнить»", () => {
    const text = "не менее 2 специалистов в НРС";
    expect(evaluatePersonnel({ text, facts: null, profileStaffTotal: null, nrsCount: 1, noprizCount: 0 }).verdict).toBe("fail");
    expect(evaluatePersonnel({ text, facts: null, profileStaffTotal: null, nrsCount: 0, noprizCount: 0 }).verdict).toBe("check");
    expect(evaluatePersonnel({ text, facts: null, profileStaffTotal: null, nrsCount: 3, noprizCount: 0 }).verdict).toBe("ok");
  });

  it("анкета и документы расходятся — берётся документ, с короткой пометкой", () => {
    const need = finding({ title: "Численность", requirement_kind: "QUALIFIED_PERSONNEL", required_value: "в штате не менее 20 человек" });
    const profile: CompanyProfile = { ...emptyCompanyProfile, inn: "5503123456", legalName: "ООО", staff: { total: 12, nrsCount: 0, noprizCount: 0 } };
    const row = rowOf(rules([need], facts({ staffTotal: 32 }), { profile }), "QUALIFIED_PERSONNEL")[0];
    expect(row?.verdict).toBe("ok");
    expect(row?.basis).toContain("в анкете 12, в документах 32");
    // Нулевое/пустое поле анкеты заменяется документом, а при уверенно меньшем штате — «не подходит» по документному значению.
    const small = finding({ title: "Численность", requirement_kind: "QUALIFIED_PERSONNEL", required_value: "в штате не менее 50 человек" });
    const failing = rowOf(rules([small], facts({ staffTotal: 32 }), { profile }), "QUALIFIED_PERSONNEL")[0];
    expect(failing?.verdict).toBe("fail");
    expect(failing?.basis).toMatch(/штат 32/iu);
  });
});

describe("C. что показывать: только требования к участнику", () => {
  const noise = [
    finding({ title: "Сертификаты и паспорта на материалы", requirement_kind: "OTHER" }),
    finding({ title: "Новые материалы с сертификатами", requirement_kind: "OTHER" }),
    finding({ title: "Упаковка и вывоз мусора", requirement_kind: "OTHER" }),
    finding({ title: "Согласие работников на обработку персональных данных", requirement_kind: "OTHER" }),
    finding({ title: "Список лиц и транспортных средств", requirement_kind: "QUALIFIED_PERSONNEL" }),
    finding({ title: "СИЗ и инструмент", requirement_kind: "EQUIPMENT" }),
    finding({ title: "Предложение о цене контракта", requirement_kind: "OTHER" }),
    finding({ title: "Ключевые приложения не приложены", requirement_kind: "OTHER" }),
  ];

  it("обязанности исполнителя и канцелярия не попадают в сверку", () => {
    const layer = rules(noise, facts());
    expect(layer.requirements.filter((item) => item.kind !== "REGION" && item.kind !== "SRO_PRICE")).toHaveLength(0);
  });

  it("«Прочее» — только критерии оценки с баллами и сроки", () => {
    expect(inScope("OTHER", "Критерий оценки: опыт, 40 баллов")).toBe(true);
    expect(inScope("OTHER", "Срок выполнения работ — 30 дней, невыполним")).toBe(true);
    expect(inScope("OTHER", "Заказчик вправе проверять качество")).toBe(false);
    expect(inScope("SRO", "Членство в СРО")).toBe(true);
    expect(inScope("LICENSE", "Лицензия, сертификат соответствия")).toBe(true);
    expect(inScope("EXPERIENCE", "Сертификаты подтверждают опыт")).toBe(true);
  });

  it("допуск и квалификация остаются; «в списке лиц» техника без признака участника — нет", () => {
    expect(inScope("EQUIPMENT", "Наличие автовышки у участника, подтверждается копиями документов")).toBe(true);
    expect(inScope("EQUIPMENT", "Складирование материалов на площадке")).toBe(false);
  });

  it("не больше восьми, порядок: не подходит → нужно уточнить → подходит", () => {
    const many: AnalysisFinding[] = [
      ...Array.from({ length: 6 }, (_, i) => finding({ title: `Лицензия вида ${String(i)}`, requirement_kind: "LICENSE", category: "blocker", required_value: `лицензия ФСБ вид ${String(i)}` })),
      finding({ title: "Опыт", requirement_kind: "EXPERIENCE", required_value: "опыт на сумму не менее 20% НМЦК", category: "blocker" }),
      finding({ title: "Обеспечение исполнения договора", requirement_kind: "SECURITY", required_value: "5 %" }),
      finding({ title: "Наличие автовышки у участника", requirement_kind: "EQUIPMENT", required_value: "автовышка" }),
      finding({ title: "Обеспечение заявки", requirement_kind: "SECURITY", required_value: "1 %" }),
    ];
    const layer = rules(many, facts({ licenses: [{ id: "l1", kind: "Лицензия МЧС", issuer: null, number: null, validUntil: null }], contracts: [contract("c1", "Капитальный ремонт кровли школы", { sumRub: 20_000_000 })] }));
    expect(layer.requirements.length).toBeLessThanOrEqual(MAX_SHOWN_REQUIREMENTS);
    const order = layer.requirements.map((item) => item.verdict);
    const rank = { fail: 0, check: 1, ok: 2 } as const;
    expect(order.map((v) => rank[v])).toEqual([...order.map((v) => rank[v])].sort((a, b) => a - b));
  });
});

describe("D. «подходит» по опыту — только с подтверждающим контрактом", () => {
  const tender = tenderWith({ subject: "Капитальный ремонт кровли здания школы", price: 50_000_000 });
  const experience = finding({ category: "requirement", title: "Опыт по дверным блокам и подвесным потолкам", requirement_kind: "EXPERIENCE", required_value: "опыт исполнения контрактов за последние 3 года на сумму не менее 20% НМЦК" });
  const company = facts({ contracts: [contract("c1", "Капитальный ремонт кровли школы", { sumRub: 14_000_000 })] });

  function build(answer: Partial<FitModelAnswer["requirements"][number]> | null, base: CompanyFacts = company, findings: AnalysisFinding[] = [experience]): CompanyFitResult {
    const layer = rules(findings, base, { tender });
    const id = layer.requirements.find((item) => item.kind === "EXPERIENCE")?.id ?? "";
    const modelAnswer: FitModelAnswer | null =
      answer === null ? null : { requirements: [{ id, verdict: "ok", basis: "", contract_ids: [], ...answer }], matching_contracts: [], gaps: [], risks: [], summary: "" };
    return assembleFit({ tender: fitTender(tender), rules: layer, facts: base, answer: modelAnswer, now: NOW });
  }
  const answerFor = (patch: Partial<FitModelAnswer["requirements"][number]>) => patch;

  it("точный случай из проверки: вердикт ok, а в основании «опыта нет» — выходит «нужно уточнить»", () => {
    expect(saysMissing("по дверным блокам и подвесным потолкам опыта нет")).toBe(true);
    const result = build(answerFor({ verdict: "ok", basis: "по дверным блокам и подвесным потолкам опыта нет", contract_ids: ["c1"] }));
    const row = result.requirements.find((item) => item.kind === "EXPERIENCE");
    expect(row?.verdict).toBe("check");
    expect(row?.basis).not.toMatch(/Опыт по профилю покрывает требование\. Но по предмету/u);
    expect(row?.basis.split(/(?<=[.!?])\s+/u)).toHaveLength(1);
  });

  it("ok с подтверждающим контрактом — одна ясная фраза", () => {
    const result = build(answerFor({ verdict: "ok", basis: "Кровля школы на 14 млн ₽ в 2025 году.", contract_ids: ["c1"] }));
    const row = result.requirements.find((item) => item.kind === "EXPERIENCE");
    expect(row?.verdict).toBe("ok");
    expect(row?.contractIds).toEqual(["c1"]);
    expect(row?.basis).toBe("По сумме требование выполнено; по предмету: Кровля школы на 14 млн ₽ в 2025 году.");
  });

  it("ok без контракта и без слов предмета в документах — «нужно уточнить»", () => {
    const base = facts({ contracts: [contract("c1", "Поставка мебели", { sumRub: 14_000_000 })] });
    const result = build(answerFor({ verdict: "ok", basis: "Подтверждается.", contract_ids: [] }), base);
    expect(result.requirements.find((item) => item.kind === "EXPERIENCE")?.verdict).toBe("check");
  });

  it("модель не вызывалась: контракт по словам предмета — «подходит», иначе «уточнить»", () => {
    expect(build(null).requirements.find((item) => item.kind === "EXPERIENCE")).toMatchObject({ verdict: "ok", contractIds: ["c1"] });
    const base = facts({ contracts: [contract("c1", "Поставка мебели", { sumRub: 14_000_000 })] });
    expect(build(null, base).requirements.find((item) => item.kind === "EXPERIENCE")?.verdict).toBe("check");
  });

  it("допуск и модель говорит «схожих работ нет» (fail) — «не подходит»; не допуск — «нужно уточнить»", () => {
    const admission = finding({ category: "blocker", title: "Опыт", requirement_kind: "EXPERIENCE", required_value: "опыт на сумму не менее 20% НМЦК" });
    const failing = build(answerFor({ verdict: "fail", basis: "ремонтов фасадов нет" }), company, [admission]);
    expect(failing.requirements.find((item) => item.kind === "EXPERIENCE")?.verdict).toBe("fail");
    const soft = build(answerFor({ verdict: "fail", basis: "ремонтов фасадов нет" }));
    expect(soft.requirements.find((item) => item.kind === "EXPERIENCE")?.verdict).toBe("check");
  });

  it("skip от модели убирает обязанность исполнителя, но не правило с цифрами", () => {
    const equipment = finding({ title: "Наличие автовышки у участника", requirement_kind: "EQUIPMENT", required_value: "автовышка" });
    const layer = rules([equipment, experience], company, { tender });
    const id = layer.requirements.find((item) => item.kind === "EQUIPMENT")?.id ?? "";
    const experienceId = layer.requirements.find((item) => item.kind === "EXPERIENCE")?.id ?? "";
    const result = assembleFit({
      tender: fitTender(tender),
      rules: layer,
      facts: company,
      answer: { requirements: [{ id, verdict: "check", basis: "", contract_ids: [], skip: true }, { id: experienceId, verdict: "ok", basis: "", contract_ids: [], skip: true }], matching_contracts: [], gaps: [], risks: [], summary: "" },
      now: NOW,
    });
    expect(result.requirements.some((item) => item.kind === "EQUIPMENT")).toBe(false);
    expect(result.requirements.some((item) => item.kind === "EXPERIENCE")).toBe(true);
  });
});

describe("E. анкета и документы", () => {
  it("регион: объединение регионов анкеты и документов", () => {
    const profile: CompanyProfile = { ...emptyCompanyProfile, inn: "5503123456", restrictions: { ...emptyCompanyProfile.restrictions, workRegions: ["Томская область"] } };
    const company = facts({ regions: ["Омская область"], contracts: [contract("c1", "Ремонт", { region: "Новосибирская область" })] });
    for (const region of ["Томская область", "Омская область", "Новосибирская область"]) {
      const layer = rules([], company, { tender: tenderWith({ region }), profile });
      expect(rowOf(layer, "REGION")[0]?.verdict, region).toBe("ok");
    }
    expect(rowOf(rules([], company, { tender: tenderWith({ region: "Якутия" }), profile }), "REGION")[0]?.verdict).toBe("check");
  });

  it("нулевые поля анкеты заменяются документами", () => {
    const layer = rules([], facts({ staffTotal: 32, staff: [{ role: "Инженер ПТО", count: 3, qualification: "НРС" }] }));
    expect(layer.profile.staff.total).toBe(32);
    expect(layer.profile.staff.nrsCount).toBe(3);
  });
});

describe("F. заголовок", () => {
  const tender = tenderWith({ price: 600_000_000 });
  it("нет допуска СРО нужного уровня — «Не подходит: …» поимённо", () => {
    const company = facts({ sro: [{ id: "s1", kind: "CONSTRUCTION", level: 2, maxContractRub: null, number: null, validUntil: null }] });
    const layer = rules([], company, { tender });
    const result = assembleFit({ tender: fitTender(tender), rules: layer, facts: company, answer: null, now: NOW });
    expect(result.overall).toBe("no_fit");
    expect(result.headline).toMatch(/^Не подходит: Допуск СРО/u);
  });

  it("только пункты «уточнить» — «Подходит, 2 пункта нужно уточнить»", () => {
    const company = facts({ sro: [{ id: "s1", kind: "CONSTRUCTION", level: 3, maxContractRub: null, number: null, validUntil: null }] });
    const findings = [
      finding({ title: "Наличие автовышки у участника", requirement_kind: "EQUIPMENT", required_value: "автовышка" }),
      finding({ title: "Обеспечение заявки", requirement_kind: "SECURITY", required_value: "1 %" }),
    ];
    const layer = rules(findings, company, { tender });
    const result = assembleFit({ tender: fitTender(tender), rules: layer, facts: company, answer: null, now: NOW });
    expect(result.overall).toBe("partial");
    expect(result.headline).toBe("Подходит, 2 пункта нужно уточнить");
  });

  it("ложные отказы (обеспечение, «до 1000 В») заголовок «Не подходит» не дают", () => {
    const findings = [
      finding({ title: "Обеспечение исполнения договора", requirement_kind: "SECURITY", required_value: "10 %" }),
      finding({ category: "blocker", title: "Допуск по электробезопасности", requirement_kind: "QUALIFIED_PERSONNEL", required_value: "работы до 1000 В, штат 1000 не требуется" }),
    ];
    const company = facts({ staffTotal: 32, sro: [{ id: "s1", kind: "CONSTRUCTION", level: 3, maxContractRub: null, number: null, validUntil: null }] });
    const result = assembleFit({ tender: fitTender(tenderWith()), rules: rules(findings, company), facts: company, answer: null, now: NOW });
    expect(result.overall).not.toBe("no_fit");
    expect(result.headline).not.toMatch(/^Не подходит/u);
  });
});

describe("G. виды работ и категории документов", () => {
  it("близкие виды работ сливаются: «ремонт кровли» и «капитальный ремонт кровли»", () => {
    const { body } = parseFactsResponse(
      JSON.stringify({
        work_types: [
          { name: "ремонт кровли", contracts_count: 3, total_sum_rub: 10_000_000, years: [2023] },
          { name: "Капитальный ремонт кровли", contracts_count: 2, total_sum_rub: 30_000_000, years: [2024], largest_contract_rub: 21_000_000 },
          { name: "Устройство сетей водоснабжения", contracts_count: 1, total_sum_rub: 1_000_000 },
        ],
      }),
      { now: NOW },
    );
    expect(body.workTypes).toHaveLength(2);
    expect(body.workTypes[0]).toMatchObject({ name: "ремонт кровли (в т.ч. капитальный)", contractsCount: 3, totalSumRub: 30_000_000, years: [2023, 2024], largestContractRub: 21_000_000 });
  });

  it("одинаковые и единственные названия не переименовываются", () => {
    const { body } = parseFactsResponse(JSON.stringify({ work_types: [{ name: "Капитальный ремонт кровли", contracts_count: 1 }, { name: "капитальный ремонт кровли", contracts_count: 2 }] }), { now: NOW });
    expect(body.workTypes).toHaveLength(1);
    expect(body.workTypes[0]?.name).toBe("Капитальный ремонт кровли");
  });

  it("штат целиком читается из ответа модели и из сохранённых фактов", () => {
    expect(parseFactsResponse(JSON.stringify({ staff_total: "32" }), { now: NOW }).body.staffTotal).toBe(32);
    expect(parseFactsResponse(JSON.stringify({ staff_total: null }), { now: NOW }).body.staffTotal).toBeNull();
    expect(parseFactsResponse(JSON.stringify({ staff_total: -5 }), { now: NOW }).body.staffTotal).toBeNull();
  });

  it("категория по названию файла", () => {
    const cases: [string, string][] = [
      ["Прайс 2026.xlsx", "price"],
      ["price_list.csv", "price"],
      ["Реестр контрактов 44-ФЗ.pdf", "experience"],
      ["Акт КС-2 № 5.pdf", "experience"],
      ["Договор подряда.docx", "experience"],
      ["СРО выписка.pdf", "sro"],
      ["Свидетельство о допуске.pdf", "sro"],
      ["Лицензия МЧС.pdf", "license"],
      ["Штатное расписание.xlsx", "staff"],
      ["Кадры.docx", "staff"],
      ["Список техники.xlsx", "equipment"],
      ["Баланс 2025.pdf", "financial"],
      ["Презентация.pdf", "other"],
    ];
    for (const [name, category] of cases) expect(guessDocumentCategory(name), name).toBe(category);
  });
});
