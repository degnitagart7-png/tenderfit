import { describe, expect, it } from "vitest";
import { analysisDecision } from "@/domain/analysisDecision";
import { matchFindingsWithProfile } from "@/domain/profileMatch";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { demoTenders } from "@/mocks/tenders";
import type { AnalysisFinding } from "@/types/database";

const tender = demoTenders[0]!;
const f = (p: Partial<AnalysisFinding>): AnalysisFinding => ({
  category: "requirement",
  title: "Требование",
  detail: "",
  evidence_quote: "цитата",
  evidence_section: "п. 1",
  severity: "medium",
  ...p,
});
const LICENSE_OK = f({ category: "blocker", title: "Лицензия МЧС", requirement_kind: "LICENSE", required_value: "лицензия МЧС на монтаж пожарной сигнализации" });
const SRO_MISSING = f({ category: "blocker", title: "Членство в СРО", requirement_kind: "SRO", required_value: "членство в СРО строителей" });
const NOW = new Date("2026-10-05T12:00:00Z");
const match = (findings: AnalysisFinding[]) => matchFindingsWithProfile(findings, tender, demoCompanyProfile, NOW);

describe("analysisDecision", () => {
  it("нет допуска — «нельзя», причины названы по требованиям", () => {
    const findings = [LICENSE_OK, SRO_MISSING];
    const d = analysisDecision({ match: match(findings), findings, documentsSkipped: 0 });
    expect(d.tone).toBe("bad");
    expect(d.reasons).toEqual(["Членство в СРО"]);
  });

  it("допуск есть, но высокий риск и непрочитанный файл — «проверить»", () => {
    const findings = [LICENSE_OK, f({ category: "risk", title: "Пеня 0,5% в день", severity: "high" })];
    const d = analysisDecision({ match: match(findings), findings, documentsSkipped: 1 });
    expect(d.tone).toBe("warn");
    expect(d.reasons).toEqual(["Риск: Пеня 0,5% в день", "Один файл не прочитан — вывод по нему не делался"]);
  });

  it("всё закрыто и высоких рисков нет — «препятствий не найдено»", () => {
    const findings = [LICENSE_OK, f({ category: "risk", title: "Оплата 60 дней", severity: "medium" })];
    const d = analysisDecision({ match: match(findings), findings, documentsSkipped: 0 });
    expect(d.tone).toBe("good");
    expect(d.headline).toBe("Препятствий для участия не найдено");
  });

  it("профиля нет — нейтральный вывод, а не «всё хорошо»", () => {
    const findings = [LICENSE_OK];
    const d = analysisDecision({ match: null, findings, documentsSkipped: 0 });
    expect(d.tone).toBe("neutral");
  });

  it("причин не больше трёх", () => {
    const findings = [1, 2, 3, 4, 5].map((i) => f({ category: "risk", title: `Риск ${i}`, severity: "high" }));
    const d = analysisDecision({ match: match([LICENSE_OK]), findings, documentsSkipped: 0 });
    expect(d.reasons).toHaveLength(3);
  });
});
