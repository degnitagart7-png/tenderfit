import type { ImportedTender, Tender } from "@/domain/entities";
import { importedToTender } from "@/domain/tenderImport";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

/**
 * Репозиторий импортированных закупок (CSV/ручной импорт, localStorage).
 * Хранит черновики ImportedTender и отдаёт их как доменные Tender для
 * анализа тем же конвейером, что и mock-база.
 */
export const importedTendersRepository = {
  getAll(): ImportedTender[] {
    return readJSON<ImportedTender[]>(STORAGE_KEYS.importedTenders, []);
  },
  asTenders(): Tender[] {
    return this.getAll().map(importedToTender);
  },
  /** Добавляет черновики, пропуская уже существующие по реестровому номеру. */
  addMany(items: ImportedTender[]): { added: number; skipped: number } {
    const all = this.getAll();
    const existing = new Set(all.map((t) => t.regNumber));
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      if (existing.has(item.regNumber)) {
        skipped += 1;
        continue;
      }
      existing.add(item.regNumber);
      all.push(item);
      added += 1;
    }
    writeJSON(STORAGE_KEYS.importedTenders, all);
    return { added, skipped };
  },
  remove(id: string): void {
    writeJSON(
      STORAGE_KEYS.importedTenders,
      this.getAll().filter((t) => t.id !== id),
    );
  },
  clear(): void {
    writeJSON(STORAGE_KEYS.importedTenders, []);
  },
};
