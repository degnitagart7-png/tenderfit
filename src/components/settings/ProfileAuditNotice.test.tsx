import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CompanyProfile } from "@/domain/entities";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { ProfileAuditNotice } from "@/components/settings/ProfileAuditNotice";

function profile(patch: Partial<CompanyProfile> = {}): CompanyProfile {
  return { ...demoCompanyProfile, ...patch };
}

/** Профиль строительного подрядчика без внутренних противоречий. */
const consistent = profile({
  sroMemberships: [
    {
      id: "sro-1",
      kind: "CONSTRUCTION",
      type: "Строительство, реконструкция, капитальный ремонт",
      number: "СРО-С-000-000000",
      responsibilityLevel: 1,
      maxContractAmount: null,
      validUntil: null,
      confirmed: true,
    },
  ],
  capabilities: {
    ...demoCompanyProfile.capabilities,
    keywords: ["капитальный ремонт", "строительство"],
    works: ["Строительство объектов капитального строительства"],
    stopWords: ["аренда"],
  },
  restrictions: {
    ...demoCompanyProfile.restrictions,
    maxPrice: 90_000_000,
    workRegions: ["Иркутская область"],
  },
});

describe("ProfileAuditNotice", () => {
  it("согласованный профиль не показывает замечаний", () => {
    const { container } = render(<ProfileAuditNotice profile={consistent} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("лимит цены ниже допуска СРО — предупреждение с суммами", () => {
    render(
      <ProfileAuditNotice
        profile={{
          ...consistent,
          restrictions: { ...consistent.restrictions, maxPrice: 5_000_000 },
        }}
      />,
    );
    expect(screen.getByText("Лимит цены ниже допуска СРО")).toBeInTheDocument();
    // toLocaleString("ru-RU") разделяет разряды неразрывным пробелом.
    const text = screen.getByTestId("profile-audit").textContent ?? "";
    expect(text).toMatch(/90\s000\s000\s₽/);
    expect(text).toMatch(/5\s000\s000\s₽/);
  });

  it("стоп-слово против собственного вида работ — предупреждение", () => {
    render(
      <ProfileAuditNotice
        profile={{
          ...consistent,
          capabilities: { ...consistent.capabilities, stopWords: ["строительство"] },
        }}
      />,
    );
    expect(
      screen.getByText("Стоп-слово против собственной деятельности"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("profile-audit").textContent).toContain("строительство");
  });

  it("пустая география работы — подсказка", () => {
    render(
      <ProfileAuditNotice
        profile={{
          ...consistent,
          restrictions: { ...consistent.restrictions, workRegions: [] },
        }}
      />,
    );
    expect(screen.getByText("География работы не задана")).toBeInTheDocument();
  });

  it("показывает все замечания сразу", () => {
    render(
      <ProfileAuditNotice
        profile={{
          ...consistent,
          capabilities: { ...consistent.capabilities, stopWords: ["строительство"] },
          restrictions: { ...consistent.restrictions, maxPrice: 5_000_000, workRegions: [] },
        }}
      />,
    );
    expect(screen.getByText("Лимит цены ниже допуска СРО")).toBeInTheDocument();
    expect(
      screen.getByText("Стоп-слово против собственной деятельности"),
    ).toBeInTheDocument();
    expect(screen.getByText("География работы не задана")).toBeInTheDocument();
  });
});
