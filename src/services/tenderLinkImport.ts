import type { Tender } from "@/domain/entities";
import { linkRawData } from "@/domain/liveSearch";
import { tenderBaseRow } from "@/domain/tenderRow";
import { describeError } from "@/lib/errors";
import { isEisBlockedError } from "@/lib/eisGate";
import { EisTenderSourceAdapter } from "@/adapters/tender-source/eisTenderSourceAdapter";
import { tenderRepository, type CreateTenderInput } from "@/repositories/tenderRepository";
import type { TenderRow } from "@/types/database";

/**
 * Закупки, добавленные человеком по ссылке или номеру, — в базу до загрузки документов.
 *
 * Задание «документация по номерам» умеет только закупки, которые уже есть в
 * базе: чужой номер оно помечало «не найдено». Здесь недостающая закупка берётся
 * из ЕИС по реестровому номеру и записывается с пометкой `raw_data.origin = "link"`
 * — плановая очистка такие строки щадит (`KEEP_LIVE_ROWS_FILTER`). Уже лежащая
 * строка без пометки помечается тоже: человек сам попросил эту закупку, и она не
 * должна пропасть через два часа, когда ни один профиль её не соберёт.
 */
export interface LinkImportReport {
  added: string[];
  existing: string[];
  notFound: string[];
  /** ЕИС ограничила доступ: закупку взять не удалось, причина — человеческим языком. */
  blocked: string | null;
  failed: { regNumber: string; error: string }[];
}

export interface LinkImportDeps {
  find(regNumber: string): Promise<Pick<TenderRow, "raw_data"> | null>;
  fetchFromEis(regNumber: string): Promise<Tender | null>;
  save(row: CreateTenderInput): Promise<void>;
  markLink(regNumber: string, rawData: Record<string, unknown>): Promise<void>;
  now(): number;
}

function hasOrigin(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && typeof (raw as { origin?: unknown }).origin === "string";
}

export async function importTendersByLink(
  regNumbers: readonly string[],
  deps: LinkImportDeps = defaultLinkImportDeps(),
): Promise<LinkImportReport> {
  const report: LinkImportReport = { added: [], existing: [], notFound: [], blocked: null, failed: [] };
  const at = new Date(deps.now()).toISOString();
  for (const regNumber of regNumbers) {
    try {
      const stored = await deps.find(regNumber);
      if (stored !== null) {
        // Пометка «live» тоже щадится очисткой — её не трогаем; без пометки — ставим «link».
        if (!hasOrigin(stored.raw_data)) await deps.markLink(regNumber, linkRawData(at));
        report.existing.push(regNumber);
        continue;
      }
      const tender = await deps.fetchFromEis(regNumber);
      if (tender === null || tender.deadlines.submissionEnd.trim() === "") {
        report.notFound.push(regNumber);
        continue;
      }
      await deps.save({ ...tenderBaseRow(tender), raw_data: linkRawData(at) });
      report.added.push(regNumber);
    } catch (err) {
      if (isEisBlockedError(err)) {
        report.blocked = err.message;
        break;
      }
      report.failed.push({ regNumber, error: describeError(err) });
    }
  }
  return report;
}

export function defaultLinkImportDeps(): LinkImportDeps {
  const eis = new EisTenderSourceAdapter();
  return {
    find: (regNumber) => tenderRepository.findByRegNumber(regNumber),
    fetchFromEis: (regNumber) => eis.fetchTenderById(regNumber),
    save: async (row) => {
      await tenderRepository.upsertByRegNumber(row);
    },
    markLink: async (regNumber, rawData) => {
      const row = await tenderRepository.findByRegNumber(regNumber);
      if (row === null) return;
      await tenderRepository.update(row.id, { raw_data: rawData });
    },
    now: Date.now,
  };
}

/** Строка для журнала и отчёта задания: что стало с закупками по ссылке. */
export function describeLinkImport(report: LinkImportReport): string | null {
  const parts: string[] = [];
  if (report.added.length > 0) parts.push(`добавлено из ЕИС: ${report.added.join(", ")}`);
  if (report.notFound.length > 0) {
    parts.push(
      `в ЕИС не найдено: ${report.notFound.join(", ")} — проверьте номер; закупка могла быть снята или ещё не опубликована`,
    );
  }
  if (report.blocked !== null) parts.push(report.blocked);
  for (const failure of report.failed) parts.push(`${failure.regNumber}: ${failure.error}`);
  return parts.length > 0 ? parts.join("; ") : null;
}
