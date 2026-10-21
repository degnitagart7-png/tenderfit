import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { CompanyProfile } from "@/domain/entities";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { CompanyProfileForm } from "@/components/settings/CompanyProfileForm";
import { DEFAULT_COST_PROFILE } from "@/domain/estimate/companyCostProfile";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";

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

describe("CompanyProfileForm — профиль затрат", () => {
  it("раздел «Ваши затраты» с шестью полями и пояснениями; сохранённый профиль затрат подставлен", () => {
    render(
      <CompanyProfileForm
        initial={{ ...contradictory, costProfile: { ...DEFAULT_COST_PROFILE, materialDiscountPercent: 12 } }}
      />,
    );

    expect(screen.getByText("Ваши затраты — для расчёта цены участия")).toBeInTheDocument();
    const editor = screen.getByTestId("cost-profile-editor");
    expect(within(editor).getAllByRole("spinbutton")).toHaveLength(6);
    expect((screen.getByLabelText(/Скидка на материалы к сметным ценам/) as HTMLInputElement).value).toBe("12");
    expect(editor.textContent).toContain("скидки поставщиков");
  });

  it("профиль без поля costProfile открывается с нейтральными значениями", () => {
    render(<CompanyProfileForm initial={contradictory} />);
    expect((screen.getByLabelText(/Ваш труд к сметному/) as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText(/Накладные расходы: сколько тратится/) as HTMLInputElement).value).toBe("100");
  });

  it("правка поля и «Сохранить» кладут профиль затрат в профиль компании", async () => {
    localStorage.clear();
    render(<CompanyProfileForm initial={{ ...contradictory, inn: "7707083893" }} />);
    fireEvent.change(screen.getByLabelText(/Скидка на материалы к сметным ценам/), { target: { value: "8" } });
    // Согласие на обработку ПД — условие сохранения профиля.
    fireEvent.click(screen.getByLabelText(/Даю/));

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(companyProfileRepository.get().costProfile).toEqual({ ...DEFAULT_COST_PROFILE, materialDiscountPercent: 8 });
  });
});
