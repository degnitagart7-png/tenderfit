import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchProfile } from "@/domain/entities";
import { STORAGE_KEYS, readDeviceOwner, writeDeviceOwner, writeJSON } from "@/lib/storage";
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

const OWNER = "ivan@firma.ru";

/** Ответ /api/auth/me: кто вошёл. */
function meAnswer(email = OWNER): Response {
  return answer({ user: { email }, loginEnabled: true });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  localStorage.clear();
  // По умолчанию на устройстве данные того, кто входит: слияние, как раньше.
  writeDeviceOwner(OWNER);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accountSync.onSignedIn", () => {
  it("на сервере пусто — профили устройства уходят на сервер", async () => {
    searchProfileRepository.save([sp("Локальный")]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer())
      .mockResolvedValueOnce(answer({ searchProfiles: [], companyProfile: null }))
      .mockResolvedValueOnce(answer({ saved: true }));

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: false });
    const put = vi.mocked(fetch).mock.calls[2];
    expect((put?.[1] as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((put?.[1] as RequestInit).body)).searchProfiles[0].name).toBe("Локальный");
  });

  it("на устройстве пусто — профили аккаунта записываются на устройство", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer())
      .mockResolvedValueOnce(answer({ searchProfiles: [sp("Серверный")], companyProfile: { name: "ООО Ромашка" } }));

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: true });
    expect(searchProfileRepository.getAll().map((p) => p.name)).toEqual(["Серверный"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.profile) ?? "null")).toEqual({ name: "ООО Ромашка" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("и там и там есть профили — объединение уходит и туда и туда", async () => {
    searchProfileRepository.save([sp("Локальный")]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer())
      .mockResolvedValueOnce(answer({ searchProfiles: [sp("Серверный")], companyProfile: null }))
      .mockResolvedValueOnce(answer({ saved: true }));

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: true });
    expect(searchProfileRepository.getAll().map((p) => p.name).sort()).toEqual(["Локальный", "Серверный"]);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[2]?.[1] as RequestInit).body));
    expect(body.searchProfiles).toHaveLength(2);
  });

  it("сбой сервера не трогает данные устройства", async () => {
    searchProfileRepository.save([sp("Локальный")]);
    vi.mocked(fetch).mockResolvedValueOnce(meAnswer()).mockResolvedValueOnce(answer({ error: "недоступно" }, 503));

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
      .mockResolvedValueOnce(meAnswer())
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

describe("accountSync: остальные данные аккаунта", () => {
  it("вход на новом устройстве: отметка онбординга и воронка приходят из аккаунта", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(meAnswer()).mockResolvedValueOnce(
      answer({
        searchProfiles: [],
        companyProfile: { name: "ООО Ромашка" },
        appState: {
          onboardingDone: true,
          pipeline: { t1: { tenderId: "t1", status: "APPLIED", updatedAt: "2026-10-05T10:00:00Z", note: null } },
        },
      }),
    );

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: true });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.onboardingDone) ?? "null")).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pipeline) ?? "{}").t1.status).toBe("APPLIED");
  });

  it("на устройстве пройден онбординг и есть воронка — они уходят в аккаунт", async () => {
    localStorage.setItem(STORAGE_KEYS.onboardingDone, "true");
    localStorage.setItem(
      STORAGE_KEYS.pipeline,
      JSON.stringify({ t1: { tenderId: "t1", status: "REVIEW", updatedAt: "2026-10-05T10:00:00Z", note: null } }),
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer())
      .mockResolvedValueOnce(answer({ searchProfiles: [], companyProfile: null }))
      .mockResolvedValueOnce(answer({ saved: true }));

    await accountSync.onSignedIn();

    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[2]?.[1] as RequestInit).body));
    expect(body.appState.onboardingDone).toBe(true);
    expect(body.appState.pipeline.t1.status).toBe("REVIEW");
  });

  it("автоотправка: изменение воронки на устройстве уходит на сервер одним запросом", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(meAnswer()).mockResolvedValue(answer({ saved: true }));
    const stop = accountSync.startAutoPush();
    try {
      localStorage.setItem(STORAGE_KEYS.pipeline, "{}");
      writeJSON(STORAGE_KEYS.pipeline, { t1: { tenderId: "t1", status: "NEW", updatedAt: "x", note: null } });
      writeJSON(STORAGE_KEYS.settings, { sendTime: "09:00" });
      await vi.runAllTimersAsync();

      expect(fetch).toHaveBeenCalledTimes(2);
      const body = JSON.parse(String((vi.mocked(fetch).mock.calls[1]?.[1] as RequestInit).body));
      expect(body.appState.digestSettings).toEqual({ sendTime: "09:00" });
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("автоотправка не реагирует на запись данных аккаунта при слиянии", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer())
      .mockResolvedValueOnce(answer({ searchProfiles: [], companyProfile: null, appState: { onboardingDone: true } }));
    const stop = accountSync.startAutoPush();
    try {
      await accountSync.onSignedIn();
      await vi.runAllTimersAsync();

      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});


describe("accountSync: данные устройства принадлежат аккаунту", () => {
  /** Данные прошлого человека в браузере: профили, анкета, воронка, кэши и правки ведомости. */
  function seedPreviousUser(): void {
    searchProfileRepository.save([sp("Чужой профиль")]);
    localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify({ name: "ООО Чужая" }));
    localStorage.setItem(STORAGE_KEYS.onboardingDone, "true");
    localStorage.setItem(
      STORAGE_KEYS.pipeline,
      JSON.stringify({ t9: { tenderId: "t9", status: "APPLIED", updatedAt: "2026-10-05T10:00:00Z", note: null } }),
    );
    localStorage.setItem(STORAGE_KEYS.jobs, "[]");
    localStorage.setItem(STORAGE_KEYS.pdConsent, JSON.stringify({ accepted: true }));
    localStorage.setItem("tf.billEdits:t9", "{}");
    localStorage.setItem("tenderfit.lastSearch", "{}");
    // Настройка самого устройства переживает смену владельца.
    localStorage.setItem("tf.estimate.lastZone", "5");
  }

  function putCalls(): unknown[] {
    return vi.mocked(fetch).mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT");
  }

  /** `restored` — ключи, которые вход заново записал данными аккаунта. */
  function expectPreviousUserGone(restored: string[] = []): void {
    expect(searchProfileRepository.getAll().map((p) => p.name)).not.toContain("Чужой профиль");
    for (const key of [
      STORAGE_KEYS.profile,
      STORAGE_KEYS.onboardingDone,
      STORAGE_KEYS.pipeline,
      STORAGE_KEYS.jobs,
      STORAGE_KEYS.pdConsent,
      "tf.billEdits:t9",
      "tenderfit.lastSearch",
    ].filter((key) => !restored.includes(key))) {
      expect(localStorage.getItem(key), key).toBeNull();
    }
    expect(JSON.stringify(localStorage)).not.toContain("Чужая");
    expect(JSON.stringify(localStorage)).not.toContain("t9");
    expect(localStorage.getItem("tf.estimate.lastZone")).toBe("5");
  }

  it("чужая метка: данные устройства стираются, аккаунт записывается как есть, чужое на сервер не уходит", async () => {
    seedPreviousUser();
    writeDeviceOwner("owner@firma.ru");
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer("New@Firma.ru"))
      .mockResolvedValueOnce(
        answer({ searchProfiles: [sp("Свой")], companyProfile: { name: "ООО Новая" }, appState: { onboardingDone: false } }),
      );

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: true });
    expectPreviousUserGone([STORAGE_KEYS.profile, STORAGE_KEYS.onboardingDone]);
    expect(searchProfileRepository.getAll().map((p) => p.name)).toEqual(["Свой"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.profile) ?? "null")).toEqual({ name: "ООО Новая" });
    expect(readDeviceOwner()).toBe("new@firma.ru");
    expect(putCalls()).toHaveLength(0);
  });

  it("чужая метка и пустой аккаунт: устройство пустое, на сервер ничего не уходит", async () => {
    seedPreviousUser();
    writeDeviceOwner("owner@firma.ru");
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer("new@firma.ru"))
      .mockResolvedValueOnce(answer({ searchProfiles: [], companyProfile: null, appState: {} }));

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: true });
    expectPreviousUserGone();
    expect(searchProfileRepository.getAll()).toEqual([]);
    expect(readDeviceOwner()).toBe("new@firma.ru");
    expect(putCalls()).toHaveLength(0);
  });

  it("метки нет: данные устройства считаются чужими — так же, как при чужой метке", async () => {
    seedPreviousUser();
    localStorage.removeItem(STORAGE_KEYS.deviceOwner);
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer("new@firma.ru"))
      .mockResolvedValueOnce(answer({ searchProfiles: [], companyProfile: null, appState: {} }));

    await accountSync.onSignedIn();

    expectPreviousUserGone();
    expect(readDeviceOwner()).toBe("new@firma.ru");
    expect(putCalls()).toHaveLength(0);
  });

  it("сбой сервера при чужой метке: устройство не трогаем и метку не ставим", async () => {
    seedPreviousUser();
    writeDeviceOwner("owner@firma.ru");
    vi.mocked(fetch).mockResolvedValueOnce(meAnswer("new@firma.ru")).mockResolvedValueOnce(answer({ error: "x" }, 503));

    const result = await accountSync.onSignedIn();

    expect(result).toEqual({ deviceChanged: false });
    expect(readDeviceOwner()).toBe("owner@firma.ru");
    expect(searchProfileRepository.getAll().map((p) => p.name)).toEqual(["Чужой профиль"]);
  });

  it("та же метка (почта в другом регистре): слияние, как раньше", async () => {
    searchProfileRepository.save([sp("Локальный")]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer("IVAN@firma.ru"))
      .mockResolvedValueOnce(answer({ searchProfiles: [sp("Серверный")], companyProfile: null }))
      .mockResolvedValueOnce(answer({ saved: true }));

    await accountSync.onSignedIn();

    expect(searchProfileRepository.getAll().map((p) => p.name).sort()).toEqual(["Локальный", "Серверный"]);
    expect(putCalls()).toHaveLength(1);
  });

  it("отложенная отправка после чужого входа несёт только данные нового аккаунта", async () => {
    vi.useFakeTimers();
    seedPreviousUser();
    writeDeviceOwner("owner@firma.ru");
    vi.mocked(fetch)
      .mockResolvedValueOnce(meAnswer("new@firma.ru"))
      .mockResolvedValueOnce(answer({ searchProfiles: [sp("Свой")], companyProfile: null, appState: {} }));
    const stop = accountSync.startAutoPush();
    try {
      // Правка до входа поставила отправку в очередь; метка в этот момент чужая.
      writeJSON(STORAGE_KEYS.pipeline, { t9: { tenderId: "t9", status: "NEW", updatedAt: "x", note: null } });
      await accountSync.onSignedIn();
      await vi.runAllTimersAsync();

      // Очередь могла сработать уже после входа — тогда уходит то, что пришло с сервера, не чужое.
      for (const call of putCalls()) {
        const body = String(((call as unknown[])[1] as RequestInit).body);
        expect(body).not.toContain("Чужой профиль");
        expect(body).not.toContain("t9");
        expect(body).toContain("Свой");
      }
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("метка чужая, а вошёл другой: автоотправка до слияния ничего не отправляет", async () => {
    vi.useFakeTimers();
    writeDeviceOwner("owner@firma.ru");
    vi.mocked(fetch).mockResolvedValueOnce(meAnswer("new@firma.ru"));
    const stop = accountSync.startAutoPush();
    try {
      writeJSON(STORAGE_KEYS.pipeline, { t9: { tenderId: "t9", status: "NEW", updatedAt: "x", note: null } });
      await vi.runAllTimersAsync();

      expect(putCalls()).toHaveLength(0);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("без метки владельца автоотправка молчит: чужие данные не должны уйти в аккаунт", async () => {
    vi.useFakeTimers();
    localStorage.removeItem(STORAGE_KEYS.deviceOwner);
    vi.mocked(fetch).mockResolvedValue(meAnswer());
    const stop = accountSync.startAutoPush();
    try {
      writeJSON(STORAGE_KEYS.pipeline, { t1: { tenderId: "t1", status: "NEW", updatedAt: "x", note: null } });
      await vi.runAllTimersAsync();

      expect(putCalls()).toHaveLength(0);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});

describe("accountSync.onSignedOut", () => {
  it("выход стирает данные аккаунта и метку, настройки устройства остаются", () => {
    searchProfileRepository.save([sp("Мой")]);
    localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify({ name: "ООО" }));
    localStorage.setItem(STORAGE_KEYS.pipeline, "{}");
    localStorage.setItem(STORAGE_KEYS.onboardingDraft, "{}");
    localStorage.setItem(STORAGE_KEYS.savedFilters, "{}");
    localStorage.setItem(STORAGE_KEYS.syncSnapshot, "{}");
    localStorage.setItem(STORAGE_KEYS.manualReviews, "[]");
    localStorage.setItem(STORAGE_KEYS.importedTenders, "[]");
    localStorage.setItem(STORAGE_KEYS.pdConsent, "{}");
    localStorage.setItem("tf.billEdits:t1", "{}");
    localStorage.setItem("tenderfit.adminToken", "секрет");
    localStorage.setItem("tenderfit.visitorId", "abc");

    accountSync.onSignedOut();

    expect(readDeviceOwner()).toBeNull();
    expect(searchProfileRepository.getAll()).toEqual([]);
    for (const key of [
      STORAGE_KEYS.profile,
      STORAGE_KEYS.pipeline,
      STORAGE_KEYS.onboardingDraft,
      STORAGE_KEYS.savedFilters,
      STORAGE_KEYS.syncSnapshot,
      STORAGE_KEYS.manualReviews,
      STORAGE_KEYS.importedTenders,
      STORAGE_KEYS.pdConsent,
      "tf.billEdits:t1",
      "tenderfit.adminToken",
    ]) {
      expect(localStorage.getItem(key), key).toBeNull();
    }
    expect(localStorage.getItem("tenderfit.visitorId")).toBe("abc");
  });

  it("выход отключает автоотправку, а очистка не считается правкой и на сервер не уходит", async () => {
    vi.useFakeTimers();
    accountSync.startAutoPush();
    try {
      writeJSON(STORAGE_KEYS.pipeline, { t1: { tenderId: "t1", status: "NEW", updatedAt: "x", note: null } });
      accountSync.onSignedOut();
      await vi.runAllTimersAsync();

      expect(fetch).not.toHaveBeenCalled();
      // Подписка снята: новая запись тоже никуда не уходит.
      writeDeviceOwner(OWNER);
      writeJSON(STORAGE_KEYS.pipeline, {});
      await vi.runAllTimersAsync();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
