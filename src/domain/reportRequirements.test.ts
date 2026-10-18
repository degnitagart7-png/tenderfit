import { describe, expect, it } from "vitest";
import type { ProfileCheck, ProfileCheckStatus } from "@/domain/profileMatch";
import {
  buildRequirementRows,
  isSecurityFinding,
  isWarrantyTerm,
  pseudoChecks,
  splitRequirements,
  warrantyMonths,
} from "@/domain/reportRequirements";
import type { AnalysisFinding, FindingRequirementKind } from "@/types/database";

const ctx = { nmc: 1_000_000 };

function check(
  kind: FindingRequirementKind,
  status: ProfileCheckStatus,
  patch: Partial<AnalysisFinding> = {},
  reason = "",
): ProfileCheck {
  return {
    kind,
    status,
    reason,
    finding: {
      category: "requirement",
      title: "Требование",
      detail: "",
      evidence_quote: "цитата",
      evidence_section: "Раздел 1",
      severity: "medium",
      requirement_kind: kind,
      required_value: null,
      ...patch,
    },
  };
}

describe("обеспечения и гарантийный срок — не требования допуска", () => {
  it("SECURITY и «способ обеспечения» по виду и по названию", () => {
    expect(isSecurityFinding(check("SECURITY", "MET").finding)).toBe(true);
    // Модель отметила «прочее», но по названию это обеспечение.
    expect(isSecurityFinding(check("OTHER", "CHECK", { title: "Обеспечение исполнения контракта: 5%" }).finding, "OTHER")).toBe(true);
    expect(isSecurityFinding(check("OTHER", "CHECK", { title: "Способ обеспечения: гарантия" }).finding, "OTHER")).toBe(true);
    expect(isSecurityFinding(check("EXPERIENCE", "MET", { title: "Опыт" }).finding)).toBe(false);
  });

  it("гарантийный срок: есть срок и слово «гарантия»; обеспечение гарантии сюда не попадает", () => {
    expect(isWarrantyTerm(check("OTHER", "CHECK", { title: "Гарантия на работы", required_value: "36 месяцев" }).finding)).toBe(true);
    expect(isWarrantyTerm(check("OTHER", "CHECK", { title: "Гарантийные обязательства: 5 лет" }).finding)).toBe(true);
    expect(isWarrantyTerm(check("OTHER", "CHECK", { title: "Обеспечение гарантийных обязательств", required_value: "36 месяцев" }).finding)).toBe(false);
    expect(isWarrantyTerm(check("OTHER", "CHECK", { title: "Гарантия производителя" }).finding)).toBe(false);
  });

  it("срок гарантии: месяцы и годы", () => {
    expect(warrantyMonths("гарантия 36 месяцев")).toBe(36);
    expect(warrantyMonths("на срок 5 лет")).toBe(60);
    expect(warrantyMonths("без срока")).toBeNull();
  });

  it("разбор проверок на три корзины", () => {
    const split = splitRequirements([
      check("SECURITY", "MET", { title: "Обеспечение заявки" }),
      check("OTHER", "CHECK", { title: "Гарантия", required_value: "36 мес." }),
      check("SMP", "CHECK"),
    ]);
    expect(split.security).toHaveLength(1);
    expect(split.warranty).toHaveLength(1);
    expect(split.admission).toHaveLength(1);
  });
});

