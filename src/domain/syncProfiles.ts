import { z } from "zod";

import type { SearchProfile } from "@/domain/entities";
import { normalizeLiveRegions } from "@/domain/liveSearch";

/**
 * Профили поиска на сервере.
 *
 * Сборщик (воркер) раньше знал три зашитых профиля из scripts/sync-profiles.json,
 * поэтому лента наполнялась автомобилями, компьютерами и стройкой, а запрос
 * «юридические услуги» находил две закупки: юристов никто не собирал. Теперь
 * профили приходят из базы: владелец отправляет свои, и сборщик собирает их.
 * Файл остаётся запасным вариантом, пока на сервере профилей нет.
 *
 * Модуль без сети и без базы: разбор входа и выбор набора — чистые функции,
 * чтобы правила проверялись тестом, а не прогоном по чужим площадкам.
 */

/** Каждый профиль — это запросы к чужим площадкам на каждое слово. */
export const MAX_SERVER_PROFILES = 12;
export const MAX_KEYWORDS_PER_PROFILE = 30;

const LAWS = ["FZ_44", "FZ_223", "PP_RF_615", "COMMERCIAL"] as const;

const wordSchema = z.string().max(120);

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  laws: z.array(z.enum(LAWS)).min(1).max(LAWS.length),
  keywords: z.array(wordSchema).max(MAX_KEYWORDS_PER_PROFILE),
  okpd2Codes: z.array(z.string().trim().max(20)).max(30).default([]),
  minPrice: z.number().nonnegative().nullable().default(null),
  maxPrice: z.number().nonnegative().nullable().default(null),
  /** Регионы сбора (по региону заказчика); пусто — вся Россия. */
  regions: z.array(z.string().max(60)).max(5).default([]),
  enabled: z.boolean(),
});

export type ServerProfile = z.infer<typeof profileSchema>;

function cleanWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of words) {
    const word = raw.trim();
    if (word === "" || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    result.push(word);
  }
  return result;
}

export type ParsedServerProfiles =
  | { ok: true; profiles: ServerProfile[] }
  | { ok: false; error: string };

/** Разбирает набор профилей из тела запроса: форма, пределы, чистка слов. */
export function parseServerProfiles(input: unknown): ParsedServerProfiles {
  if (!Array.isArray(input)) return { ok: false, error: "Ожидался список профилей" };
  if (input.length > MAX_SERVER_PROFILES) {
    return { ok: false, error: `Профилей не больше ${MAX_SERVER_PROFILES}: каждый стоит запросов к площадкам` };
  }

  const profiles: ServerProfile[] = [];
  for (const item of input) {
    const parsed = profileSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, error: `Профиль не принят: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
    }
    const keywords = cleanWords(parsed.data.keywords);
    if (keywords.length === 0) {
      return { ok: false, error: `У профиля «${parsed.data.name}» нет ключевых слов: он собрал бы всё подряд` };
    }
    profiles.push({
      ...parsed.data,
      keywords,
      okpd2Codes: cleanWords(parsed.data.okpd2Codes),
      regions: normalizeLiveRegions(parsed.data.regions),
    });
  }

  const names = new Set(profiles.map((p) => p.name.toLowerCase()));
  if (names.size !== profiles.length) {
    return { ok: false, error: "Названия профилей должны различаться" };
  }

  return { ok: true, profiles };
}

/** Что нужно сборщику от профиля; остальное он берёт по умолчанию. */
export interface CollectorProfile {
  name: string;
  enabled: boolean;
  laws: ServerProfile["laws"];
  keywords: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  okpd2Codes?: string[];
  /** Регионы заказчика; пусто или нет — вся Россия. */
  regions?: string[];
  limitPerKeyword?: number;
}

/** Сколько закупок брать на слово: общее для профилей сервера. */
const SERVER_LIMIT_PER_KEYWORD = 25;

/**
 * Выбирает набор для сборки.
 *
 * Есть профили владельца или спрос посетителей — они заменяют зашитые целиком:
 * смесь оставила бы в сборе чужие темы, ради ухода от которых всё и затеяно.
 * Профили владельца идут первыми, спрос — следом. Всё выключено — собирать
 * нечего: это явный выбор, а не повод вернуться к зашитым. Нет ни того ни
 * другого — работает файл.
 */
export function pickSyncProfiles<F extends { enabled: boolean }>(
  fromFile: readonly F[],
  fromServer: readonly ServerProfile[],
  fromDemand: readonly CollectorProfile[] = [],
): Array<F | CollectorProfile> {
  if (fromServer.length === 0 && fromDemand.length === 0) return fromFile.filter((p) => p.enabled);

  const owner = fromServer
    .filter((p) => p.enabled)
    .map(
      (p): CollectorProfile => ({
        name: p.name,
        enabled: true,
        laws: p.laws,
        keywords: p.keywords,
        minPrice: p.minPrice,
        maxPrice: p.maxPrice,
        okpd2Codes: p.okpd2Codes,
        regions: p.regions,
        limitPerKeyword: SERVER_LIMIT_PER_KEYWORD,
      }),
    );
  return [...owner, ...fromDemand.filter((p) => p.enabled)];
}

/**
 * Профили из настроек человека — в вид, который принимает сервер.
 *
 * Стоп-слова, регионы, ИНН и «только открытые» сборщику не передаются: он
 * собирает по словам, а остальное применяет лента уже на странице. Профиль без
 * ключевых слов не отправляется (сервер отклонил бы весь набор) и называется
 * среди пропущенных, чтобы человек знал, чего на сервере нет.
 */
export function toServerProfiles(
  profiles: readonly SearchProfile[],
  fallbackRegions: readonly string[] = [],
): {
  profiles: ServerProfile[];
  skipped: string[];
} {
  const sent: ServerProfile[] = [];
  const skipped: string[] = [];
  for (const p of profiles) {
    const keywords = cleanWords(p.keywords);
    if (keywords.length === 0) {
      skipped.push(p.name);
      continue;
    }
    sent.push({
      name: p.name.trim(),
      laws: p.laws,
      keywords,
      okpd2Codes: cleanWords(p.okpd2Codes),
      minPrice: p.minPrice,
      maxPrice: p.maxPrice,
      // Свой регион профиля; нет — приоритетные регионы компании.
      regions: normalizeLiveRegions(p.regions.length > 0 ? p.regions : fallbackRegions),
      enabled: p.enabled,
    });
  }
  return { profiles: sent, skipped };
}
