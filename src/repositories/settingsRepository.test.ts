import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "@/lib/storage";
import { defaultDigestSettings, settingsRepository } from "@/repositories/settingsRepository";

const zone = (name: string): void => {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: name } as Intl.ResolvedDateTimeFormatOptions);
};
const stored = (): Record<string, unknown> => JSON.parse(window.localStorage.getItem(STORAGE_KEYS.settings) ?? "{}") as Record<string, unknown>;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
});

describe("settingsRepository", () => {
  it("ничего не сохранено — значения по умолчанию: сводка и письмо о готовности включены", () => {
    expect(settingsRepository.get()).toEqual(defaultDigestSettings);
    expect(defaultDigestSettings).toMatchObject({ enabled: true, sendTime: "08:00", readyEnabled: true });
  });

  it("старое сохранение дополняется значениями по умолчанию, его поля не теряются", () => {
    window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({ enabled: false, sendTime: "10:00", minFitScore: 80 }));

    expect(settingsRepository.get()).toMatchObject({ enabled: false, sendTime: "10:00", minFitScore: 80, readyEnabled: true });
  });

  it("ensureTimeZone: пояса нет — сохраняется пояс браузера, остальные настройки целы", () => {
    zone("Asia/Irkutsk");
    window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({ enabled: false, sendTime: "10:00", minFitScore: 80 }));

    expect(settingsRepository.ensureTimeZone()).toBe("Asia/Irkutsk");
    expect(stored()).toMatchObject({ timeZone: "Asia/Irkutsk", enabled: false, sendTime: "10:00", minFitScore: 80 });
  });

  it("ensureTimeZone: заданный пояс не трогает; повторный вызов ничего не пишет", () => {
    zone("Asia/Irkutsk");
    window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({ ...defaultDigestSettings, timeZone: "Asia/Yakutsk" }));

    expect(settingsRepository.ensureTimeZone()).toBeNull();
    expect(stored()["timeZone"]).toBe("Asia/Yakutsk");
  });

  it("ensureTimeZone: пояс браузера неизвестен — ничего не сохраняется", () => {
    zone("");
    expect(settingsRepository.ensureTimeZone()).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.settings)).toBeNull();
  });

  it("ensureTimeZone: испорченный пояс в настройках заменяется поясом браузера", () => {
    zone("Asia/Omsk");
    window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({ ...defaultDigestSettings, timeZone: "Mars/Olympus" }));

    expect(settingsRepository.ensureTimeZone()).toBe("Asia/Omsk");
  });
});
