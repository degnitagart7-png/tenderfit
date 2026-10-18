import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { QuickStart } from "@/components/onboarding/QuickStart";
import { PENDING_FIRST_SEARCH_KEY } from "@/domain/pendingFirstSearch";
import { STORAGE_KEYS } from "@/lib/storage";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";

/**
 * «Быстрый старт» вместо восьмишаговой анкеты: что делаете и где — и сразу лента
 * с туром; профиль компании человек заполнит потом.
 */

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  push.mockReset();
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

const words = () => screen.getByLabelText("Что вы делаете или поставляете");

describe("QuickStart", () => {
  it("без слов не сохраняет: подсказка, никуда не уходит", () => {
    render(<QuickStart />);
    fireEvent.click(screen.getByRole("button", { name: "Показать мои закупки" }));

    expect(screen.getByText(/без этого нечего искать/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    expect(searchProfileRepository.getAll().filter((p) => p.keywords.includes("ремонт кровли"))).toHaveLength(0);
  });

  it("слова → профиль поиска, описание компании, отметка онбординга, задание поиска ленте и переход с туром", async () => {
    render(<QuickStart />);
    fireEvent.change(words(), { target: { value: "ремонт кровли, фасадные работы" } });
    fireEvent.click(screen.getByRole("button", { name: "Показать мои закупки" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/tenders?tour=1"));
    const profile = searchProfileRepository.getAll().find((p) => p.keywords[0] === "ремонт кровли");
    expect(profile?.keywords).toEqual(["ремонт кровли", "фасадные работы"]);
    expect(companyProfileRepository.get().activityDescription).toBe("ремонт кровли, фасадные работы");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.onboardingDone) ?? "false")).toBe(true);
    const pending = JSON.parse(sessionStorage.getItem(PENDING_FIRST_SEARCH_KEY) ?? "null") as { jobId: string; queries: string[] };
    expect(pending.jobId).toBe("j1");
    expect(pending.queries).toEqual(["ремонт кровли", "фасадные работы"]);
  });

  it("заполненное описание компании не затирается", async () => {
    companyProfileRepository.save({ ...companyProfileRepository.get(), activityDescription: "Капремонт школ" });
    render(<QuickStart />);
    fireEvent.change(words(), { target: { value: "кровля" } });
    fireEvent.click(screen.getByRole("button", { name: "Показать мои закупки" }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(companyProfileRepository.get().activityDescription).toBe("Капремонт школ");
  });

  it("«Пропустить» — отметка онбординга и лента с туром, без профиля", () => {
    render(<QuickStart />);
    fireEvent.click(screen.getByRole("button", { name: /Пропустить/ }));

    expect(push).toHaveBeenCalledWith("/tenders?tour=1");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.onboardingDone) ?? "false")).toBe(true);
    expect(sessionStorage.getItem(PENDING_FIRST_SEARCH_KEY)).toBeNull();
  });
});
