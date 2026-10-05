import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchProfile } from "@/domain/entities";
import { STORAGE_KEYS } from "@/lib/storage";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { accountSync } from "@/services/accountSync";

/**
 * Синхронизация профилей и анкеты с аккаунтом.
 *
 * При входе данные устройства и аккаунта сливаются без потерь, а после этого
 * каждое сохранение профилей уходит на сервер, чтобы на другом устройстве они
 * были такими же.
 */

function sp(name: string): SearchProfile {
  return {
    id: `id-${name}`,
    name,
    laws: ["FZ_44"],
    keywords: ["слово"],
    stopWords: [],
    okpd2Codes: [],
    regions: [],
    customerInns: [],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: true,
    enabled: true,
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
  vi.unstubAllGlobals();
});

describe("accountSync.onSignedIn", () => {
  it("на сервере пусто — профили устройства уходят на сервер", async () => {
    searchProfileRepository.save([sp("Локальный")]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer({ searchProfiles: [], companyProfile: null }))
      .mockResolvedValueOnce(answer({ saved: true }));

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: false });
    const put = vi.mocked(fetch).mock.calls[1];
    expect((put?.[1] as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((put?.[1] as RequestInit).body)).searchProfiles[0].name).toBe("Локальный");
  });

  it("на устройстве пусто — профили аккаунта записываются на устройство", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      answer({ searchProfiles: [sp("Серверный")], companyProfile: { name: "ООО Ромашка" } }),
    );

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: true });
    expect(searchProfileRepository.getAll().map((p) => p.name)).toEqual(["Серверный"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.profile) ?? "null")).toEqual({ name: "ООО Ромашка" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("и там и там есть профили — объединение уходит и туда и туда", async () => {
    searchProfileRepository.save([sp("Локальный")]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer({ searchProfiles: [sp("Серверный")], companyProfile: null }))
      .mockResolvedValueOnce(answer({ saved: true }));

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: true });
    expect(searchProfileRepository.getAll().map((p) => p.name).sort()).toEqual(["Локальный", "Серверный"]);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[1]?.[1] as RequestInit).body));
    expect(body.searchProfiles).toHaveLength(2);
  });

  it("сбой сервера не трогает данные устройства", async () => {
    searchProfileRepository.save([sp("Локальный")]);
    vi.mocked(fetch).mockResolvedValueOnce(answer({ error: "недоступно" }, 503));

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: false });
    expect(searchProfileRepository.getAll().map((p) => p.name)).toEqual(["Локальный"]);
  });
});

describe("accountSync.pushIfSignedIn", () => {
  it("гость: ничего не отправляется", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(answer({ user: null, loginEnabled: true }));

    await accountSync.pushIfSignedIn();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("/api/auth/me");
  });

  it("вошедший: профили устройства уходят на сервер", async () => {
    searchProfileRepository.save([sp("А")]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer({ user: { email: "ivan@firma.ru" }, loginEnabled: true }))
      .mockResolvedValueOnce(answer({ saved: true }));

    await accountSync.pushIfSignedIn();

    const put = vi.mocked(fetch).mock.calls[1];
    expect(String(put?.[0])).toBe("/api/me/data");
    expect(JSON.parse(String((put?.[1] as RequestInit).body)).searchProfiles[0].name).toBe("А");
  });

  it("сбой не бросает исключение: сохранение профиля на устройстве уже прошло", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("сеть"));

    await expect(accountSync.pushIfSignedIn()).resolves.toBeUndefined();
  });
});
