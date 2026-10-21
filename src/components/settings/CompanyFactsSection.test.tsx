import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ extractFacts: vi.fn() }));
vi.mock("@/services/companyApiService", () => ({ companyApiService: api }));

import { CompanyFactsSection, FACTS_CONSENT_LINE } from "@/components/settings/CompanyFactsSection";
import { emptyFacts, type CompanyFacts } from "@/domain/companyFacts/types";
import type { CompanyDocument } from "@/domain/entities";

const NOW = new Date("2026-10-21T12:00:00Z");

const document: CompanyDocument = {
  id: "doc-1",
  fileName: "Реестр контрактов.pdf",
  fileType: "pdf",
  size: 1000,
  uploadedAt: NOW.toISOString(),
  category: "experience",
  text: "Капитальный ремонт кровли школы № 5, 12 450 000 руб., 2024. Контакт заказчика: Сергеева Н. А., тел. +7 913 123-45-67, sergeeva@omsk.ru",
};

const facts: CompanyFacts = {
  ...emptyFacts(NOW),
  sourceDocuments: ["Реестр контрактов.pdf"],
  scrubStats: { fio: 1, phone: 1, email: 1, passport: 0, snils: 0, personalInn: 0, birthDate: 0, address: 0 },
  workTypes: [{ name: "Ремонт кровли", contractsCount: 2, totalSumRub: 20_000_000, years: [2024], largestContractRub: 12_450_000 }],
  contracts: [
    { id: "c1", subject: "Капитальный ремонт кровли школы № 5", workType: null, customerType: "municipal", customer: null, year: 2024, sumRub: 12_450_000, law: "44-FZ", region: null },
    { id: "c2", subject: "Ремонт кровли детского сада", workType: null, customerType: "municipal", customer: null, year: 2023, sumRub: 7_550_000, law: "223-FZ", region: null },
  ],
  sro: [{ id: "s1", kind: "CONSTRUCTION", level: 2, maxContractRub: null, number: null, validUntil: null }],
  prices: [{ id: "p1", name: "Демонтаж кровли", unit: "м2", priceRub: 340, code: null, kind: "work", vat: "unknown" }],
};

