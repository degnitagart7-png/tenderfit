import { describe, expect, it } from "vitest";
import type { CompanyProfile } from "@/domain/entities";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import {
  inferRequirementKind,
  matchFindingsWithProfile,
} from "@/domain/profileMatch";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { demoTenders } from "@/mocks/tenders";
import type { AnalysisFinding } from "@/types/database";

const NOW = new Date("2026-10-05T12:00:00Z");
const tender = demoTenders[0]!;

function finding(patch: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    category: "requirement",
    title: "Требование",
    detail: "",
    evidence_quote: "цитата",
    evidence_section: "раздел",
    severity: "medium",
    ...patch,
  };
}

const MCHS = finding({
  category: "blocker",
  title: "Лицензия МЧС",
  requirement_kind: "LICENSE",
  required_value:
    "лицензия на деятельность по монтажу, техническому обслуживанию и ремонту средств обеспечения пожарной безопасности",
});
const FSB = finding({
  category: "blocker",
  title: "Лицензия ФСБ",
  requirement_kind: "LICENSE",
  required_value:
    "лицензия ФСБ на работы с использованием сведений, составляющих государственную тайну",
});

describe("matchFindingsWithProfile", () => {
  it("без профиля — просит его заполнить, ничего не утверждая", () => {
    const result = matchFindingsWithProfile(
      [MCHS],
      tender,
      emptyCompanyProfile,
      NOW,
    );
    expect(result.verdict).toBe("NO_PROFILE");
    expect(matchFindingsWithProfile([MCHS], tender, null, NOW).verdict).toBe(
      "NO_PROFILE",
    );
  });

  it("лицензия сопоставляется по органу, а не по точной строке", () => {
    const result = matchFindingsWithProfile(
      [MCHS],
      tender,
      demoCompanyProfile,
      NOW,
    );
    expect(result.verdict).toBe("READY");
    expect(result.checks[0]).toMatchObject({ status: "MET", kind: "LICENSE" });
    expect(result.checks[0]!.reason).toMatch(/МЧС/);
  });

  it("недостающая лицензия — препятствие, и оно наверху списка", () => {
    const result = matchFindingsWithProfile(
      [MCHS, FSB],
      tender,
      demoCompanyProfile,
      NOW,
    );
    expect(result.verdict).toBe("BLOCKED");
    expect(result.notMet).toBe(1);
    expect(result.checks[0]!.finding.title).toBe("Лицензия ФСБ");
    expect(result.checks[0]!.reason).toMatch(/ФСБ/);
  });

  it("истёкшая лицензия не засчитывается", () => {
    const profile: CompanyProfile = {
      ...demoCompanyProfile,
      licenses: demoCompanyProfile.licenses.map((l) => ({
        ...l,
        validUntil: "2025-01-01",
      })),
    };
    const result = matchFindingsWithProfile([MCHS], tender, profile, NOW);
    expect(result.checks[0]).toMatchObject({ status: "NOT_MET" });
    expect(result.checks[0]!.reason).toMatch(/истекла/);
  });

  it("СРО без членства в профиле — не выполнено", () => {
    const sro = finding({
      category: "blocker",
      title: "Членство в СРО",
      requirement_kind: "SRO",
      required_value: "членство в СРО в области строительства",
    });
    const result = matchFindingsWithProfile(
      [sro],
      tender,
      demoCompanyProfile,
      NOW,
    );
    expect(result.checks[0]).toMatchObject({ status: "NOT_MET" });
    expect(result.checks[0]!.reason).toMatch(/нет действующего членства/);
  });

  it("типовые условия допуска закрываются декларацией, риски не сверяются", () => {
    const result = matchFindingsWithProfile(
      [
        finding({
          title: "Отсутствие в РНП",
          detail: "Участник не включён в реестр недобросовестных поставщиков",
        }),
        finding({ category: "risk", title: "Неустойка 0,5% в день" }),
      ],
      tender,
      demoCompanyProfile,
      NOW,
    );
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      kind: "DECLARATION",
      status: "MET",
    });
  });

  it("обеспечение — по специальному счёту профиля", () => {
    const security = finding({
      title: "Обеспечение заявки 1%",
      requirement_kind: "SECURITY",
    });
    expect(
      matchFindingsWithProfile([security], tender, demoCompanyProfile, NOW)
        .checks[0]!.status,
    ).toBe("MET");
    expect(
      matchFindingsWithProfile(
        [security],
        tender,
        { ...demoCompanyProfile, hasSpecialAccount: false },
        NOW,
      ).checks[0]!.status,
    ).toBe("NOT_MET");
  });

  it("одинаковое требование из разных фрагментов — одна строка", () => {
    const result = matchFindingsWithProfile(
      [MCHS, { ...MCHS }],
      tender,
      demoCompanyProfile,
      NOW,
    );
    expect(result.checks).toHaveLength(1);
  });

  it("неизвестное требование — на ручную сверку, а не в «выполнено»", () => {
    const result = matchFindingsWithProfile(
      [finding({ title: "Наличие представительства в регионе" })],
      tender,
      demoCompanyProfile,
      NOW,
    );
    expect(result.verdict).toBe("REVIEW");
    expect(result.checks[0]!.status).toBe("CHECK");
    // Причина говорит, что делать, а не «автоматически не сверяется».
    expect(result.checks[0]!.reason).not.toMatch(/Автоматически не сверяется/);
    expect(result.checks[0]!.reason).toMatch(/сверьте/);
  });

  it("типовое условие допуска от модели с видом «прочее» — выполнено декларацией", () => {
    const result = matchFindingsWithProfile(
      [
        finding({
          title: "Единые требования к участникам",
          required_value: "соответствие ч. 1 ст. 31 Закона № 44-ФЗ",
          requirement_kind: "OTHER",
        }),
      ],
      tender,
      demoCompanyProfile,
      NOW,
    );
    expect(result.checks[0]).toMatchObject({ kind: "DECLARATION", status: "MET" });
  });
});

