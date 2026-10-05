import type { SearchProfile } from "@/domain/entities";

/**
 * Слияние данных аккаунта с данными этого устройства.
 *
 * Человек мог собрать профили, ещё не войдя, а потом войти на устройстве, где
 * аккаунт уже что-то хранит. Правило — ничего не терять: профили поиска
 * объединяются по названию (при совпадении побеждает версия аккаунта), а
 * анкета компании берётся из аккаунта, если она там есть.
 */

export interface UserDataSnapshot {
  searchProfiles: SearchProfile[];
  /** Анкета компании как есть: нормализует её тот, кто читает. */
  companyProfile: unknown;
}

export interface MergeResult {
  merged: UserDataSnapshot;
  /** В объединённых данных есть то, чего нет на сервере. */
  pushToServer: boolean;
  /** В объединённых данных есть то, чего нет на устройстве. */
  writeToDevice: boolean;
}

const key = (name: string): string => name.trim().toLowerCase();

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function mergeUserData(local: UserDataSnapshot, server: UserDataSnapshot): MergeResult {
  const byName = new Map<string, SearchProfile>();
  for (const p of server.searchProfiles) byName.set(key(p.name), p);
  for (const p of local.searchProfiles) {
    if (!byName.has(key(p.name))) byName.set(key(p.name), p);
  }

  const merged: UserDataSnapshot = {
    searchProfiles: [...byName.values()],
    companyProfile: server.companyProfile ?? local.companyProfile ?? null,
  };

  return {
    merged,
    pushToServer: !same(merged.searchProfiles, server.searchProfiles) || !same(merged.companyProfile, server.companyProfile),
    writeToDevice: !same(merged.searchProfiles, local.searchProfiles) || !same(merged.companyProfile, local.companyProfile),
  };
}
