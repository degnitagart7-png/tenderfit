import type { ManualReviewDecision } from "@/domain/entities";

/**
 * Чек-лист ручной проверки (раздел «требуется ручная проверка»).
 * Пункты детерминированы доменом; отметки аналитика хранятся как id → true.
 */

export interface ChecklistItemDef {
  id: string;
  label: string;
}

export const MANUAL_REVIEW_CHECKLIST: ChecklistItemDef[] = [
  { id: "notice", label: "Извещение прочитано полностью" },
  { id: "spec", label: "Техническое задание прочитано, характеристики проверены" },
  { id: "contract", label: "Проект контракта прочитан, риски согласованы с юристом" },
  { id: "admission", label: "Требования к допуску (лицензии, СРО, опыт) проверены" },
  { id: "docs", label: "Состав заявки и сроки подачи подтверждены" },
  { id: "pricing", label: "Расчёт цены и маржинальности выполнен" },
  { id: "security", label: "Обеспечение заявки/контракта и спецсчёт проверены" },
  { id: "customer", label: "Заказчик проверен по реестрам (добросовестность, споры)" },
  { id: "logistics", label: "Логистика и сроки поставки реалистичны" },
];

export function checklistProgress(
  state: Record<string, boolean>,
): { done: number; total: number; percent: number } {
  const total = MANUAL_REVIEW_CHECKLIST.length;
  const done = MANUAL_REVIEW_CHECKLIST.filter((c) => state[c.id]).length;
  return { done, total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/** Для «Подтвердить вручную» нужен полный чек-лист и комментарий. */
export function canConfirm(checklist: Record<string, boolean>, comment: string): boolean {
  return checklistProgress(checklist).done === MANUAL_REVIEW_CHECKLIST.length &&
    comment.trim().length >= 5;
}

/** Для отклонения/разъяснения достаточно комментария (чек-лист необязателен). */
export function canDecideWithoutConfirm(comment: string): boolean {
  return comment.trim().length >= 5;
}

/** Вердикт системы считается учтённым, если есть решение аналитика позже анализа. */
export function latestDecision(
  history: ManualReviewDecision[],
): ManualReviewDecision | null {
  if (history.length === 0) return null;
  return history.reduce((a, b) => (a.decidedAt >= b.decidedAt ? a : b));
}
