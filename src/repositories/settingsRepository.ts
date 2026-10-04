import type { DigestSettings } from "@/domain/entities";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

export const defaultDigestSettings: DigestSettings = {
  enabled: true,
  sendTime: "08:00",
  email: "demo@tenderfit.local",
  minFitScore: 50,
  urgentEnabled: true,
  urgentDeadlineHours: 24,
  documentChangesEnabled: true,
};

/** Репозиторий настроек уведомлений (localStorage). */
export const settingsRepository = {
  get(): DigestSettings {
    return readJSON<DigestSettings>(STORAGE_KEYS.settings, defaultDigestSettings);
  },
  save(settings: DigestSettings): void {
    writeJSON(STORAGE_KEYS.settings, settings);
  },
};
