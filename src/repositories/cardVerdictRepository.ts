import type { CompanyProfile } from "@/domain/entities";
import type { Verdict } from "@/types/database";
import { readJSON, STORAGE_KEYS, writeJSON } from "@/lib/storage";

/**
 * Оценка закупки, посчитанная в её карточке, — для ленты, доски и «Сегодня».
 *
 * Карточка считает оценку по документации закупки (риски договора, требования,
 * обеспечения), а лента — только по реквизитам: грузить мегабайты текста на каждую
 * строку ленты нельзя. Одна закупка получала «98 · Подходит» в «Моих закупках» и
 * «96 · Проверить» в карточке (проверка 24.10.2026). Карточка запоминает свой
 * итог, и списки показывают его для открытых закупок.
 *
 * Итог привязан к профилю компании: правка профиля меняет оценку, и запомненное
 * по старому профилю списки не берут.
 */

export interface CardVerdict {
  verdict: Verdict;
  fitScore: number;
  /** Отпечаток профиля, по которому посчитано. */
  profileKey: string;
}

/** Больше не храним: старые записи вытесняются первыми. */
const MAX_ENTRIES = 300;

type Store = Record<string, CardVerdict & { at: number }>;

/** Отпечаток профиля: всё, от чего зависит оценка, одной строкой. */
export function profileFingerprint(profile: CompanyProfile): string {
  const text = JSON.stringify([profile.capabilities, profile.restrictions, profile.preferences, profile.licenses, profile.sroMemberships]);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return `${String(text.length)}:${String(hash >>> 0)}`;
}

export const cardVerdictRepository = {
  save(tenderId: string, entry: CardVerdict): void {
    const store = readJSON<Store>(STORAGE_KEYS.cardVerdicts, {});
    store[tenderId] = { ...entry, at: Date.now() };
    const ids = Object.keys(store);
    if (ids.length > MAX_ENTRIES) {
      ids.sort((a, b) => store[a]!.at - store[b]!.at);
      for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete store[id];
    }
    writeJSON(STORAGE_KEYS.cardVerdicts, store);
  },

  /** Запомненный итог карточки по этому профилю; null — карточку не открывали или профиль другой. */
  get(tenderId: string, profileKey: string): CardVerdict | null {
    const entry = readJSON<Store>(STORAGE_KEYS.cardVerdicts, {})[tenderId];
    if (!entry || entry.profileKey !== profileKey) return null;
    return { verdict: entry.verdict, fitScore: entry.fitScore, profileKey: entry.profileKey };
  },

  /** Все итоги для профиля — одним чтением хранилища на всю ленту. */
  allFor(profileKey: string): Map<string, CardVerdict> {
    const store = readJSON<Store>(STORAGE_KEYS.cardVerdicts, {});
    const result = new Map<string, CardVerdict>();
    for (const [id, entry] of Object.entries(store)) {
      if (entry.profileKey === profileKey) result.set(id, { verdict: entry.verdict, fitScore: entry.fitScore, profileKey });
    }
    return result;
  },
};
