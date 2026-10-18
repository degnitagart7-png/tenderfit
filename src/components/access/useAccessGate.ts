"use client";

import { useEffect, useState } from "react";

import { effectiveAccess, type AccessInfo } from "@/domain/access";
import { ACCESS_EXPIRED_EVENT, installAccessFetchGuard, redirectToLogin } from "@/lib/accessClient";
import { accountApiService } from "@/services/accountApiService";

/**
 * Доступ текущего человека для оболочки приложения.
 *
 * Один раз читает /api/auth/me и дальше следит за тремя событиями:
 *  - сессии нет (вход настроен, а человека нет) — переход на /login;
 *  - любой запрос получил 402 — доступ закончился посреди работы;
 *  - время идёт: раз в минуту пересчитывается остаток, а истёкший пробный
 *    период сам превращается в «закончился».
 * Сервер не ответил или вход не настроен — оболочка работает без ограничений:
 * ограничения всё равно держит сервер (requireAccess), а ломать экран из-за
 * сбоя сети хуже, чем показать его.
 */

export interface AccessGate {
  /** Ответ сервера получен (или не получен окончательно): можно рисовать решение. */
  loaded: boolean;
  email: string | null;
  /** null — доступ неизвестен (вход не настроен или сервер не ответил). */
  access: AccessInfo | null;
}

const TICK_MS = 60_000;

const EXPIRED_NOW: AccessInfo = { status: "expired", endsAt: null, plan: null, daysLeft: 0, hoursLeft: 0 };

export function useAccessGate(): AccessGate {
  const [state, setState] = useState<{ loaded: boolean; email: string | null; access: AccessInfo | null }>({
    loaded: false,
    email: null,
    access: null,
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const remove = installAccessFetchGuard();
    return remove;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void accountApiService
      .me()
      .then((me) => {
        if (cancelled) return;
        if (me.user === null) {
          if (me.loginEnabled) redirectToLogin();
          setState({ loaded: true, email: null, access: null });
          return;
        }
        setState({ loaded: true, email: me.user.email, access: me.user.access ?? null });
      })
      .catch(() => {
        if (!cancelled) setState({ loaded: true, email: null, access: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onExpired = () => setState((prev) => ({ ...prev, loaded: true, access: EXPIRED_NOW }));
    window.addEventListener(ACCESS_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(ACCESS_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return {
    loaded: state.loaded,
    email: state.email,
    access: state.access === null ? null : effectiveAccess(state.access, now),
  };
}
