import type { SearchProfile } from "@/domain/entities";
import { readJsonOrThrow } from "@/lib/readJson";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";

/**
 * Отчёт браузера о темах, которые ждёт посетитель.
 *
 * Сервер собирает закупки по объединению тем всех посетителей. Отчёт уходит
 * при изменении слов или законов и раз в полсуток для «я ещё здесь»: тема,
 * которую две недели никто не открывал, перестаёт собираться. Цены и
 * стоп-слова не отправляются: ими лента отбирает уже у человека, а сборщику
 * чужая граница сузила бы сбор для остальных.
 */

const VISITOR_KEY = "tenderfit.visitorId";
const LAST_REPORT_KEY = "tenderfit.demand.last";
const REFRESH_MS = 12 * 3_600_000;

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Память браузера недоступна: отчёт уйдёт и в следующий раз, вреда нет.
  }
}

/** Случайный идентификатор браузера: ни имени, ни почты в нём нет. */
export function getVisitorId(): string {
  const existing = readKey(VISITOR_KEY);
  if (existing !== null && /^[A-Za-z0-9-]{16,64}$/.test(existing)) return existing;
  const fresh = randomId();
  writeKey(VISITOR_KEY, fresh);
  return fresh;
}

interface LastReport {
  signature: string;
  at: number;
}

function readLast(): LastReport | null {
  const raw = readKey(LAST_REPORT_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LastReport>;
    return typeof parsed.signature === "string" && typeof parsed.at === "number"
      ? { signature: parsed.signature, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

function priorityRegions(): string[] {
  try {
    return companyProfileRepository
      .get()
      .preferences.priorityRegions.map((r) => r.trim())
      .filter((r) => r !== "");
  } catch {
    return [];
  }
}

export const demandReporter = {
  /**
   * Сообщает серверу о темах посетителя, если это нужно.
   *
   * Возвращает true, когда отчёт ушёл и принят. Сбой не бросает исключение:
   * страница работает и без отчёта, а повтор будет при следующем заходе.
   */
  async report(profiles: readonly SearchProfile[], nowMs: number = Date.now()): Promise<boolean> {
    // Регион профиля; нет — приоритетные регионы компании: человек, у которого
    // они заданы, ждёт закупки именно там, а плановый сбор искал по всей России.
    const fallbackRegions = priorityRegions();
    const payload = profiles.map((p) => ({
      keywords: p.keywords,
      laws: p.laws,
      regions: p.regions.length > 0 ? p.regions : fallbackRegions,
      enabled: p.enabled,
    }));
    const signature = JSON.stringify(payload);
    const last = readLast();

    if (last === null && payload.length === 0) return false;
    if (last !== null && last.signature === signature && nowMs - last.at < REFRESH_MS) return false;

    try {
      const response = await fetch("/api/demand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId: getVisitorId(), profiles: payload }),
      });
      await readJsonOrThrow<{ topics: number }>(response);
    } catch {
      return false;
    }

    writeKey(LAST_REPORT_KEY, JSON.stringify({ signature, at: nowMs }));
    return true;
  },
};
