import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const me = vi.fn();
const sendTestDigest = vi.fn();
vi.mock("@/services/accountApiService", () => ({
  accountApiService: { me: (...a: unknown[]) => me(...a) },
}));
vi.mock("@/services/notificationApiService", () => ({
  notificationApiService: { sendTestDigest: (...a: unknown[]) => sendTestDigest(...a) },
}));

import SettingsNotificationsPage from "@/app/(app)/settings/notifications/page";
import { STORAGE_KEYS } from "@/lib/storage";

const stored = (): Record<string, unknown> => JSON.parse(window.localStorage.getItem(STORAGE_KEYS.settings) ?? "{}") as Record<string, unknown>;

function browserZone(zone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: zone } as Intl.ResolvedDateTimeFormatOptions);
}

beforeEach(() => {
  window.localStorage.clear();
  me.mockResolvedValue({ user: { email: "client@example.ru" }, loginEnabled: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  me.mockReset();
  sendTestDigest.mockReset();
});

describe("страница «Уведомления»", () => {
  it("больше не говорит, что отправка не подключена; обе карточки на месте", async () => {
    render(<SettingsNotificationsPage />);

    expect(await screen.findByText("Утренняя сводка")).toBeTruthy();
    expect(screen.getByText("Готов анализ или смета")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/не подключен/i);
    expect(screen.getByText(/Письмо придёт, если расчёт шёл дольше двух минут — чтобы не ждать на странице\./)).toBeTruthy();
  });

  it("переключатель называет почту пользователя; по умолчанию сводка включена, 08:00", async () => {
    render(<SettingsNotificationsPage />);

    const toggle = await screen.findByLabelText("Присылать сводку на client@example.ru");
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Время") as HTMLSelectElement).value).toBe("08:00");
  });

  it("время — от 06:00 до 12:00 с шагом час", async () => {
    render(<SettingsNotificationsPage />);

    const select = (await screen.findByLabelText("Время")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["06:00", "07:00", "08:00", "09:00", "10:00", "11:00", "12:00"]);
  });

  it("пояс не задан: берётся из браузера и сохраняется при первом открытии", async () => {
    browserZone("Asia/Irkutsk");
    render(<SettingsNotificationsPage />);

    const select = (await screen.findByLabelText("Часовой пояс")) as HTMLSelectElement;
    expect(select.value).toBe("Asia/Irkutsk");
    expect(select.selectedOptions[0]?.textContent).toBe("Иркутск (МСК+5)");
    expect(stored()["timeZone"]).toBe("Asia/Irkutsk");
  });

  it("пояс браузера из города, которого нет в списке пунктов (Новосибирск), показывается как «Новосибирск, Красноярск»", async () => {
    browserZone("Asia/Novosibirsk");
    render(<SettingsNotificationsPage />);

    const select = (await screen.findByLabelText("Часовой пояс")) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("Новосибирск, Красноярск (МСК+4)");
  });

  it("уже выбранный человеком пояс не перезаписывается поясом браузера", async () => {
    window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({ enabled: true, sendTime: "08:00", minFitScore: 50, timeZone: "Asia/Yakutsk" }));
    browserZone("Asia/Irkutsk");
    render(<SettingsNotificationsPage />);

    expect(((await screen.findByLabelText("Часовой пояс")) as HTMLSelectElement).value).toBe("Asia/Yakutsk");
    expect(stored()["timeZone"]).toBe("Asia/Yakutsk");
  });

  it("список поясов: от Калининграда до Камчатки", async () => {
    render(<SettingsNotificationsPage />);

    const select = (await screen.findByLabelText("Часовой пояс")) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels[0]).toBe("Калининград (МСК−1)");
    expect(labels).toContain("Москва (МСК)");
    expect(labels.at(-1)).toBe("Камчатка (МСК+9)");
  });

  it("смена времени и пояса сохраняется кнопкой; рядом подпись «Сохранено»", async () => {
    browserZone("Europe/Moscow");
    render(<SettingsNotificationsPage />);

    fireEvent.change(await screen.findByLabelText("Время"), { target: { value: "07:00" } });
    fireEvent.change(screen.getByLabelText("Часовой пояс"), { target: { value: "Asia/Vladivostok" } });
    expect(screen.queryByText("Сохранено")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(screen.getByText("Сохранено")).toBeTruthy();
    expect(stored()).toMatchObject({ sendTime: "07:00", timeZone: "Asia/Vladivostok", enabled: true });
  });

  it("сводку и письмо о готовности можно отключить независимо", async () => {
    render(<SettingsNotificationsPage />);

    fireEvent.click(await screen.findByLabelText("Присылать сводку на client@example.ru"));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(stored()).toMatchObject({ enabled: false, readyEnabled: true });

    fireEvent.click(screen.getByLabelText("Писать, когда глубокий анализ или смета готовы"));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(stored()).toMatchObject({ enabled: false, readyEnabled: false });
  });

  it("минимальная оценка сохраняется", async () => {
    render(<SettingsNotificationsPage />);

    fireEvent.change(await screen.findByLabelText(/Минимальная оценка соответствия/), { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(stored()["minFitScore"]).toBe(70);
  });

  it("настройки, сохранённые до писем (без пояса и readyEnabled), открываются без потерь", async () => {
    window.localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({ enabled: true, sendTime: "09:00", email: "demo@tenderfit.local", minFitScore: 65, urgentEnabled: true, urgentDeadlineHours: 24, documentChangesEnabled: true }),
    );
    render(<SettingsNotificationsPage />);

    expect(((await screen.findByLabelText("Время")) as HTMLSelectElement).value).toBe("09:00");
    expect((screen.getByLabelText(/Минимальная оценка соответствия/) as HTMLInputElement).value).toBe("65");
    expect((screen.getByLabelText("Писать, когда глубокий анализ или смета готовы") as HTMLInputElement).checked).toBe(true);
  });

  describe("пробная сводка", () => {
    it("кнопка вызывает ручку и показывает результат строкой", async () => {
      sendTestDigest.mockResolvedValue({ sent: true, items: 3 });
      render(<SettingsNotificationsPage />);

      const button = await screen.findByRole("button", { name: "Прислать пробную сводку сейчас" });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);

      expect(await screen.findByText("Письмо отправлено на client@example.ru, строк в нём: 3.")).toBeTruthy();
      expect(sendTestDigest).toHaveBeenCalledTimes(1);
    });

    it("не отправлено — показана причина от сервера", async () => {
      sendTestDigest.mockResolvedValue({ sent: false, items: 0, reason: "Сейчас сообщить нечего." });
      render(<SettingsNotificationsPage />);

      const button = await screen.findByRole("button", { name: "Прислать пробную сводку сейчас" });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);

      expect(await screen.findByText("Сейчас сообщить нечего.")).toBeTruthy();
    });

    it("сбой запроса — сообщение ошибки на экране, страница не падает", async () => {
      sendTestDigest.mockRejectedValue(new Error("Слишком часто. Подождите немного и повторите."));
      render(<SettingsNotificationsPage />);

      const button = await screen.findByRole("button", { name: "Прислать пробную сводку сейчас" });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);

      expect(await screen.findByText("Слишком часто. Подождите немного и повторите.")).toBeTruthy();
    });

    it("не вошёл: кнопка недоступна, предложено войти", async () => {
      me.mockResolvedValue({ user: null, loginEnabled: true });
      render(<SettingsNotificationsPage />);

      const button = await screen.findByRole("button", { name: "Прислать пробную сводку сейчас" });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("link", { name: "Войдите" }).getAttribute("href")).toBe("/login");
    });
  });
});
