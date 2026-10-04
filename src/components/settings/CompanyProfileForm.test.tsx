import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CompanyProfile } from "@/domain/entities";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { CompanyProfileForm } from "@/components/settings/CompanyProfileForm";

/** Профиль, в котором лимит цены противоречит действующему допуску СРО. */
const contradictory: CompanyProfile = {
  ...demoCompanyProfile,
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
  restrictions: { ...demoCompanyProfile.restrictions, maxPrice: 5_000_000 },
};

describe("CompanyProfileForm — проверка профиля на противоречия", () => {
  it("показывает замечание над полями формы", () => {
    render(<CompanyProfileForm initial={contradictory} />);
    expect(screen.getByText("Лимит цены ниже допуска СРО")).toBeInTheDocument();
  });

  it("согласованный профиль открывается без замечаний", () => {
    render(
      <CompanyProfileForm
        initial={{
          ...contradictory,
          restrictions: { ...contradictory.restrictions, maxPrice: 90_000_000 },
        }}
      />,
    );
    expect(screen.queryByTestId("profile-audit")).toBeNull();
    expect(screen.getByText("Профиль компании")).toBeInTheDocument();
  });

  /*
    Заполненный профиль — рабочий документ компании, а не черновик. Кнопка
    «Сбросить к демо-профилю» стирала его одним кликом без подтверждения,
    поэтому её убрали; тест держит это решение.
  */
  it("в форме нет кнопки сброса к примеру", () => {
    render(<CompanyProfileForm initial={contradictory} />);
    expect(screen.queryByRole("button", { name: /сбросить/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeInTheDocument();
  });
});
