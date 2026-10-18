import { checkAdminToken } from "@/lib/adminToken";

/**
 * Секрет воркера для ручек, которые зовут платную модель от имени воркера.
 *
 * `/api/estimate/bill-rows` и `/api/estimate/norm-pick` пересылают модели фрагменты документов и кандидатов норм.
 * Зовёт их только воркер на том же сервере, но адрес открыт наружу через тот же домен, и без проверки любой мог бы
 * тратить ключ модели. Шаблон запроса неизменный, но расход всё равно чужой. Поэтому воркер шлёт секрет из своего
 * окружения в заголовке, а приложение сверяет его со своим (оба читают `TENDERFIT_WORKER_SECRET`).
 *
 * Секрет не задан у приложения — ручка закрыта («disabled»), а не открыта: забытая настройка не должна снова
 * открыть шлюз всем.
 */
export const WORKER_SECRET_HEADER = "x-worker-secret";

export function workerSecretHeaders(): Record<string, string> {
  const secret = (process.env["TENDERFIT_WORKER_SECRET"] ?? "").trim();
  return secret === "" ? {} : { [WORKER_SECRET_HEADER]: secret };
}

/** null — пропустить; иначе код и текст отказа. */
export function rejectWithoutWorkerSecret(provided: string | null | undefined): { status: number; error: string } | null {
  const verdict = checkAdminToken(provided, process.env["TENDERFIT_WORKER_SECRET"]);
  if (verdict === "ok") return null;
  if (verdict === "disabled") return { status: 503, error: "Ручка закрыта: у приложения не задан TENDERFIT_WORKER_SECRET" };
  return { status: 403, error: "Нужен секрет воркера" };
}
