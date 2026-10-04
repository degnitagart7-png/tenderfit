/** Безопасная обёртка над localStorage для клиентских репозиториев. */

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
  }
}

export function removeKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // noop
  }
}

export const STORAGE_KEYS = {
  profile: "tf.companyProfile",
  pipeline: "tf.pipeline",
  settings: "tf.digestSettings",
  feedback: "tf.feedback",
  searchProfiles: "tf.searchProfiles",
  onboardingDraft: "tf.onboardingDraft",
  onboardingDone: "tf.onboardingDone",
  auth: "tf.auth",
  jobs: "tf.jobs",
  savedFilters: "tf.savedFilters",
  syncSnapshot: "tf.syncSnapshot",
  manualReviews: "tf.manualReviews",
  importedTenders: "tf.importedTenders",
  /** Факт согласия на обработку ПД: отметка, дата и редакция текста. */
  pdConsent: "tf.pdConsent",
} as const;
