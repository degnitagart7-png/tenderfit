import type { NextRequest } from "next/server";

import { requestEmail } from "@/app/api/auth/requestUser";
import { isAdminEmail } from "@/domain/access";
import type { EstimateViewer } from "@/domain/estimate/jobOwnership";

/**
 * Кто смотрит расчёт: вошедший (почта из сессии, которую уже прочитал `requireAccess`) или
 * служебный запрос без почты. Правила доступа — `domain/estimate/jobOwnership`. Вызывать после
 * `requireAccess`: до него почта по запросу ещё не известна.
 */
export function estimateViewer(request: NextRequest): EstimateViewer {
  const email = requestEmail(request);
  return { email, admin: email !== null && isAdminEmail(email) };
}
