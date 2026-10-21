import { describe, expect, it } from "vitest";

import {
  assembleFit,
  buildFitPrompt,
  factsForFit,
  hasCompanyData,
  keywordMatches,
  MAX_CONTRACTS_IN_PROMPT,
  mergeProfileWithFacts,
  needsModel,
  noCompanyDataFit,
  parseFitResponse,
  readFit,
  ruleLayer,
  type FitTender,
} from "@/domain/companyFacts/fit";
import { emptyFacts, type CompanyFacts, type FactContract } from "@/domain/companyFacts/types";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import type { CompanyProfile, Tender } from "@/domain/entities";
import { demoTenders } from "@/mocks/tenders";
import type { AnalysisFinding } from "@/types/database";

const NOW = new Date("2026-10-21T12:00:00Z");

function tenderWith(patch: { subject?: string; price?: number; region?: string }): Tender {
  const base = demoTenders[0] as Tender;
  return {
    ...base,
    subject: patch.subject ?? "Капитальный ремонт кровли здания школы",
    region: patch.region ?? "Омская область",
    lots: [],
    financial: { ...base.financial, price: patch.price ?? 50_000_000 },
  };
}

const fitTender = (tender: Tender): FitTender => ({ regNumber: "0373100012826000123", subject: tender.subject, region: tender.region, price: tender.financial.price });

function finding(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return { category: "requirement", title: "Требование", detail: "", evidence_quote: "цитата документации", evidence_section: "раздел", severity: "high", ...patch };
}

const EXPERIENCE_20 = finding({
  category: "blocker",
  title: "Опыт выполнения работ",
  requirement_kind: "EXPERIENCE",
  required_value: "опыт исполнения контрактов за последние 3 года на сумму не менее 20% НМЦК",
});
const LICENSE_MCHS = finding({
  category: "blocker",
  title: "Лицензия МЧС",
  requirement_kind: "LICENSE",
  required_value: "лицензия на деятельность по монтажу средств обеспечения пожарной безопасности",
});

function contract(patch: Partial<FactContract> & { id: string }): FactContract {
  return {
    subject: "Капитальный ремонт кровли школы",
    workType: "капитальный ремонт кровли",
    customerType: "municipal",
    customer: "Администрация города Омска",
    year: 2025,
    sumRub: 12_000_000,
    law: "44-FZ",
    region: "Омская область",
    ...patch,
  };
}

function facts(patch: Partial<CompanyFacts> = {}): CompanyFacts {
  return { ...emptyFacts(NOW), ...patch };
}

describe("hasCompanyData", () => {
  it("пустая анкета без фактов — сверять не с чем", () => {
    expect(hasCompanyData(null, null)).toBe(false);
    expect(hasCompanyData(emptyCompanyProfile, facts())).toBe(false);
  });

  it("факты или заполненные допуски дают основание", () => {
    expect(hasCompanyData(null, facts({ regions: ["Омская область"] }))).toBe(true);
    expect(hasCompanyData({ ...emptyCompanyProfile, hasEquipment: true }, null)).toBe(true);
  });
});

