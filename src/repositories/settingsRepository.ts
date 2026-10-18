import type { DigestSettings } from "@/domain/entities";
import { isValidTimeZone } from "@/domain/digestSettings";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

export const defaultDigestSettings: DigestSettings = {
  enabled: true,
  sendTime: "08:00",
  email: "demo@tenderfit.local",
  minFitScore: 50,
  urgentEnabled: true,
  urgentDeadlineHours: 24,
  documentChangesEnabled: true,
  readyEnabled: true,
};

/** Часовой пояс браузера, если он известен и принимается `Intl`; иначе null. */
export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Репозиторий настроек уведомлений (localStorage). */
export const settingsRepository = {
  /** Сохранённые настройки поверх значений по умолчанию: старые сохранения не знают новых полей. */
  get(): DigestSettings {
    const stored = readJSON<Partial<DigestSettings> | null>(STORAGE_KEYS.settings, null);
    return { ...defaultDigestSettings, ...(stored !== null && typeof stored === "object" ? stored : {}) };
  },
  save(settings: DigestSettings): void {
    writeJSON(STORAGE_KEYS.settings, settings);
  },
  /**
   * Запомнить часовой пояс браузера, если в настройках его ещё нет.
   *
   * Воркер шлёт сводку по поясу из настроек: пока его там нет, письма идут по Москве, и
   * иркутянин получил бы «утреннюю» сводку в час ночи. Поэтому пояс сохраняется при
   * первом открытии приложения, не дожидаясь, пока человек заглянет в «Уведомления».
   * Уже заданный пояс не трогается — его выбрал человек. Возвращает сохранённый пояс или null.
   */
  ensureTimeZone(): string | null {
    const current = this.get();
    if (isValidTimeZone(current.timeZone)) return null;
    const zone = browserTimeZone();
    if (zone === null) return null;
    this.save({ ...current, timeZone: zone });
    return zone;
  },
};