describe("buildRequirementRows: повторы склеиваются", () => {
  it("тот же вид и то же число — одна строка, источники через «; », худший статус", () => {
    const rows = buildRequirementRows(
      [
        check("OTHER", "MET", { title: "Опыт работ 20% НМЦК", required_value: "20%", evidence_section: "Извещение" }),
        check("OTHER", "CHECK", { title: "Подтверждение опыта 20%", required_value: "20%", evidence_section: "Проект контракта" }),
      ].map((c) => ({ ...c, kind: "OTHER" as const })),
      ctx,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("CHECK");
    expect(rows[0]!.sources).toEqual(["Извещение", "Проект контракта"]);
  });

  it("то же название и то же значение — одна строка", () => {
    const rows = buildRequirementRows(
      [
        check("LICENSE", "NOT_MET", { title: "Лицензия МЧС", evidence_section: "А" }),
        check("LICENSE", "NOT_MET", { title: "Лицензия МЧС", evidence_section: "Б" }),
      ],
      ctx,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources).toEqual(["А", "Б"]);
  });

  it("то же число, но другой вид — две строки; тот же вид, но другое число — две строки", () => {
    expect(
      buildRequirementRows(
        [
          check("EXPERIENCE", "MET", { title: "Опыт", required_value: "не менее 20% НМЦК" }),
          check("QUALIFIED_PERSONNEL", "MET", { title: "Специалисты", required_value: "не менее 20 человек" }),
        ],
        ctx,
      ),
    ).toHaveLength(2);
    expect(
      buildRequirementRows(
        [
          check("EXPERIENCE", "MET", { title: "Опыт", required_value: "не менее 20% НМЦК" }),
          check("EXPERIENCE", "MET", { title: "Опыт по другому договору", required_value: "не менее 30% НМЦК" }),
        ],
        ctx,
      ),
    ).toHaveLength(2);
  });

  it("СМП из двух мест — одна строка", () => {
    const rows = buildRequirementRows(
      [
        check("SMP", "CHECK", { title: "Только для СМП" }),
        check("SMP", "CHECK", { title: "Участие СОНКО и СМП", evidence_section: "Другой раздел" }),
      ],
      ctx,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("buildRequirementRows: типовые и порядок", () => {
  it("типовые «Выполнено» сворачиваются в одну строку с перечнем и «Подтверждается декларацией»", () => {
    const rows = buildRequirementRows(
      [
        check("DECLARATION", "MET", { title: "Отсутствие в РНП", evidence_section: "А" }),
        check("DECLARATION", "MET", { title: "Не в процессе ликвидации", evidence_section: "Б" }),
        check("DECLARATION", "MET", { title: "Единые требования", required_value: "ч. 1 ст. 31 44-ФЗ", evidence_section: "А" }),
        check("DECLARATION", "MET", { title: "Отсутствие недоимки по налогам", evidence_section: "Б" }),
      ],
      ctx,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      typical: true,
      status: "MET",
      title: "Типовые требования (РНП, нет ликвидации, ч. 1 ст. 31 44-ФЗ, нет недоимки по налогам)",
      sources: ["А", "Б", "А", "Б"],
    });
    expect(rows[0]!.action.text).toBe("Подтверждается декларацией в заявке.");
  });

  it("порядок: Не выполнено → Проверить → Выполнено; типовые — в самом конце", () => {
    const rows = buildRequirementRows(
      [
        check("DECLARATION", "MET", { title: "Не банкрот" }),
        check("QUALIFIED_PERSONNEL", "MET", { title: "Специалисты" }),
        check("SMP", "CHECK"),
        check("LICENSE", "NOT_MET", { title: "Лицензия ФСБ" }),
      ],
      ctx,
    );
    expect(rows.map((r) => r.status)).toEqual(["NOT_MET", "CHECK", "MET", "MET"]);
    expect(rows.at(-1)!.typical).toBe(true);
  });

  it("блокер выше обычного требования того же статуса и набран жирным", () => {
    const rows = buildRequirementRows(
      [
        check("OTHER", "CHECK", { title: "Обычное", required_value: "а" }),
        check("LICENSE", "CHECK", { title: "Лицензия", category: "blocker" }),
      ],
      ctx,
    );
    expect(rows[0]).toMatchObject({ kind: "LICENSE", blocker: true });
  });

  it("без сверки: pseudoChecks даёт «Проверить», повторы по названию убраны", () => {
    const f = check("LICENSE", "MET", { title: "Лицензия МЧС" }).finding;
    const checks = pseudoChecks([f, { ...f }, { ...f, category: "risk", title: "Риск" }]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "CHECK", reason: "" });
  });
});
