import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchProfile } from "@/domain/entities";
import { demandReporter, getVisitorId } from "@/services/demandReporter";

/**
 * Отчёт браузера о темах, которые ждёт посетитель.
 *
 * Сервер собирает закупки по этим темам, поэтому отчёт уходит при изменении
 * профилей и раз в полсуток для «я ещё здесь» (тема, которую не открывали две
 * недели, перестаёт собираться). Сбой отчёта не мешает работе страницы.
 */

function profile(over: Partial<SearchProfile> = {}): SearchProfile {
  return {
    id: "sp-1",
    name: "Юристы",
    laws: ["FZ_44"],
    keywords: ["юрист"],
    stopWords: ["юридический адрес"],
    okpd2Codes: ["69.10"],
    regions: ["Москва"],
    customerInns: [],
    minPrice: 100,
    maxPrice: 900,
    onlyOpenForSubmission: true,
    enabled: true,
    ...over,
  };
}

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-05T12:00:00Z");

function ok(): Response {
  return new Response(JSON.stringify({ topics: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ok()));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getVisitorId", () => {
  it("создаёт идентификатор, пригодный серверу, и держит его между вызовами", () => {
    const first = getVisitorId();

    expect(first).toMatch(/^[A-Za-z0-9-]{16,64}$/);
    expect(getVisitorId()).toBe(first);
  });
});

describe("demandReporter.report", () => {
  it("первый отчёт уходит; в нём слова, законы и регионы, без цен и стоп-слов", async () => {
    const sent = await demandReporter.report([profile()], T0);

    expect(sent).toBe(true);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body));
    expect(body.visitorId).toBe(getVisitorId());
    expect(body.profiles).toEqual([{ keywords: ["юрист"], laws: ["FZ_44"], regions: ["Москва"], enabled: true }]);
  });

  it("у профиля нет региона — берутся приоритетные регионы компании", async () => {
    localStorage.setItem(
      "tf.companyProfile",
      JSON.stringify({ preferences: { priorityRegions: ["Республика Бурятия"] } }),
    );

    await demandReporter.report([profile({ regions: [] })], T0);

    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body));
    expect(body.profiles[0].regions).toEqual(["Республика Бурятия"]);
  });

  it("изменился регион — отправляется сразу", async () => {
    await demandReporter.report([profile()], T0);

    const again = await demandReporter.report([profile({ regions: ["Республика Бурятия"] })], T0 + HOUR);

    expect(again).toBe(true);
  });

  it("то же самое в течение полусуток не повторяется", async () => {
    await demandReporter.report([profile()], T0);

    const again = await demandReporter.report([profile()], T0 + 11 * HOUR);

    expect(again).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("спустя полсуток то же самое отправляется снова: так тема остаётся живой", async () => {
    await demandReporter.report([profile()], T0);

    const again = await demandReporter.report([profile()], T0 + 13 * HOUR);

    expect(again).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("изменились слова — отправляется сразу", async () => {
    await demandReporter.report([profile()], T0);

    const again = await demandReporter.report([profile({ keywords: ["юрист", "адвокат"] })], T0 + HOUR);

    expect(again).toBe(true);
  });

  it("изменилась только цена — не отправляется: сборщику она не нужна", async () => {
    await demandReporter.report([profile()], T0);

    const again = await demandReporter.report([profile({ minPrice: 5 })], T0 + HOUR);

    expect(again).toBe(false);
  });

  it("сбой сервера не бросает исключение и не считается отправленным", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "нет" }), { status: 503, headers: { "Content-Type": "application/json" } }),
    );

    await expect(demandReporter.report([profile()], T0)).resolves.toBe(false);
    const retry = await demandReporter.report([profile()], T0 + 1000);

    expect(retry).toBe(true);
  });

  it("профилей нет и раньше не отправляли — молчим: сообщать нечего", async () => {
    expect(await demandReporter.report([], T0)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("профили были и пропали — отправляется пустой список, чтобы снять темы", async () => {
    await demandReporter.report([profile()], T0);

    const again = await demandReporter.report([], T0 + HOUR);

    expect(again).toBe(true);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[1]?.[1] as RequestInit).body));
    expect(body.profiles).toEqual([]);
  });
});
