import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingView, INVOICE_POLL_MS } from "@/components/billing/BillingView";
import type { PaymentInvoiceView } from "@/domain/payments";

const me = vi.hoisted(() => vi.fn());
vi.mock("@/services/accountApiService", () => ({ accountApiService: { me } }));
const api = vi.hoisted(() => ({
  list: vi.fn(),
  createInvoice: vi.fn(),
  resend: vi.fn(),
  claimSbp: vi.fn(),
  pdfUrl: (id: string) => `/api/payments/invoices/${id}/pdf`,
}));
vi.mock("@/services/paymentsApiService", () => ({ paymentsApiService: api }));
const profile = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/repositories/companyProfileRepository", () => ({ companyProfileRepository: profile }));

/** Суммы печатаются с неразрывным пробелом: в тестах сравниваем по обычному. */
const plain = (text: string | null | undefined): string => (text ?? "").replace(/\s/g, " ");

const guest = { user: { email: "client@example.ru" }, loginEnabled: true };

function invoice(over: Partial<PaymentInvoiceView> = {}): PaymentInvoiceView {
  return {
    id: "inv-1",
    plan: "start",
    amountRub: 9000,
    months: 1,
    status: "issued",
    method: "invoice",
    invoiceNumber: "ТФ-0001",
    buyerName: "ООО «Ромашка»",
    buyerInn: "7707083893",
    buyerEmail: "buh@romashka.ru",
    createdAt: "2026-10-20T09:00:00.000Z",
    paidAt: null,
    activatedUntil: null,
    hasPdf: true,
    ...over,
  };
}

