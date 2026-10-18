import type { SearchProfile } from "@/domain/entities";

/**
 * Слияние данных аккаунта с данными этого устройства.
 *
 * Человек мог собрать профили, ещё не войдя, а потом войти на устройстве, где
 * аккаунт уже что-то хранит. Правило — ничего не терять: профили поиска
 * объединяются по названию (при совпадении побеждает версия аккаунта), а
 * анкета компании берётся из аккаунта, если она там есть.
 *
 * Остальное (см. AppState) сливается по смыслу каждого поля: отметка
 * онбординга — «пройден хоть где-то», воронка — по закупке с более свежим
 * статусом, истории решений и импорт — объединение по id, настройки — из
 * аккаунта.
 */

/** Данные аккаунта помимо профилей и анкеты. Значения — как их хранит устройство. */
export interface AppState {
  onboardingDone?: boolean;
  /** Тур по продукту пройден: тоже «хоть где-то», чтобы не показывать его на каждом устройстве заново. */
  tourDone?: boolean;
  digestSettings?: unknown;
  /** Воронка: id закупки → { status, updatedAt, ... }. */
  pipeline?: Record<string, unknown>;
  feedback?: unknown[];
  manualReviews?: unknown[];
  importedTenders?: unknown[];
  savedFilters?: unknown;
}

export interface UserDataSnapshot {
  searchProfiles: SearchProfile[];
  /** Анкета компании как есть: нормализует её тот, кто читает. */
  companyProfile: unknown;
  /** Нет у сервера, где ещё не применена миграция app_state, — тогда это пусто. */
  appState?: AppState;
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

/** JSON с упорядоченными ключами: одинаковые объекты с разным порядком ключей равны. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const updatedAt = (item: unknown): string => {
  const v = (item as { updatedAt?: unknown } | null)?.updatedAt;
  return typeof v === "string" ? v : "";
};

const itemId = (item: unknown): string => {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : stable(item);
};

/** Объединение списков по id: сначала порядок аккаунта, затем новое с устройства. */
function unionById(server: unknown[] | undefined, local: unknown[] | undefined): unknown[] | undefined {
  if (server === undefined && local === undefined) return undefined;
  const byId = new Map<string, unknown>();
  for (const item of server ?? []) byId.set(itemId(item), item);
  for (const item of local ?? []) if (!byId.has(itemId(item))) byId.set(itemId(item), item);
  return [...byId.values()];
}

function mergePipeline(
  server: Record<string, unknown> | undefined,
  local: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (server === undefined && local === undefined) return undefined;
  const merged: Record<string, unknown> = { ...(server ?? {}) };
  for (const [id, item] of Object.entries(local ?? {})) {
    const current = merged[id];
    if (current === undefined || updatedAt(item) > updatedAt(current)) merged[id] = item;
  }
  return merged;
}

export function mergeAppState(local: AppState, server: AppState): AppState {
  const merged: AppState = {
    onboardingDone: local.onboardingDone === true || server.onboardingDone === true ? true : undefined,
    tourDone: local.tourDone === true || server.tourDone === true ? true : undefined,
    digestSettings: server.digestSettings ?? local.digestSettings,
    pipeline: mergePipeline(server.pipeline, local.pipeline),
    feedback: unionById(server.feedback, local.feedback),
    manualReviews: unionById(server.manualReviews, local.manualReviews),
    importedTenders: unionById(server.importedTenders, local.importedTenders),
    savedFilters: server.savedFilters ?? local.savedFilters,
  };
  for (const key of Object.keys(merged) as Array<keyof AppState>) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}

export function mergeUserData(local: UserDataSnapshot, server: UserDataSnapshot): MergeResult {
  const byName = new Map<string, SearchProfile>();
  for (const p of server.searchProfiles) byName.set(key(p.name), p);
  for (const p of local.searchProfiles) {
    if (!byName.has(key(p.name))) byName.set(key(p.name), p);
  }

  const merged: UserDataSnapshot = {
    searchProfiles: [...byName.values()],
    companyProfile: server.companyProfile ?? local.companyProfile ?? null,
    appState: mergeAppState(local.appState ?? {}, server.appState ?? {}),
  };

  return {
    merged,
    pushToServer:
      !same(merged.searchProfiles, server.searchProfiles) ||
      !same(merged.companyProfile, server.companyProfile) ||
      stable(merged.appState) !== stable(server.appState ?? {}),
    writeToDevice:
      !same(merged.searchProfiles, local.searchProfiles) ||
      !same(merged.companyProfile, local.companyProfile) ||
      stable(merged.appState) !== stable(local.appState ?? {}),
  };
}
