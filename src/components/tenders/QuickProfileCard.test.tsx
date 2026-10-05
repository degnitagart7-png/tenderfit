import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickProfileCard } from "@/components/tenders/QuickProfileCard";
import { STORAGE_KEYS } from "@/lib/storage";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";

/**
 * Первый вход без профиля поиска.
 *
 * Раньше человек без профиля видел всю общую базу — закупки, собранные под
 * чужие профили (у владельца — стройка в Бурятии). Теперь лента сначала
 * спрашивает, что он ищет: слова и регион сохраняются его профилем, сервер
 * узнаёт о теме, и сразу запускается поиск на площадках по его региону.
 */

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/api/search/live") ? answer({ jobId: "j1", status: "pending" }) : answer({ topics: 1 }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fill(words: string, region = "") {
  fireEvent.change(screen.getByLabelText("Что ищете"), { target: { value: words } });
  if (region !== "") fireEvent.change(screen.getByLabelText("Регион"), { target: { value: region } });
}

describe("QuickProfileCard", () => {
  it("без слов кнопка неактивна", () => {
    render(<QuickProfileCard onSaved={vi.fn()} onShowAll={vi.fn()} />);

    expect((screen.getByRole("button", { name: /искать/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("сохраняет профиль из слов через запятую и региона", async () => {
    const onSaved = vi.fn();
    render(<QuickProfileCard onSaved={onSaved} onShowAll={vi.fn()} />);
    fill("ремонт кровли, фасадные работы", "Республика Бурятия");

    fireEvent.click(screen.getByRole("button", { name: /искать/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [saved] = searchProfileRepository.getAll();
    expect(saved?.keywords).toEqual(["ремонт кровли", "фасадные работы"]);
    expect(saved?.regions).toEqual(["Республика Бурятия"]);
    expect(saved?.enabled).toBe(true);
  });

  it("без региона берётся приоритетный регион компании", async () => {
    localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify({ preferences: { priorityRegions: ["Москва"] } }));
    render(<QuickProfileCard onSaved={vi.fn()} onShowAll={vi.fn()} />);

    expect((screen.getByLabelText("Регион") as HTMLInputElement).value).toBe("Москва");
  });

  it("сразу запускает поиск на площадках: первое слово — запрос, остальные — дополнительные, с регионом", async () => {
    render(<QuickProfileCard onSaved={vi.fn()} onShowAll={vi.fn()} />);
    fill("ремонт кровли, фасадные работы", "Республика Бурятия");

    fireEvent.click(screen.getByRole("button", { name: /искать/i }));

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "/api/search/live")).toBe(true),
    );
    const live = vi.mocked(fetch).mock.calls.find((c) => String(c[0]) === "/api/search/live");
    expect(JSON.parse(String((live?.[1] as RequestInit).body))).toEqual({
      query: "ремонт кровли",
      regions: ["Республика Бурятия"],
      keywords: ["фасадные работы"],
    });
  });

  it("сервер занят — профиль всё равно сохранён, человеку объяснено", async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes("/api/search/live")
        ? answer({ error: "Сервер сейчас ищет другой запрос. Повторите примерно через 3 минуты." }, 429)
        : answer({ topics: 1 }),
    );
    const onSaved = vi.fn();
    render(<QuickProfileCard onSaved={onSaved} onShowAll={vi.fn()} />);
    fill("ремонт кровли");

    fireEvent.click(screen.getByRole("button", { name: /искать/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(searchProfileRepository.getAll()).toHaveLength(1);
  });

  it("«Показать всю базу» — явный выбор человека", () => {
    const onShowAll = vi.fn();
    render(<QuickProfileCard onSaved={vi.fn()} onShowAll={onShowAll} />);

    fireEvent.click(screen.getByRole("button", { name: /всю базу/i }));

    expect(onShowAll).toHaveBeenCalled();
  });
});