beforeEach(() => {
  me.mockResolvedValue(guest);
  api.list.mockResolvedValue({ invoices: [], billingReady: true });
  api.createInvoice.mockReset();
  api.resend.mockReset();
  api.claimSbp.mockReset();
  profile.get.mockReturnValue({ inn: "", legalName: "" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Вкладка «Оплатить по счёту» отрисована: список счетов загружен. */
const formReady = () => screen.findByRole("form", { name: "Реквизиты для счёта" });

describe("BillingView — оплата и тарифы", () => {
  it("три пакета; выбран «Расчёт», к оплате 39 000 ₽", () => {
    render(<BillingView />);

    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /^Пакет «Расчёт»/ }).getAttribute("aria-checked")).toBe("true");
    expect(plain(screen.getByTestId("total").textContent)).toBe("39 000 ₽");
  });

  it("выбор другого пакета меняет заказ и сумму на кнопке счёта", async () => {
    render(<BillingView />);
    fireEvent.click(screen.getByRole("radio", { name: /^Пакет «Старт»/ }));

    expect(plain(screen.getByTestId("total").textContent)).toBe("9 000 ₽");
    await formReady();
    expect(screen.getByRole("button", { name: /Выставить счёт на 9\s000\s₽/ })).toBeTruthy();
  });

  it("премиум — «по запросу», кнопка про условия, способов оплаты нет", async () => {
    render(<BillingView />);
    fireEvent.click(screen.getByRole("radio", { name: /^Пакет «Премиум»/ }));

    expect(screen.getByTestId("total").textContent).toBe("по запросу");
    const link = screen.getByRole("link", { name: "Обсудить условия" }) as HTMLAnchorElement;
    expect(new URLSearchParams(link.href.split("?")[1]).get("subject")).toBe("Условия пакета «Премиум»");
    expect(screen.queryByTestId("pay-block")).toBeNull();
  });

  it("говорит про автоматическое включение подписки", () => {
    render(<BillingView />);

    expect(screen.getAllByText(/Подписка включится автоматически, как только банк подтвердит оплату/).length).toBeGreaterThan(0);
  });

  it("банк не настроен на сервере: остаётся запрос счёта письмом с почтой клиента", async () => {
    api.list.mockResolvedValue({ invoices: [], billingReady: false });
    render(<BillingView />);

    const link = (await screen.findByRole("link", { name: "Запросить счёт" })) as HTMLAnchorElement;
    const params = new URLSearchParams(link.href.split("?")[1]);
    expect(params.get("subject")).toBe("Счёт на оплату — пакет «Расчёт»");
    expect(params.get("body")).toContain("client@example.ru");
    expect(screen.queryByRole("form", { name: "Реквизиты для счёта" })).toBeNull();
  });
});

describe("BillingView — оплата по счёту", () => {
  async function fill(values: { inn?: string; name?: string; email?: string; kpp?: string } = {}) {
    await formReady();
    fireEvent.change(screen.getByLabelText("ИНН"), { target: { value: values.inn ?? "7707083893" } });
    if (values.kpp !== undefined) fireEvent.change(screen.getByLabelText("КПП"), { target: { value: values.kpp } });
    fireEvent.change(screen.getByLabelText("Название организации"), { target: { value: values.name ?? "ООО «Ромашка»" } });
    fireEvent.change(screen.getByLabelText("Почта для счёта"), { target: { value: values.email ?? "buh@romashka.ru" } });
  }

  it("неверный ИНН — ошибка у поля, банк не вызывается", async () => {
    render(<BillingView />);
    await fill({ inn: "7707083894" });
    fireEvent.click(screen.getByRole("button", { name: /Выставить счёт/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Проверьте ИНН/);
    expect(api.createInvoice).not.toHaveBeenCalled();
  });

  it("верные реквизиты: счёт выставлен, показан номер, сумма, PDF и письмо", async () => {
    api.createInvoice.mockResolvedValue({ invoice: invoice({ plan: "calc", amountRub: 39000 }), emailSent: true });
    render(<BillingView />);
    await fill({ kpp: "770701001" });
    fireEvent.click(screen.getByRole("button", { name: /Выставить счёт на 39\s000\s₽/ }));

    const banner = await screen.findByTestId("created-invoice");
    expect(plain(banner.textContent)).toMatch(/Счёт № ТФ-0001 на 39 000 ₽ выставлен и отправлен на buh@romashka.ru/);
    expect(api.createInvoice).toHaveBeenCalledWith({ planId: "calc", inn: "7707083893", kpp: "770701001", name: "ООО «Ромашка»", email: "buh@romashka.ru" });
    const pdf = within(banner).getByRole("link", { name: /Скачать PDF/ }) as HTMLAnchorElement;
    expect(pdf.getAttribute("href")).toBe("/api/payments/invoices/inv-1/pdf");
    expect(within(banner).getByText("ждёт оплаты")).toBeTruthy();
  });

  it("ошибка банка показывается словами сервера", async () => {
    api.createInvoice.mockRejectedValue(new Error("Не удалось выставить счёт: банк сейчас не отвечает."));
    render(<BillingView />);
    await fill();
    fireEvent.click(screen.getByRole("button", { name: /Выставить счёт/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/банк сейчас не отвечает/);
  });

  it("реквизиты подставляются из прошлого счёта, а без него — из анкеты компании", async () => {
    api.list.mockResolvedValue({ invoices: [invoice({ buyerInn: "7728168971", buyerName: "АО «Прошлый»", buyerEmail: "old@firma.ru" })], billingReady: true });
    const { unmount } = render(<BillingView />);
    await formReady();
    expect((screen.getByLabelText("ИНН") as HTMLInputElement).value).toBe("7728168971");
    expect((screen.getByLabelText("Название организации") as HTMLInputElement).value).toBe("АО «Прошлый»");
    expect((screen.getByLabelText("Почта для счёта") as HTMLInputElement).value).toBe("old@firma.ru");
    unmount();

    api.list.mockResolvedValue({ invoices: [], billingReady: true });
    profile.get.mockReturnValue({ inn: "7707083893", legalName: "ООО «Из анкеты»" });
    render(<BillingView />);
    await formReady();
    expect((screen.getByLabelText("ИНН") as HTMLInputElement).value).toBe("7707083893");
    expect((screen.getByLabelText("Название организации") as HTMLInputElement).value).toBe("ООО «Из анкеты»");
    await waitFor(() => expect((screen.getByLabelText("Почта для счёта") as HTMLInputElement).value).toBe("client@example.ru"));
  });

  it("анкета с неверным ИНН не подставляется", async () => {
    profile.get.mockReturnValue({ inn: "123", legalName: "Что-то" });
    render(<BillingView />);
    await formReady();
    expect((screen.getByLabelText("ИНН") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Название организации") as HTMLInputElement).value).toBe("");
  });
});

describe("BillingView — оплата по QR (СБП)", () => {
  async function openQr() {
    render(<BillingView />);
    await formReady();
    fireEvent.click(screen.getByRole("tab", { name: "Оплатить по QR (СБП)" }));
  }

  it("QR-код, точная сумма и ссылка для телефона", async () => {
    await openQr();

    expect((screen.getByAltText(/QR-код СБП/) as HTMLImageElement).getAttribute("src")).toBe("/payment/sbp-qr.png");
    expect(plain(screen.getByTestId("sbp-amount").textContent)).toBe("39 000 ₽");
    const link = screen.getByRole("link", { name: /Открыть в приложении банка/ }) as HTMLAnchorElement;
    expect(link.href).toBe("https://qr.nspk.ru/AS1A002LRS3K859M9S7OSH4UTKRFIFSC?type=01&bank=100000000284&crc=27F8");
  });

  it("«Я оплатил» отправляет заявку на выбранный тариф и показывает ожидание подтверждения", async () => {
    api.claimSbp.mockResolvedValue({ claim: invoice({ id: "c1", method: "sbp_claim", plan: "calc", amountRub: 39000, invoiceNumber: null, hasPdf: false }), confirmed: false });
    await openQr();
    api.list.mockResolvedValue({ invoices: [invoice({ id: "c1", method: "sbp_claim", plan: "calc", amountRub: 39000, invoiceNumber: null, hasPdf: false })], billingReady: true });
    fireEvent.click(screen.getByRole("button", { name: "Я оплатил" }));

    expect(await screen.findByTestId("sbp-pending")).toBeTruthy();
    expect(api.claimSbp).toHaveBeenCalledWith("calc");
    expect(screen.queryByRole("button", { name: "Я оплатил" })).toBeNull();
    expect(screen.getAllByText("ждёт подтверждения").length).toBeGreaterThan(0);
  });

  it("ошибка заявки показывается", async () => {
    api.claimSbp.mockRejectedValue(new Error("Оплата по QR временно недоступна."));
    await openQr();
    fireEvent.click(screen.getByRole("button", { name: "Я оплатил" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/временно недоступна/);
  });
});

describe("BillingView — мои счета и автообновление", () => {
  it("список: номер, тариф, сумма, статус; PDF и «Отправить на почту» только у ждущих", async () => {
    api.list.mockResolvedValue({
      invoices: [
        invoice({ id: "a", invoiceNumber: "ТФ-0002", plan: "calc", amountRub: 39000 }),
        invoice({ id: "b", invoiceNumber: "ТФ-0001", status: "paid", activatedUntil: "2026-11-19T09:00:00.000Z" }),
        invoice({ id: "c", invoiceNumber: "ТФ-0000", status: "expired" }),
      ],
      billingReady: true,
    });
    render(<BillingView />);

    const rows = await screen.findAllByTestId("invoice-row");
    expect(rows).toHaveLength(3);
    expect(plain(rows[0]?.textContent)).toMatch(/Счёт № ТФ-0002.*«Расчёт».*39 000 ₽.*ждёт оплаты/);
    expect(plain(rows[1]?.textContent)).toMatch(/оплачен.*подписка до 19 ноября 2026/);
    expect(rows[2]?.textContent).toMatch(/просрочен/);
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: /Отправить на почту/ })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole("button", { name: /Отправить на почту/ })).toBeNull();
  });

  it("повторная отправка на почту", async () => {
    api.list.mockResolvedValue({ invoices: [invoice()], billingReady: true });
    api.resend.mockResolvedValue({ sent: true, sentTo: "buh@romashka.ru" });
    render(<BillingView />);

    fireEvent.click(await screen.findByRole("button", { name: /Отправить на почту/ }));

    expect(await screen.findByText("Отправили на buh@romashka.ru")).toBeTruthy();
    expect(api.resend).toHaveBeenCalledWith("inv-1");
  });

  it("пока есть ждущий счёт, статус спрашивается раз в 20 секунд; оплата → сообщение и обновление срока", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.list.mockResolvedValue({ invoices: [invoice()], billingReady: true });
    render(<BillingView />);
    await screen.findByTestId("invoice-row");
    const callsAfterLoad = api.list.mock.calls.length;
    const meCalls = me.mock.calls.length;

    api.list.mockResolvedValue({ invoices: [invoice({ status: "paid", activatedUntil: "2026-11-19T09:00:00.000Z" })], billingReady: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INVOICE_POLL_MS + 100);
    });

    expect(api.list.mock.calls.length).toBeGreaterThan(callsAfterLoad);
    expect((await screen.findByTestId("paid-notice")).textContent).toMatch(/Оплата получена — подписка «Старт» активна до 19 ноября 2026/);
    expect(me.mock.calls.length).toBeGreaterThan(meCalls);

    // Ждущих счетов больше нет — опрос прекращается.
    const callsAfterPaid = api.list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INVOICE_POLL_MS * 3);
    });
    expect(api.list.mock.calls.length).toBe(callsAfterPaid);
  });

  it("без ждущих счетов опроса нет", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.list.mockResolvedValue({ invoices: [invoice({ status: "paid" })], billingReady: true });
    render(<BillingView />);
    await screen.findByTestId("invoice-row");
    const calls = api.list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INVOICE_POLL_MS * 3);
    });
    expect(api.list.mock.calls.length).toBe(calls);
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
    await screen.findByRole("tab", { name: "Оплатить по счёту" });

    expect(screen.queryByTestId("access-note")).toBeNull();
  });
});
