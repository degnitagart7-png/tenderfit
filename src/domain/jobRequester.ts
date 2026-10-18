/**
 * Строка задания без поля «кто поставил».
 *
 * С 14.10.2026 в `analysis_jobs.requested_by` лежит почта вошедшего (по ней
 * считаются суточный лимит и страница /admin/users). Ручки, которые отдают задачи
 * обычным пользователям (`/api/analysis/status`, `/api/analysis/trigger`), могут
 * вернуть задачу, поставленную другим человеком по той же закупке, — почта
 * в ответе была бы чужой. Клиент это поле не читает.
 */
export function withoutRequester<T extends object>(row: T): Omit<T, "requested_by"> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy["requested_by"];
  return copy as Omit<T, "requested_by">;
}
