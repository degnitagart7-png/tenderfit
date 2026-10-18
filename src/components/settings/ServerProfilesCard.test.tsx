import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerProfilesCard } from "@/components/settings/ServerProfilesCard";
import type { SearchProfile } from "@/domain/entities";

/**
 * Отправка профилей на сервер.
 *
 * Сервер собирает закупки только по тем профилям, которые ему отправили, поэтому
 * человек должен видеть, что отправлено, а что пропущено, и получить понятный
 * ответ, если ключ неверен или выключен.
 */

function profile(over: Partial<SearchProfile> = {}): SearchProfile {
  return {
    id: "sp-1",
    name: "Юристы",
    laws: ["FZ_44"],
    keywords: ["юрист"],
    stopWords: [],
    okpd2Codes: [],
    regions: [],
    customerInns: [],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: true,
    enabled: true,
    ...over,
  };
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillToken(value: string) {
  fireEvent.change(screen.getByLabelText(/ключ владельца/i), { target: { value } });
}

describe("ServerProfilesCard", () => {
  it("без ключа кнопка неактивна", () => {
    render(<ServerProfilesCard profiles={[profile()]} />);

    expect((screen.getByRole("button", { name: /отправить на сервер/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("нет профилей — кнопка неактивна", () => {
    render(<ServerProfilesCard profiles={[]} />);
    fillToken("owner-key-12345");

    expect((screen.getByRole("button", { name: /отправить на сервер/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("отправляет профили с ключом и сообщает число", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ saved: 1 }));
    render(<ServerProfilesCard profiles={[profile()]} />);
    fillToken("owner-key-12345");

    fireEvent.click(screen.getByRole("button", { name: /отправить на сервер/i }));

    expect(await screen.findByText(/отправлено профилей: 1/i)).toBeTruthy();
    const call = vi.mocked(fetch).mock.calls[0];
    expect(String(call?.[0])).toBe("/api/sync-profiles");
    expect((call?.[1] as RequestInit).method).toBe("PUT");
    expect(((call?.[1] as RequestInit).headers as Record<string, string>)["x-admin-token"]).toBe("owner-key-12345");
    expect(JSON.parse(String((call?.[1] as RequestInit).body)).profiles[0].name).toBe("Юристы");
  });

  it("ответ называет регионы сбора: «вся Россия» не должна получаться молча", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ saved: 1 }));
    render(<ServerProfilesCard profiles={[profile({ regions: ["Республика Бурятия"] })]} />);
    fillToken("owner-key-12345");

    fireEvent.click(screen.getByRole("button", { name: /отправить на сервер/i }));

    expect(await screen.findByText(/Регионы сбора: «Юристы» — Республика Бурятия/)).toBeTruthy();
  });

  it("у профиля нет региона, у компании есть приоритетный — уходит он", async () => {
    localStorage.setItem("tf.companyProfile", JSON.stringify({ preferences: { priorityRegions: ["Республика Бурятия"] } }));
    vi.mocked(fetch).mockResolvedValue(answer({ saved: 1 }));
    render(<ServerProfilesCard profiles={[profile({ regions: [] })]} />);
    fillToken("owner-key-12345");

    fireEvent.click(screen.getByRole("button", { name: /отправить на сервер/i }));

    await screen.findByText(/Регионы сбора/);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body));
    expect(body.profiles[0].regions).toEqual(["Республика Бурятия"]);
  });

  it("пропущенный профиль без слов назван в ответе", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ saved: 1 }));
    render(<ServerProfilesCard profiles={[profile(), profile({ id: "sp-2", name: "Пустой", keywords: [] })]} />);
    fillToken("owner-key-12345");

    fireEvent.click(screen.getByRole("button", { name: /отправить на сервер/i }));

    expect(await screen.findByText(/не отправлены.*Пустой/i)).toBeTruthy();
  });

  it("неверный ключ — слова сервера, а не молчание", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ error: "Неверный ключ владельца." }, 401));
    render(<ServerProfilesCard profiles={[profile()]} />);
    fillToken("wrong-key-123456");

    fireEvent.click(screen.getByRole("button", { name: /отправить на сервер/i }));

    expect(await screen.findByText(/неверный ключ владельца/i)).toBeTruthy();
  });

  it("ключ запоминается в браузере для следующего раза", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ saved: 1 }));
    render(<ServerProfilesCard profiles={[profile()]} />);
    fillToken("owner-key-12345");
    fireEvent.click(screen.getByRole("button", { name: /отправить на сервер/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await screen.findByText(/отправлено профилей/i);
    cleanup();

    render(<ServerProfilesCard profiles={[profile()]} />);

    expect((screen.getByLabelText(/ключ владельца/i) as HTMLInputElement).value).toBe("owner-key-12345");
  });
});