describe("inferRequirementKind: разборы без отметки модели", () => {
  it.each([
    ["Членство в СРО строителей", "SRO"],
    ["Лицензия ФСТЭК", "LICENSE"],
    ["Не менее 2 специалистов в НРС", "QUALIFIED_PERSONNEL"],
    ["Опыт исполнения контракта", "EXPERIENCE"],
    ["Только для СМП", "SMP"],
    ["Обеспечение исполнения контракта", "SECURITY"],
    ["Сроки рассмотрения", "OTHER"],
  ] as const)("«%s» → %s", (title, kind) => {
    expect(inferRequirementKind(finding({ title }))).toBe(kind);
  });

  it.each([
    ["Единые требования к участникам", "соответствие ч. 1 ст. 31 Закона № 44-ФЗ"],
    ["Отсутствие в санкционных перечнях", "не быть в санкционных перечнях РФ"],
  ])("«%s»: «прочее» от модели, но типовое условие по тексту → DECLARATION", (title, value) => {
    expect(
      inferRequirementKind(
        finding({ title, required_value: value, requirement_kind: "OTHER" }),
      ),
    ).toBe("DECLARATION");
    // Без отметки модели — то же.
    expect(
      inferRequirementKind(finding({ title, required_value: value })),
    ).toBe("DECLARATION");
  });

  it("«штрафные санкции» типовым условием допуска не считаются", () => {
    expect(
      inferRequirementKind(
        finding({ title: "Штрафные санкции", requirement_kind: "OTHER" }),
      ),
    ).toBe("OTHER");
  });

  it("отметка модели главнее текста", () => {
    expect(
      inferRequirementKind(
        finding({ title: "Опыт", requirement_kind: "OTHER" }),
      ),
    ).toBe("OTHER");
  });
});
