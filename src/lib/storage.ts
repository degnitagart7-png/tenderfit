/** Безопасная обёртка над localStorage для клиентских репозиториев. */

type WriteListener = (key: string) => void;

const writeListeners = new Set<WriteListener>();

/**
 * Подписка на записи через эту обёртку: по ней данные вошедшего уходят в
 * аккаунт (см. accountSync), и репозиториям не нужно знать о сервере.
 * Возвращает отписку.
 */
export function onLocalWrite(listener: WriteListener): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

function notifyWrite(key: string): void {
  for (const listener of writeListeners) {
    try {
      listener(key);
    } catch {
      // Подписчик не должен ломать сохранение на устройстве.
    }
  }
}

export function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Игнорируем ошибки переполнения/приватного режима.
    return;
  }
  notifyWrite(key);
}

export function removeKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
  notifyWrite(key);
}

export const STORAGE_KEYS = {
  profile: "tf.companyProfile",
  pipeline: "tf.pipeline",
  settings: "tf.digestSettings",
  feedback: "tf.feedback",
  searchProfiles: "tf.searchProfiles",
  onboardingDraft: "tf.onboardingDraft",
  onboardingDone: "tf.onboardingDone",
  /** Короткий тур по продукту пройден или закрыт: больше сам не открывается. */
  tourDone: "tenderfit.tourDone",
  auth: "tf.auth",
  jobs: "tf.jobs",
  savedFilters: "tf.savedFilters",
  syncSnapshot: "tf.syncSnapshot",
  manualReviews: "tf.manualReviews",
  importedTenders: "tf.importedTenders",
  /** Факт согласия на обработку ПД: отметка, дата и редакция текста. */
  pdConsent: "tf.pdConsent",
  /** Чьи данные лежат на устройстве (почта владельца); без метки данные считаются чужими. */
  deviceOwner: "tf.deviceOwner",
} as const;

/**
 * Данные, принадлежащие аккаунту, а не устройству. Браузер один, а людей за ним
 * может быть несколько: без очистки при выходе и смене владельца новый аккаунт
 * получал копию чужих профилей, анкеты и воронки (см. accountSync).
 *
 * Почти всё здесь — человеческие данные или их кэши. Согласие на ПД тоже личное:
 * его давал другой человек. Токен админки — секрет конкретного человека.
 * Не очищаем только настройки самого устройства: идентификатор браузера для
 * счётчика спроса (`tenderfit.visitorId`, `tenderfit.demand.last`), последнюю
 * выбранную зону сметы (`tf.estimate.lastZone`) и флаги вкладки в sessionStorage.
 */
const ACCOUNT_SCOPED_KEYS: readonly string[] = [
  STORAGE_KEYS.profile,
  STORAGE_KEYS.pipeline,
  STORAGE_KEYS.settings,
  STORAGE_KEYS.feedback,
  STORAGE_KEYS.searchProfiles,
  STORAGE_KEYS.onboardingDraft,
  STORAGE_KEYS.onboardingDone,
  STORAGE_KEYS.tourDone,
  STORAGE_KEYS.auth,
  STORAGE_KEYS.jobs,
  STORAGE_KEYS.savedFilters,
  STORAGE_KEYS.syncSnapshot,
  STORAGE_KEYS.manualReviews,
  STORAGE_KEYS.importedTenders,
  STORAGE_KEYS.pdConsent,
  // Отметка последнего поиска: запросы человека (src/domain/searchMarker.ts).
  "tenderfit.lastSearch",
  // Токен админки, введённый человеком (ServerProfilesCard, LlmCostCard).
  "tenderfit.adminToken",
];

/** Ключи с суффиксом: правки ведомости по закупкам (`tf.billEdits:<id>`, src/services/billEditsStore.ts). */
const ACCOUNT_SCOPED_PREFIXES: readonly string[] = ["tf.billEdits:"];

/**
 * Стереть с устройства данные аккаунта (кроме метки владельца). Тихо: без
 * уведомлений подписчиков записи, иначе автоотправка приняла бы очистку за правку
 * человека и затёрла бы данные на сервере пустыми. true — что-то было стёрто.
 */
export function clearAccountScopedData(): boolean {
  if (typeof window === "undefined") return false;
  let removed = false;
  try {
    const storage = window.localStorage;
    const doomed = new Set<string>(ACCOUNT_SCOPED_KEYS);
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && ACCOUNT_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix))) doomed.add(key);
    }
    for (const key of doomed) {
      if (storage.getItem(key) === null) continue;
      storage.removeItem(key);
      removed = true;
    }
  } catch {
    // Память недоступна: чистить нечего.
  }
  return removed;
}

/** Метка владельца устройства: почта в нижнем регистре (сервер отдаёт клиенту только её). */
export function ownerTag(email: string): string {
  return email.trim().toLowerCase();
}

export function readDeviceOwner(): string | null {
  const value = readJSON<unknown>(STORAGE_KEYS.deviceOwner, null);
  return typeof value === "string" && value !== "" ? value : null;
}

export function writeDeviceOwner(owner: string): void {
  writeJSON(STORAGE_KEYS.deviceOwner, owner);
}

export function clearDeviceOwner(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEYS.deviceOwner);
  } catch {
    // См. clearAccountScopedData.
  }
}