describe("mergeProfileWithFacts", () => {
  it("контракты, СРО и лицензии из документов дополняют анкету", () => {
    const merged = mergeProfileWithFacts(
      emptyCompanyProfile,
      facts({
        contracts: [contract({ id: "c1" })],
        sro: [{ id: "s1", kind: "CONSTRUCTION", level: 2, maxContractRub: null, number: null, validUntil: null }],
        licenses: [{ id: "l1", kind: "Лицензия МЧС", issuer: null, number: null, validUntil: null }],
        staff: [{ role: "Инженер ПТО", count: 3, qualification: "НРС" }],
        equipment: [{ name: "Автовышка", count: 1 }],
      }),
    );
    expect(merged.experience).toHaveLength(1);
    expect(merged.experience[0]).toMatchObject({ amount: 12_000_000, completedAt: "2025-06-30" });
    expect(merged.sroMemberships[0]).toMatchObject({ kind: "CONSTRUCTION", responsibilityLevel: 2, confirmed: true });
    expect(merged.licenses[0]).toMatchObject({ kind: "Лицензия МЧС", confirmed: true });
    expect(merged.staff).toMatchObject({ total: 3, nrsCount: 3 });
    expect(merged.hasEquipment).toBe(true);
    expect(merged.legalName).not.toBe("");
  });

  it("контракт с той же суммой, что внесена вручную, второй раз не считается", () => {
    const profile: CompanyProfile = {
      ...emptyCompanyProfile,
      inn: "5503123456",
      experience: [{ id: "e1", subject: "Ремонт", customer: "", contractNumber: "1", amount: 12_000_000, completedAt: "2025-05-01", okpd2Code: null }],
    };
    const merged = mergeProfileWithFacts(profile, facts({ contracts: [contract({ id: "c1" }), contract({ id: "c2", sumRub: 5_000_000 })] }));
    expect(merged.experience.map((item) => item.amount)).toEqual([12_000_000, 5_000_000]);
  });

  it("факты без суммы или года опытом не становятся", () => {
    const merged = mergeProfileWithFacts(null, facts({ contracts: [contract({ id: "c1", sumRub: null }), contract({ id: "c2", year: null })] }));
    expect(merged.experience).toHaveLength(0);
  });
});

describe("слой правил: детерминированные проверки", () => {
  it("опыт ≥ 20 % НМЦК: хватает — «подходит», не хватает — «не подходит»", () => {
    const tender = tenderWith({ price: 50_000_000 });
    const enough = ruleLayer({ tender, findings: [EXPERIENCE_20], profile: null, facts: facts({ contracts: [contract({ id: "c1", sumRub: 8_000_000 }), contract({ id: "c2", sumRub: 4_000_000, year: 2024 })] }), now: NOW });
    expect(enough.requirements.find((item) => item.kind === "EXPERIENCE")).toMatchObject({ verdict: "ok", source: "rule" });

    const lack = ruleLayer({ tender, findings: [EXPERIENCE_20], profile: null, facts: facts({ contracts: [contract({ id: "c1", sumRub: 3_000_000 })] }), now: NOW });
    const row = lack.requirements.find((item) => item.kind === "EXPERIENCE");
    expect(row?.verdict).toBe("fail");
    expect(row?.basis).toMatch(/10\s000\s000/u);
    expect(row?.quote).toBe("цитата документации");
  });

  it("лицензия: есть в документах — «подходит», нет — «не подходит»", () => {
    const tender = tenderWith({});
    const withLicense = ruleLayer({
      tender,
      findings: [LICENSE_MCHS],
      profile: null,
      facts: facts({ licenses: [{ id: "l1", kind: "Лицензия МЧС на монтаж систем пожарной безопасности", issuer: "МЧС России", number: null, validUntil: null }] }),
      now: NOW,
    });
    expect(withLicense.requirements.find((item) => item.kind === "LICENSE")?.verdict).toBe("ok");
    const without = ruleLayer({ tender, findings: [LICENSE_MCHS], profile: null, facts: facts({ regions: ["Омская область"] }), now: NOW });
    expect(without.requirements.find((item) => item.kind === "LICENSE")?.verdict).toBe("fail");
  });

  it("СРО по цене: уровень покрывает — «подходит», предел ниже цены — «не подходит», когда документация о СРО молчит", () => {
    const sroFacts = (level: number) => facts({ sro: [{ id: "s1", kind: "CONSTRUCTION", level, maxContractRub: null, number: null, validUntil: null }] });
    const big = tenderWith({ price: 600_000_000 });
    const covering = ruleLayer({ tender: big, findings: [], profile: null, facts: sroFacts(3), now: NOW });
    expect(covering.requirements.find((item) => item.kind === "SRO_PRICE")).toMatchObject({ verdict: "ok" });
    const low = ruleLayer({ tender: big, findings: [], profile: null, facts: sroFacts(2), now: NOW });
    const row = low.requirements.find((item) => item.kind === "SRO_PRICE");
    expect(row?.verdict).toBe("fail");
    expect(row?.basis).toMatch(/500\s000\s000/u);
  });

  it("строительство до 10 млн ₽ без СРО — допустимо по закону, строки про СРО нет", () => {
    const small = tenderWith({ price: 8_000_000 });
    const result = ruleLayer({ tender: small, findings: [], profile: null, facts: facts({ regions: ["Омская область"] }), now: NOW });
    expect(result.requirements.some((item) => item.kind === "SRO_PRICE")).toBe(false);
  });

  it("нет данных о СРО при крупной закупке — «нужно уточнить», а не «не подходит»", () => {
    const result = ruleLayer({ tender: tenderWith({ price: 60_000_000 }), findings: [], profile: null, facts: facts({ regions: ["Омская область"] }), now: NOW });
    expect(result.requirements.find((item) => item.kind === "SRO_PRICE")?.verdict).toBe("check");
  });

  it("регион: работали — «подходит», нет — «нужно уточнить» (никогда «не подходит»)", () => {
    const here = ruleLayer({ tender: tenderWith({ region: "Омская область" }), findings: [], profile: null, facts: facts({ regions: ["Омская обл."] }), now: NOW });
    expect(here.requirements.find((item) => item.kind === "REGION")?.verdict).toBe("ok");
    const away = ruleLayer({ tender: tenderWith({ region: "Республика Саха (Якутия)" }), findings: [], profile: null, facts: facts({ regions: ["Омская область"] }), now: NOW });
    expect(away.requirements.find((item) => item.kind === "REGION")?.verdict).toBe("check");
  });

  it("типовые декларации и статус МСП в сверку не попадают", () => {
    const result = ruleLayer({
      tender: tenderWith({}),
      findings: [finding({ title: "Не находится в РНП", requirement_kind: "DECLARATION" }), finding({ title: "Только для СМП", requirement_kind: "SMP" })],
      profile: null,
      facts: facts({ regions: ["Омская область"] }),
      now: NOW,
    });
    expect(result.requirements.map((item) => item.kind)).not.toContain("DECLARATION");
    expect(result.requirements.map((item) => item.kind)).not.toContain("SMP");
  });
});

