"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LogIn, LogOut } from "lucide-react";

import { accountApiService } from "@/services/accountApiService";
import { accountSync } from "@/services/accountSync";

/**
 * Вход и выход в боковой панели.
 *
 * Гость видит «Войти», вошедший — свою почту и «Выйти». Когда вход на сервере
 * не настроен, ссылки нет вовсе: предлагать вход, который не работает, хуже,
 * чем не предлагать. Вошедшему при открытии страницы данные аккаунта и
 * устройства сливаются; если на устройстве что-то изменилось, страница
 * перечитывается один раз, чтобы показать актуальные профили.
 */

const SYNC_FLAG = "tenderfit.accountSynced";

export function AccountLink() {
  const [email, setEmail] = useState<string | null>(null);
  const [loginEnabled, setLoginEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void accountApiService
      .me()
      .then(async (state) => {
        if (cancelled) return;
        setLoginEnabled(state.loginEnabled);
        setEmail(state.user?.email ?? null);
        if (state.user === null) return;

        // Слияние один раз за вкладку: каждое открытие страницы лишний раз грузило бы сервер.
        try {
          if (sessionStorage.getItem(SYNC_FLAG) === "1") return;
          sessionStorage.setItem(SYNC_FLAG, "1");
        } catch {
          // Память вкладки недоступна: синхронизируем без отметки.
        }
        const { deviceChanged } = await accountSync.onSignedIn();
        if (deviceChanged && !cancelled) window.location.reload();
      })
      .catch(() => {
        // Сервер не ответил: страница работает как для гостя.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = async (): Promise<void> => {
    try {
      await accountApiService.logout();
    } finally {
      try {
        sessionStorage.removeItem(SYNC_FLAG);
      } catch {
        // noop
      }
      setEmail(null);
    }
  };

  if (!loginEnabled) return null;

  const rowClass =
    "flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-left text-[15.5px] text-muted-foreground hover:bg-panel hover:text-foreground";

  if (email === null) {
    return (
      <Link href="/login" className={rowClass}>
        <LogIn className="h-[17px] w-[17px] text-faint" strokeWidth={1.75} aria-hidden /> Войти
      </Link>
    );
  }

  return (
    <div>
      <Link href="/account" className="block truncate px-3 pb-1 text-[13px] text-faint hover:text-foreground" title={email}>
        Кабинет: {email}
      </Link>
      <button type="button" className={rowClass} onClick={() => void logout()}>
        <LogOut className="h-[17px] w-[17px] text-faint" strokeWidth={1.75} aria-hidden /> Выйти
      </button>
    </div>
  );
}
