import { describe, expect, it } from "vitest";

import {
  DEFAULT_SLOW_TRACK_INTERVAL_HOURS,
  decideTrack,
  slowTrackIntervalHours,
  tracksFor,
} from "@/domain/sourceCadence";

const NOW = "2026-10-04T12:00:00.000Z";
const hoursAgo = (hours: number) =>
  new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

/**
 * Два трека опроса: быстрый и медленный.
 *
 * Росэлторг и Фабрикант тратят на каждую процедуру отдельный запрос карточки:
 * в прогоне 03.10.2026 они заняли 86 секунд из 280, а у Фабриканта на хосте
 * документов ещё и `Crawl-delay: 3`. Опрашивать их каждые два часа — значит
 * ходить на чужие площадки втрое чаще, чем ходит остальной прогон, ради
 * свежести, которой лента не использует: закупки живут сутками.
 *
 * Правило устроено как у Контур.Закупок (`decideKonturSync`): отсчёт от времени
 * последней записи источника, а не от часа суток. Плановое задание может
 * стоять на нечётных часах, и привязка к «hour % 6» не сработала бы ни разу.
 */
describe("decideTrack", () => {
  it("записей источника не было — опрашиваем", () => {
    expect(decideTrack({ lastStoredAt: null, now: NOW, minIntervalHours: 6 }).poll).toBe(true);
  });

  it("недавно записывали — пропускаем и называем срок", () => {
    const decision = decideTrack({ lastStoredAt: hoursAgo(2), now: NOW, minIntervalHours: 6 });

    expect(decision.poll).toBe(false);
    expect(decision.reason).toContain("2,0 ч назад");
    expect(decision.reason).toContain("6,0 ч");
  });

  it("интервал прошёл — опрашиваем", () => {
    expect(decideTrack({ lastStoredAt: hoursAgo(7), now: NOW, minIntervalHours: 6 }).poll).toBe(true);
  });

  /*
    Запись источника ставится в конце прогона, а следующий плановый запуск
    отсчитывается от его начала. Прогон идёт до пяти минут, поэтому ровно через
    три тика (6 ч) от записи прошло 5 ч 55 мин. Без допуска этот источник
    опрашивался бы не каждые 6 часов, а каждые 8: третий тик пропускался бы на
    пять минут.
  */
  it("пять минут до срока не откладывают опрос на следующий тик", () => {
    const decision = decideTrack({ lastStoredAt: hoursAgo(6 - 5 / 60), now: NOW, minIntervalHours: 6 });

    expect(decision.poll).toBe(true);
  });

  it("а час до срока — откладывают", () => {
    expect(decideTrack({ lastStoredAt: hoursAgo(5), now: NOW, minIntervalHours: 6 }).poll).toBe(false);
  });

  it("интервал ноль отключает трек: опрашиваем каждый прогон", () => {
    expect(decideTrack({ lastStoredAt: hoursAgo(0.1), now: NOW, minIntervalHours: 0 }).poll).toBe(true);
  });

  it("нечитаемая метка трактуется как «опрашивать»: лента не должна молча замереть", () => {
    expect(decideTrack({ lastStoredAt: "не дата", now: NOW, minIntervalHours: 6 }).poll).toBe(true);
  });

  it("метка из будущего (разошлись часы) не выглядит как «давно»", () => {
    const decision = decideTrack({
      lastStoredAt: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
      now: NOW,
      minIntervalHours: 6,
    });

    expect(decision.poll).toBe(false);
  });
});

describe("slowTrackIntervalHours", () => {
  it("по умолчанию шесть часов, как у платного источника", () => {
    expect(slowTrackIntervalHours(undefined)).toBe(DEFAULT_SLOW_TRACK_INTERVAL_HOURS);
    expect(DEFAULT_SLOW_TRACK_INTERVAL_HOURS).toBe(6);
  });

  it("берёт число из переменной окружения", () => {
    expect(slowTrackIntervalHours("12")).toBe(12);
    expect(slowTrackIntervalHours("1,5")).toBe(1.5);
  });

  it("ноль отключает интервал", () => {
    expect(slowTrackIntervalHours("0")).toBe(0);
  });

  it("мусор и отрицательное значение — значение по умолчанию", () => {
    expect(slowTrackIntervalHours("часто")).toBe(6);
    expect(slowTrackIntervalHours("-3")).toBe(6);
    expect(slowTrackIntervalHours("")).toBe(6);
  });
});

/**
 * Кому какой режим: плановому запуску — только подошедшие треки, человеку — все.
 *
 * Кнопка «Запустить прогон» ставит задание в очередь, и ответ на неё люди
 * ждут минутами: если бы она тоже пропускала медленный трек, партнёр нажал бы
 * её за свежим и получил ленту без Росэлторга и Фабриканта, не понимая почему.
 */
describe("tracksFor", () => {
  it("плановый тик опрашивает только подошедшие треки", () => {
    expect(tracksFor("scheduled")).toBe("due");
  });

  it("задание из очереди (кнопка) опрашивает все", () => {
    expect(tracksFor("queued")).toBe("all");
  });

  it("ручной запуск с --full-sync опрашивает все", () => {
    expect(tracksFor("manual")).toBe("all");
  });
});