describe("сборка результата: правила + модель", () => {
  const tender = tenderWith({ price: 50_000_000 });
  const company = facts({
    contracts: [contract({ id: "c1", sumRub: 8_000_000 }), contract({ id: "c2", sumRub: 4_000_000, year: 2024, subject: "Ремонт фасада детского сада", workType: "ремонт фасада" })],
    regions: ["Омская область"],
    sro: [{ id: "s1", kind: "CONSTRUCTION", level: 2, maxContractRub: null, number: null, validUntil: null }],
  });
  const equipmentFinding = finding({ category: "requirement", title: "Наличие автовышки", requirement_kind: "EQUIPMENT", required_value: "автовышка не менее 22 м" });

  function assemble(answer: Parameters<typeof assembleFit>[0]["answer"], findings = [EXPERIENCE_20, equipmentFinding]) {
    const rules = ruleLayer({ tender, findings, profile: null, facts: company, now: NOW });
    return { rules, result: assembleFit({ tender: fitTender(tender), rules, facts: company, answer, now: NOW }) };
  }

  it("без модели остаются правила и подбор контрактов по словам", () => {
    const { result } = assemble(null);
    expect(result.llmUsed).toBe(false);
    expect(result.requirements.find((item) => item.kind === "EXPERIENCE")?.verdict).toBe("ok");
    expect(result.requirements.find((item) => item.kind === "EQUIPMENT")?.verdict).toBe("check");
    expect(result.experience[0]?.contractId).toBe("c1");
    expect(result.experience[0]?.why).toMatch(/без оценки модели/u);
    expect(result.overall).toBe("partial");
  });

  it("модель решает «нужно уточнить», но не отменяет вердикт правила с цифрами", () => {
    const rules = ruleLayer({ tender, findings: [EXPERIENCE_20, equipmentFinding], profile: null, facts: facts({ ...company, contracts: [contract({ id: "c1", sumRub: 1_000_000 })] }), now: NOW });
    const equipment = rules.requirements.find((item) => item.kind === "EQUIPMENT");
    const experience = rules.requirements.find((item) => item.kind === "EXPERIENCE");
    expect(experience?.verdict).toBe("fail");
    const result = assembleFit({
      tender: fitTender(tender),
      rules,
      facts: company,
      answer: {
        requirements: [
          { id: equipment?.id ?? "", verdict: "ok", basis: "В фактах есть автовышка 28 м.", contract_ids: [] },
          { id: experience?.id ?? "", verdict: "ok", basis: "Опыта хватает.", contract_ids: ["c1"] },
        ],
        matching_contracts: [],
        gaps: [],
        risks: [],
        summary: "",
      },
      now: NOW,
    });
    expect(result.requirements.find((item) => item.kind === "EQUIPMENT")).toMatchObject({ verdict: "ok", source: "rule+model" });
    expect(result.requirements.find((item) => item.kind === "EXPERIENCE")?.verdict).toBe("fail");
    expect(result.overall).toBe("no_fit");
  });

  it("опыт «подходит» по сумме, но модель не нашла схожих работ — понижение до «нужно уточнить»", () => {
    const { rules } = assemble(null);
    const experience = rules.requirements.find((item) => item.kind === "EXPERIENCE");
    const result = assembleFit({
      tender: fitTender(tender),
      rules,
      facts: company,
      answer: { requirements: [{ id: experience?.id ?? "", verdict: "check", basis: "работ по кровле нет, только фасады", contract_ids: [] }], matching_contracts: [], gaps: [], risks: [], summary: "" },
      now: NOW,
    });
    const row = result.requirements.find((item) => item.kind === "EXPERIENCE");
    expect(row?.verdict).toBe("check");
    expect(row?.basis).toMatch(/по предмету/u);
  });

  it("ссылки модели на несуществующие контракты отбрасываются", () => {
    const { rules } = assemble(null);
    const experience = rules.requirements.find((item) => item.kind === "EXPERIENCE");
    const result = assembleFit({
      tender: fitTender(tender),
      rules,
      facts: company,
      answer: {
        requirements: [{ id: experience?.id ?? "", verdict: "ok", basis: "Подтверждается.", contract_ids: ["c1", "c99"] }],
        matching_contracts: [{ id: "c2", why: "Тоже ремонт" }, { id: "c404", why: "Выдуманный" }, { id: "c2", why: "Дубль" }],
        gaps: [],
        risks: [],
        summary: "Участвовать.",
      },
      now: NOW,
    });
    expect(result.requirements.find((item) => item.kind === "EXPERIENCE")?.contractIds).toEqual(["c1"]);
    expect(result.experience.map((item) => item.contractId)).toEqual(["c2"]);
    expect(result.summary).toBe("Участвовать.");
  });

  it("текст модели очищается от личного ещё раз", () => {
    const { rules } = assemble(null);
    const result = assembleFit({
      tender: fitTender(tender),
      rules,
      facts: company,
      answer: { requirements: [], matching_contracts: [], gaps: ["Позвоните Иванову И. И. +7 913 123-45-67"], risks: ["Контакт ivan@mail.ru"], summary: "Директор Сидоров С. С. подтвердит." },
      now: NOW,
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/Иванов|ivan@|913|Сидоров/u);
  });

  it("итог: ни одного «не подходит» и «уточнить» — «подходит»; нет требований — «unknown»", () => {
    const rules = ruleLayer({ tender, findings: [EXPERIENCE_20], profile: null, facts: company, now: NOW });
    const result = assembleFit({ tender: fitTender(tender), rules, facts: company, answer: null, now: NOW });
    expect(result.overall).toBe("fit");
    const none = ruleLayer({ tender: tenderWith({ price: 5_000_000, subject: "Поставка бумаги" }), findings: [], profile: null, facts: facts({ regions: ["Томская область"], equipment: [{ name: "Кран", count: 1 }] }), now: NOW });
    const empty = assembleFit({ tender: fitTender(tender), rules: { ...none, requirements: [] }, facts: company, answer: null, now: NOW });
    expect(empty.overall).toBe("unknown");
  });

  it("чего не хватает собирается из непройденных требований", () => {
    const { result } = assemble(null);
    expect(result.gaps.some((item) => item.startsWith("Наличие автовышки"))).toBe(true);
  });
});

describe("запрос к модели: что уходит и чего не уходит", () => {
  const tender = tenderWith({});
  const company = facts({
    sourceDocuments: ["Резюме Иванов Иван Иванович.pdf"],
    scrubStats: { fio: 7, phone: 3, email: 0, passport: 0, snils: 0, personalInn: 0, birthDate: 0, address: 0 },
    contracts: Array.from({ length: MAX_CONTRACTS_IN_PROMPT + 20 }, (_, i) => contract({ id: `c${String(i + 1)}`, year: 2000 + (i % 26), sumRub: 1_000_000 + i })),
    prices: [{ id: "p1", name: "Секретная цена материала", unit: "м2", priceRub: 123_456, code: null, kind: "material", vat: "unknown" }],
    notes: ["Работаем по всей Сибири"],
    regions: ["Омская область"],
  });

  it("факты для модели: без источников, счётчиков скрытого и цен", () => {
    const text = JSON.stringify(factsForFit(company));
    expect(text).not.toContain("Резюме");
    expect(text).not.toContain("Иванов");
    expect(text).not.toContain("Секретная цена");
    expect(text).not.toContain("scrub");
    expect(text).toContain("Работаем по всей Сибири");
  });

  it("контрактов в запросе не больше предела, свежие первыми", () => {
    const sent = (factsForFit(company)["contracts"] as { year: number }[]);
    expect(sent).toHaveLength(MAX_CONTRACTS_IN_PROMPT);
    expect(sent[0]?.year).toBeGreaterThanOrEqual(sent[sent.length - 1]?.year ?? 0);
  });

  it("в список к модели идут только требования, которые правила не решили, и опыт", () => {
    const rules = ruleLayer({ tender, findings: [EXPERIENCE_20, LICENSE_MCHS, finding({ title: "Наличие автовышки", requirement_kind: "EQUIPMENT", required_value: "автовышка" })], profile: null, facts: company, now: NOW });
    const asked = rules.requirements.filter(needsModel).map((item) => item.kind);
    expect(asked).toContain("EXPERIENCE");
    expect(asked).toContain("EQUIPMENT");
    expect(asked).not.toContain("LICENSE");
    expect(asked).not.toContain("REGION");
    const prompt = buildFitPrompt({ tender: fitTender(tender), requirements: rules.requirements, facts: company });
    expect(prompt).toContain("ТОЛЬКО JSON");
    expect(prompt).toContain(tender.subject);
    expect(prompt).not.toContain("Резюме");
    expect(prompt).not.toContain("Секретная цена");
  });
});

describe("подбор по словам и разбор ответа", () => {
  it("контракты по теме закупки находятся по общим словам предмета", () => {
    const company = facts({
      contracts: [
        contract({ id: "c1", subject: "Капитальный ремонт кровли школы" }),
        contract({ id: "c2", subject: "Поставка мебели", workType: null }),
        contract({ id: "c3", subject: "Ремонт кровли детского сада", year: 2024 }),
      ],
    });
    const result = keywordMatches("Капитальный ремонт кровли гимназии", company);
    expect(result.map((item) => item.contractId)).toEqual(["c1", "c3"]);
  });

  it("parseFitResponse терпит оговорки модели и мусор в полях", () => {
    const answer = parseFitResponse('```json\n{"requirements":[{"id":"r1","verdict":"maybe","basis":5}],"summary":"Ок"}\n```\nПояснение.');
    expect(answer.requirements[0]).toMatchObject({ id: "r1", verdict: "check" });
    expect(answer.summary).toBe("Ок");
    expect(() => parseFitResponse("[]")).toThrow();
  });

  it("сохранённый результат читается; чужая версия — нет", () => {
    const stored = noCompanyDataFit("T1", NOW);
    expect(readFit(JSON.parse(JSON.stringify(stored)))?.hasCompanyData).toBe(false);
    expect(readFit({ ...stored, version: 99 })).toBeNull();
    expect(readFit(null)).toBeNull();
  });
});
