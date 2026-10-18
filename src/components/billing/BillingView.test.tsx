import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingView } from "@/components/billing/BillingView";

const me = vi.hoisted(() => vi.fn());
vi.mock("@/services/accountApiService", () => ({ accountApiService: { me } }));
const guest = { user: { email: "client@example.ru" }, loginEnabled: true };
beforeEach(() => me.mockResolvedValue(guest));

afterEach(cleanup);

describe("BillingView — оплата и тарифы", () => {
  it("три пакета; выбран «Расчёт», к оплате 39 000 ₽", () => {
    render(<BillingView />);

    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /^Пакет «Расчёт»/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("total").textContent).toBe("39 000 ₽");
  });

  it("выбор другого пакета меняет заказ и ссылку на счёт", async () => {
    render(<BillingView />);
    fireEvent.click(screen.getByRole("radio", { name: /^Пакет «Старт»/ }));

    expect(screen.getByTestId("total").textContent).toBe("9 000 ₽");
    const link = (await screen.findByRole("link", { name: "Запросить счёт" })) as HTMLAnchorElement;
    const params = new URLSearchParams(link.href.split("?")[1]);
    expect(params.get("subject")).toBe("Счёт на оплату — пакет «Старт»");
    // Почта вошедшего подставляется в письмо.
    expect(params.get("body")).toContain("client@example.ru");
  });

  it("премиум — «по запросу», кнопка про условия, а не про счёт", () => {
    render(<BillingView />);
    fireEvent.click(screen.getByRole("radio", { name: /^Пакет «Премиум»/ }));

    expect(screen.getByTestId("total").textContent).toBe("по запросу");
    expect(screen.getByRole("link", { name: "Обсудить условия" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Запросить счёт" })).toBeNull();
  });

  it("честно говорит, что оплата картой не подключена", () => {
    render(<BillingView />);

    expect(screen.getByText(/Оплата картой онлайн пока не подключена/)).toBeTruthy();
  });
});


describe("BillingView — строка о доступе", () => {
  const H = 3_600_000;

  it("пробный период: сколько осталось", async () => {
    me.mockResolvedValue({
      user: {
        email: "client@example.ru",
        access: { status: "trial", endsAt: new Date(Date.now() + 50 * H).toISOString(), plan: null, daysLeft: 3, hoursLeft: 50 },
      },
      loginEnabled: true,
    });
    render(<BillingView />);

    expect((await screen.findByTestId("access-note")).textContent).toMatch(/Пробный период: осталось 3 дня/);
  });

  it("оплачено: до какого числа и какой пакет", async () => {
    me.mockResolvedValue({
      user: {
        email: "client@example.ru",
        access: { status: "paid", endsAt: "2027-01-15T12:00:00.000Z", plan: "calc", daysLeft: 90, hoursLeft: 2160 },
      },
      loginEnabled: true,
    });
    render(<BillingView />);

    expect((await screen.findByTestId("access-note")).textContent).toMatch(/Оплачено до 15 января 2027 г\., пакет «Расчёт»/);
  });

  it("закончился: данные сохранены, выберите пакет", async () => {
    me.mockResolvedValue({
      user: { email: "client@example.ru", access: { status: "expired", endsAt: null, plan: null, daysLeft: 0, hoursLeft: 0 } },
      loginEnabled: true,
    });
    render(<BillingView />);

    expect((await screen.findByTestId("access-note")).textContent).toMatch(/Пробный период закончился/);
  });

  it("администратору и старому серверу строка не нужна", async () => {
    me.mockResolvedValue({
      user: { email: "o@x.ru", access: { status: "admin", endsAt: null, plan: null, daysLeft: 0, hoursLeft: 0 } },
      loginEnabled: true,
    });
    render(<BillingView />);
    await screen.findByRole("link", { name: "Запросить счёт" });

    expect(screen.queryByTestId("access-note")).toBeNull();
  });
});
