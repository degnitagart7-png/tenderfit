import { LEGAL_VERSION_DATE } from "@/lib/legal";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

/**
 * Факт согласия на обработку персональных данных.
 *
 * Хранится отдельно от профиля и вместе с редакцией текста: при изменении
 * документа согласие обязано запрашиваться заново, а для этого нужно знать,
 * на какую именно редакцию пользователь соглашался. Дата нужна, чтобы
 * подтвердить основание обработки по требованию.
 */
export interface PdConsent {
  accepted: true;
  /** ISO-дата момента, когда пользователь отметил согласие. */
  acceptedAt: string;
  /** Редакция текста согласия, с которой пользователь согласился. */
  version: string;
}

export function readConsent(): PdConsent | null {
  const stored = readJSON<PdConsent | null>(STORAGE_KEYS.pdConsent, null);
  if (stored === null) return null;
  // Согласие на устаревшую редакцию не действует: текст мог измениться
  // существенно, и молча считать его принятым нельзя.
  return stored.version === LEGAL_VERSION_DATE ? stored : null;
}

export function saveConsent(): void {
  const consent: PdConsent = {
    accepted: true,
    acceptedAt: new Date().toISOString(),
    version: LEGAL_VERSION_DATE,
  };
  writeJSON(STORAGE_KEYS.pdConsent, consent);
}
