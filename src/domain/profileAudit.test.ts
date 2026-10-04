import { describe, expect, it } from "vitest";
import type { CompanyProfile, SroMembership } from "@/domain/entities";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { auditCompanyProfile, type ProfileIssueKind } from "@/domain/profileAudit";

const NOW = new Date("2026-09-22T12:00:00+03:00");

/** Допуск СРО строителя первого уровня: лимит 90 млн ₽ по ст. 55.16 ГрК РФ. */
function constructionSro(patch: Partial<SroMembership> = {}): SroMembership {
  return {
    id: "sro-1",
    kind: "CONSTRUCTION",
    type: "Строительство, реконструкция, капитальный ремонт",
    number: "СРО-С-000-000000",
    responsibilityLevel: 1,
    maxContractAmount: null,
    validUntil: null,
    confirmed: true,
    ...patch,
  };
}

function profile(patch: Partial<CompanyProfile> = {}): CompanyProfile {
  return { ...demoCompanyProfile, ...patch };
}

function kinds(issues: { kind: ProfileIssueKind }[]): ProfileIssueKind[] {
  return issues.map((i) => i.kind);
}

describe("auditCompanyProfile — лимит цены против допуска СРО", () => {
  it("лимит цены ниже допуска СРО — предупреждение с обоими числами", () => {
    const issues = auditCompanyProfile(
      profile({
        sroMemberships: [constructionSro()],
        restrictions: { ...demoCompanyProfile.restrictions, maxPrice: 5_000_000 },
      }),
      NOW,
    );
    const issue = issues.find((i) => i.kind === "priceLimitBelowSro");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("90");
    expect(issue?.detail).toContain("5");
  });

  it("лимит цены не ниже допуска СРО — предупреждения нет", () => {
    const issues = auditCompanyProfile(
      profile({
        sroMemberships: [constructionSro()],
        restrictions: { ...demoCompanyProfile.restrictions, maxPrice: 90_000_000 },
      }),
      NOW,
    );
    expect(kinds(issues)).not.toContain("priceLimitBelowSro");
  });

  it("без допусков СРО лимит цены не проверяется", () => {
    const issues = auditCompanyProfile(
      profile({
        sroMemberships: [],
        restrictions: { ...demoCompanyProfile.restrictions, maxPrice: 5_000_000 },
      }),
      NOW,
    );
    expect(kinds(issues)).not.toContain("priceLimitBelowSro");
  });

  it("просроченный допуск СРО не поднимает лимит цены", () => {
    const issues = auditCompanyProfile(
      profile({
        sroMemberships: [constructionSro({ validUntil: "2025-12-31" })],
        restrictions: { ...demoCompanyProfile.restrictions, maxPrice: 5_000_000 },
      }),
      NOW,
    );
    expect(kinds(issues)).not.toContain("priceLimitBelowSro");
  });

  it("неподтверждённый допуск СРО не поднимает лимит цены", () => {
    const issues = auditCompanyProfile(
      profile({
        sroMemberships: [constructionSro({ confirmed: false })],
        restrictions: { ...demoCompanyProfile.restrictions, maxPrice: 5_000_000 },
      }),
      NOW,
    );
    expect(kinds(issues)).not.toContain("priceLimitBelowSro");
  });

  it("допуск без ограничения стоимости не конфликтует с лимитом цены", () => {
    const issues = auditCompanyProfile(
      profile({
        sroMemberships: [constructionSro({ maxContractAmount: null, responsibilityLevel: null })],
        restrictions: { ...demoCompanyProfile.restrictions, maxPrice: 5_000_000 },
      }),
      NOW,
    );
    expect(kinds(issues)).not.toContain("priceLimitBelowSro");
  });
});