function renderSection(patch: Partial<React.ComponentProps<typeof CompanyFactsSection>> = {}) {
  const props: React.ComponentProps<typeof CompanyFactsSection> = {
    documents: [document],
    onDocumentsChange: vi.fn(),
    facts: undefined,
    onFactsChange: vi.fn(() => true),
    companyInn: "5503123456",
    companyName: "ООО «СтройОмск»",
    ...patch,
  };
  render(<CompanyFactsSection {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CompanyFactsSection", () => {
  it("показывает согласие: что уходит в ИИ и что удаляется заранее", () => {
    renderSection();
    expect(screen.getByText(new RegExp(FACTS_CONSENT_LINE.slice(0, 40), "u"))).toBeInTheDocument();
    expect(FACTS_CONSENT_LINE).toBe("В ИИ отправляются только деловые сведения; ФИО, телефоны, почта и паспортные данные удаляются заранее.");
  });

  it("без документов кнопка обновления недоступна", () => {
    renderSection({ documents: [] });
    expect(screen.getByRole("button", { name: "Обновить профиль по документам" })).toBeDisabled();
  });

  it("сначала предпросмотр «Что уйдёт в ИИ», отправка — только по второму нажатию", () => {
    renderSection();
    expect(screen.queryByTestId("send-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Обновить профиль по документам" }));

    const preview = screen.getByTestId("send-preview");
    expect(within(preview).getByText("Что уйдёт в ИИ")).toBeInTheDocument();
    expect(screen.getByTestId("send-preview-summary").textContent).toMatch(/Скрыто: ФИО: 1, телефонов: 1, адресов почты: 1/u);
    // Показанный текст очищен: ни фамилии, ни телефона, ни почты.
    expect(preview.textContent).not.toMatch(/Сергеева|913|sergeeva@/u);
    expect(preview.textContent).toContain("12 450 000");
    expect(preview.textContent).toContain("[ФИО]");
    expect(api.extractFacts).not.toHaveBeenCalled();
  });

  it("отправка уходит с очищенным текстом и кладёт факты в анкету", async () => {
    api.extractFacts.mockResolvedValue({ facts, skipped: [], truncated: false, sentChars: 100, calls: 1, droppedForPii: 0, failedCalls: 0 });
    const props = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Обновить профиль по документам" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить в ИИ и обновить профиль" }));

    await waitFor(() => expect(props.onFactsChange).toHaveBeenCalledTimes(1));
    const request = api.extractFacts.mock.calls[0]?.[0] as { documents: { text: string; category: string }[]; companyInn: string };
    expect(request.documents[0]?.text).not.toMatch(/Сергеева|913|sergeeva@/u);
    expect(request.documents[0]?.category).toBe("experience");
    expect(request.companyInn).toBe("5503123456");
    expect(props.onFactsChange).toHaveBeenCalledWith(facts);
    expect(await screen.findByText("Профиль по документам обновлён и сохранён.")).toBeInTheDocument();
  });

  it("анкету сохранить не удалось (нет согласия) — человеку об этом сказано", async () => {
    api.extractFacts.mockResolvedValue({ facts, skipped: [{ id: "x", name: "Скан.pdf", reason: "после очистки текста почти не осталось" }], truncated: true, sentChars: 100, calls: 1, droppedForPii: 2, failedCalls: 0 });
    renderSection({ onFactsChange: vi.fn(() => false) });
    fireEvent.click(screen.getByRole("button", { name: "Обновить профиль по документам" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить в ИИ и обновить профиль" }));
    const outcome = await screen.findByTestId("facts-outcome");
    expect(outcome.textContent).toMatch(/только на экране/u);
    expect(outcome.textContent).toMatch(/Скан\.pdf/u);
    expect(outcome.textContent).toMatch(/лимит объёма/u);
    expect(outcome.textContent).toMatch(/личные данные: 2/u);
  });

  it("ошибка сервера показывается, предпросмотр остаётся — можно повторить", async () => {
    api.extractFacts.mockRejectedValue(new Error("Слишком много запросов. Подождите немного."));
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Обновить профиль по документам" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить в ИИ и обновить профиль" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Слишком много запросов");
    expect(screen.getByTestId("send-preview")).toBeInTheDocument();
  });

  it("«Отмена» закрывает предпросмотр", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Обновить профиль по документам" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByTestId("send-preview")).toBeNull();
  });

  it("факты показываются сводкой с источниками и счётчиком скрытого", () => {
    renderSection({ facts });
    expect(screen.getByTestId("facts-meta").textContent).toMatch(/Реестр контрактов\.pdf/u);
    expect(screen.getByTestId("facts-meta").textContent).toMatch(/скрыто: ФИО: 1, телефонов: 1, адресов почты: 1/u);
    expect(screen.getByTestId("company-facts-editor")).toBeInTheDocument();
    expect(screen.getByText(/Свои цены/u)).toBeInTheDocument();
  });

  it("запись фактов можно удалить: в анкету уходит список без неё", () => {
    const props = renderSection({ facts });
    fireEvent.click(screen.getByRole("button", { name: "Удалить: Ремонт кровли детского сада" }));
    expect(props.onFactsChange).toHaveBeenCalledTimes(1);
    const next = (props.onFactsChange as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as CompanyFacts;
    expect(next.contracts.map((item) => item.id)).toEqual(["c1"]);
    expect(next.workTypes).toHaveLength(1);
  });

  it("сумму контракта можно поправить", () => {
    const props = renderSection({ facts });
    const sums = screen.getAllByLabelText("Сумма, ₽");
    const contractSum = sums.find((input) => (input as HTMLInputElement).value === "12450000");
    expect(contractSum).toBeDefined();
    fireEvent.change(contractSum as HTMLInputElement, { target: { value: "13 000 000" } });
    fireEvent.blur(contractSum as HTMLInputElement);
    const next = (props.onFactsChange as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as CompanyFacts;
    expect(next.contracts[0]?.sumRub).toBe(13_000_000);
  });

  it("«Очистить факты» убирает их из анкеты", () => {
    const props = renderSection({ facts });
    fireEvent.click(screen.getByRole("button", { name: "Очистить факты" }));
    expect(props.onFactsChange).toHaveBeenCalledWith(undefined);
  });
});
