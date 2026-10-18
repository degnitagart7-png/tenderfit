import { describe, expect, it } from "vitest";

import {
  TIME_ZONE_OPTIONS,
  isValidTimeZone,
  normalizeSendTime,
  resolveDigestSettings,
  timeZoneCity,
  timeZoneOption,
} from "@/domain/digestSettings";

describe("resolveDigestSettings", () => {
  it("ничего не сохранено — значения по умолчанию: сводка и письмо включены, 08:00, Москва, оценка 50", () => {
    for (const raw of [undefined, null, "строка", 5, [], {}]) {
      expect(resolveDigestSettings(raw)).toEqual({
        enabled: true,
        sendTime: "08:00",
        timeZone: "Europe/Moscow",
        readyEnabled: true,
        minFitScore: 50,
      });
    }
  });

  it("старые сохранённые настройки (без пояса и письма о готовности) читаются без потерь", () => {
    const old = { enabled: true, sendTime: "09:00", email: "demo@tenderfit.local", minFitScore: 70, urgentEnabled: true };

    expect(resolveDigestSettings(old)).toMatchObject({ sendTime: "09:00", minFitScore: 70, timeZone: "Europe/Moscow", readyEnabled: true });
  });

  it("выключенное остаётся выключенным: сводка и письмо о готовности отключаются независимо", () => {
    expect(resolveDigestSettings({ enabled: false })).toMatchObject({ enabled: false, readyEnabled: true });
    expect(resolveDigestSettings({ readyEnabled: false })).toMatchObject({ enabled: true, readyEnabled: false });
  });

  it("часовой пояс: верный сохраняется, неверный — Москва", () => {
    expect(resolveDigestSettings({ timeZone: "Asia/Irkutsk" }).timeZone).toBe("Asia/Irkutsk");
    expect(resolveDigestSettings({ timeZone: "Mars/Olympus" }).timeZone).toBe("Europe/Moscow");
    expect(resolveDigestSettings({ timeZone: "" }).timeZone).toBe("Europe/Moscow");
    expect(resolveDigestSettings({ timeZone: 3 }).timeZone).toBe("Europe/Moscow");
  });

  it("время: «8:30» приводится к «08:30», неверное — 08:00", () => {
    expect(resolveDigestSettings({ sendTime: "8:30" }).sendTime).toBe("08:30");
    expect(resolveDigestSettings({ sendTime: "25:00" }).sendTime).toBe("08:00");
    expect(resolveDigestSettings({ sendTime: "12:61" }).sendTime).toBe("08:00");
    expect(resolveDigestSettings({ sendTime: "утро" }).sendTime).toBe("08:00");
    expect(resolveDigestSettings({ sendTime: 8 }).sendTime).toBe("08:00");
  });

  it("порог оценки зажимается в 0–100, не число — 50", () => {
    expect(resolveDigestSettings({ minFitScore: 140 }).minFitScore).toBe(100);
    expect(resolveDigestSettings({ minFitScore: -5 }).minFitScore).toBe(0);
    expect(resolveDigestSettings({ minFitScore: "70" }).minFitScore).toBe(50);
    expect(resolveDigestSettings({ minFitScore: Number.NaN }).minFitScore).toBe(50);
  });
});

describe("проверки значений", () => {
  it("isValidTimeZone и normalizeSendTime", () => {
    expect(isValidTimeZone("Europe/Kaliningrad")).toBe(true);
    expect(isValidTimeZone("Nowhere/City")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(normalizeSendTime(" 07:00 ")).toBe("07:00");
    expect(normalizeSendTime("7")).toBeNull();
  });

  it("все пояса списка принимает Intl; список — от Калининграда до Камчатки, по возрастанию смещения", () => {
    expect(TIME_ZONE_OPTIONS.map((o) => o.value)).toEqual([
      "Europe/Kaliningrad",
      "Europe/Moscow",
      "Europe/Samara",
      "Asia/Yekaterinburg",
      "Asia/Omsk",
      "Asia/Krasnoyarsk",
      "Asia/Irkutsk",
      "Asia/Yakutsk",
      "Asia/Vladivostok",
      "Asia/Magadan",
      "Asia/Kamchatka",
    ]);
    for (const option of TIME_ZONE_OPTIONS) expect(isValidTimeZone(option.value)).toBe(true);
  });

  it("пояс браузера Новосибирска опознаётся как «Новосибирск, Красноярск»; незнакомый называется по IANA-имени", () => {
    expect(timeZoneOption("Asia/Novosibirsk")?.value).toBe("Asia/Krasnoyarsk");
    expect(timeZoneOption("Asia/Dubai")).toBeNull();
    expect(timeZoneCity("Asia/Irkutsk")).toBe("Иркутск");
    expect(timeZoneCity("Asia/Dubai")).toBe("Dubai");
    expect(timeZoneCity("America/New_York")).toBe("New York");
  });
});