describe("auditCompanyProfile — стоп-слова против собственных возможностей", () => {
  it("стоп-слово, входящее в собственный вид работ, — предупреждение", () => {
    const issues = auditCompanyProfile(
      profile({
        capabilities: {
          ...demoCompanyProfile.capabilities,
          works: ["Строительство объектов капитального строительства"],
          stopWords: ["строительство"],
        },
      }),
      NOW,
    );
    const issue = issues.find((i) => i.kind === "stopWordContradictsCapabilities");
    expect(issue?.values).toContain("строительство");
  });

  it("стоп-слово, совпадающее с ключевым словом, — предупреждение", () => {
    const issues = auditCompanyProfile(
      profile({
        capabilities: {
          ...demoCompanyProfile.capabilities,
          keywords: ["ноутбук"],
          products: [],
          works: [],
          services: [],
          synonyms: [],
          stopWords: ["ноутбук"],
        },
      }),
      NOW,
    );
    expect(kinds(issues)).toContain("stopWordContradictsCapabilities");
  });

  it("стоп-слово вне собственных возможностей не мешает", () => {
    const issues = auditCompanyProfile(
      profile({
        capabilities: {
          ...demoCompanyProfile.capabilities,
          keywords: ["ноутбук"],
          products: [],
          works: [],
          services: [],
          synonyms: [],
          stopWords: ["медицинск"],
        },
      }),
      NOW,
    );
    expect(kinds(issues)).not.toContain("stopWordContradictsCapabilities");
  });

  it("в предупреждение попадают только конфликтующие стоп-слова", () => {
    const issues = auditCompanyProfile(
      profile({
        capabilities: {
          ...demoCompanyProfile.capabilities,
          keywords: ["ноутбук"],
          products: [],
          works: [],
          services: [],
          synonyms: [],
          stopWords: ["медицинск", "ноутбук", "аренда"],
        },
      }),
      NOW,
    );
    const issue = issues.find((i) => i.kind === "stopWordContradictsCapabilities");
    expect(issue?.values).toEqual(["ноутбук"]);
  });
});

describe("auditCompanyProfile — пустые поля", () => {
  it("нет ни ключевых слов, ни товаров, ни работ — подсказка", () => {
    const issues = auditCompanyProfile(
      profile({
        capabilities: {
          products: [],
          works: [],
          services: [],
          brandsAndModels: [],
          keywords: [],
          synonyms: [],
          stopWords: [],
          okpd2Codes: [],
        },
      }),
      NOW,
    );
    expect(kinds(issues)).toContain("noCapabilities");
  });

  it("заполненные возможности — подсказки нет", () => {
    const issues = auditCompanyProfile(
      profile({
        capabilities: { ...demoCompanyProfile.capabilities, keywords: ["ноутбук"] },
      }),
      NOW,
    );
    expect(kinds(issues)).not.toContain("noCapabilities");
  });

  it("пустая география работы — подсказка", () => {
    const issues = auditCompanyProfile(
      profile({
        restrictions: { ...demoCompanyProfile.restrictions, workRegions: [] },
      }),
      NOW,
    );
    expect(kinds(issues)).toContain("noWorkRegions");
  });

  it("география из пустых строк считается незаполненной", () => {
    const issues = auditCompanyProfile(
      profile({
        restrictions: { ...demoCompanyProfile.restrictions, workRegions: ["", "  "] },
      }),
      NOW,
    );
    expect(kinds(issues)).toContain("noWorkRegions");
  });
});

describe("auditCompanyProfile — итог", () => {
  it("согласованный профиль не даёт замечаний", () => {
    const issues = auditCompanyProfile(
      profile({
        sroMemberships: [constructionSro()],
        capabilities: {
          ...demoCompanyProfile.capabilities,
          works: ["Строительство объектов капитального строительства"],
          keywords: ["капитальный ремонт", "строительство"],
          stopWords: ["аренда"],
        },
        restrictions: {
          ...demoCompanyProfile.restrictions,
          maxPrice: 90_000_000,
          workRegions: ["Иркутская область"],
        },
      }),
      NOW,
    );
    expect(issues).toHaveLength(0);
  });

  it("каждое замечание объясняет, что сделать", () => {
    const issues = auditCompanyProfile(
      profile({
        sroMemberships: [constructionSro()],
        restrictions: { ...demoCompanyProfile.restrictions, maxPrice: 5_000_000, workRegions: [] },
      }),
      NOW,
    );
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.title.trim().length).toBeGreaterThan(0);
      expect(issue.detail.trim().length).toBeGreaterThan(0);
    }
  });
});
