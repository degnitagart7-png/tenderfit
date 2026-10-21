import type { AuditReport } from "@/domain/estimate/customerAudit";

/**
 * Название сметы заказчика для экрана и файла.
 *
 * Лист сметы в выгрузке часто называется по базе норм («Смета по ФСНБ 421+557прРИМ»), и у тринадцати смет одной закупки он
 * один и тот же: различить их нельзя. Название строится из номера сметы и наименования работ из шапки («ЛСР 02-01-01 · Ремонт кровли»);
 * нет ни того ни другого — имя листа, если оно не про базу норм, иначе имя файла. Строка про базу норм не бывает названием:
 * она уходит в подзаголовок вместе с именем файла.
 *
 * Модуль чистый.
 */

/** Имя листа — описание базы норм или метода, а не названия сметы. */
const NORMS_BASE_RE = /(фснб|фсбц|фер\b|тер\b|тсн|базисно|ресурсно|методик|\b421\b|\b557\b|пр\s*рим|прРИМ|\bрим\b)/iu;

export function isNormsBaseName(name: string | null | undefined): boolean {
  return name !== null && name !== undefined && NORMS_BASE_RE.test(name);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Название: «ЛСР 02-01-01 · Ремонт кровли»; запасные — имя листа (не про базу норм), имя файла. */
export function estimateTitle(report: Pick<AuditReport, "estimateName" | "documentName" | "estimateNumber" | "title">): string {
  const number = report.estimateNumber?.trim() ?? "";
  const title = report.title?.trim() ?? "";
  if (number !== "" && title !== "") return `ЛСР ${number} · ${title}`;
  if (title !== "") return title;
  if (number !== "") return `ЛСР ${number}`;
  const sheet = report.estimateName?.trim() ?? "";
  if (sheet !== "" && !isNormsBaseName(sheet)) return sheet;
  return fileName(report.documentName);
}

/** Подзаголовок: файл и, если лист назван по базе норм, эта база («Смета.xlsx · Смета по ФСНБ 421+557пр, РИМ»). */
export function estimateSubtitle(report: Pick<AuditReport, "estimateName" | "documentName" | "estimateNumber" | "title">): string {
  const title = estimateTitle(report);
  const file = fileName(report.documentName);
  const sheet = report.estimateName?.trim() ?? "";
  const parts: string[] = [];
  if (title !== file) parts.push(file);
  if (sheet !== "" && sheet !== title && isNormsBaseName(sheet)) parts.push(sheet);
  return parts.join(" · ");
}

/** Названия всех смет; повторяющиеся различаются именем файла или номером по порядку. */
export function estimateTitles(reports: readonly Pick<AuditReport, "estimateName" | "documentName" | "estimateNumber" | "title">[]): string[] {
  const titles = reports.map(estimateTitle);
  const counts = new Map<string, number>();
  for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
  const seen = new Map<string, number>();
  return titles.map((title, index) => {
    if ((counts.get(title) ?? 0) < 2) return title;
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    const file = fileName(reports[index]!.documentName);
    return title === file ? `${title} (${String(n)})` : `${title} (${file})`;
  });
}
