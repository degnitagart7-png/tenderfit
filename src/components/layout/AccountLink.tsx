"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CreditCard, LogIn, LogOut, User, UserCircle } from "lucide-react";

import { accountApiService } from "@/services/accountApiService";
import { accountSync } from "@/services/accountSync";
import { settingsRepository } from "@/repositories/settingsRepository";
import { cn } from "@/lib/cn";

/**
 * Личный кабинет — круглая кнопка справа вверху, как в любом сервисе.
 *
 * Нажатие открывает меню: кабинет, оплата и тарифы, вход или выход. Гость
 * видит «Войти», вошедший — свою почту и «Выйти». Когда вход на сервере
 * не настроен, пункта «Войти» нет: предлагать вход, который не работает, хуже,
 * чем не предлагать. Кабинет и оплата доступны всегда. Вошедшему при открытии страницы данные аккаунта и
 * устройства сливаются; если на устройстве что-то изменилось, страница
 * перечитывается один раз, чтобы показать актуальные профили.
 */

const SYNC_FLAG = "tenderfit.accountSynced";

export function AccountLink() {
  const [email, setEmail] = useState<string | null>(null);
  const [loginEnabled, setLoginEnabled] = useState(false);
  const stopAutoPush = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  // Меню закрывается по Escape и по клику вне него — как любое выпадающее.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    void accountApiService
      .me()
      .then(async (state) => {
        if (cancelled) return;
        setLoginEnabled(state.loginEnabled);
        setEmail(state.user?.email ?? null);
        if (state.user === null) return;
        // Каждое сохранение на устройстве (воронка, настройки, анкета…) — в аккаунт.
        stopAutoPush.current = accountSync.startAutoPush();

        // Слияние один раз за вкладку: каждое открытие страницы лишний раз грузило бы сервер.
        try {
          if (sessionStorage.getItem(SYNC_FLAG) === "1") {
            // Слияние уже было: пояс для утренней сводки запоминаем и здесь (старые аккаунты без него).
            settingsRepository.ensureTimeZone();
            return;
          }
          sessionStorage.setItem(SYNC_FLAG, "1");
        } catch {
          // Память вкладки недоступна: синхронизируем без отметки.
        }
        const { deviceChanged } = await accountSync.onSignedIn();
        if (deviceChanged && !cancelled) {
          window.location.reload();
          return;
        }
        // После слияния, а не до: настройки аккаунта побеждают устройство, и пояс, записанный раньше,
        // пропал бы. Запись уйдёт в аккаунт сама (автоотправка).
        settingsRepository.ensureTimeZone();
      })
      .catch(() => {
        // Сервер не ответил: страница работает как для гостя.
      });
    return () => {
      cancelled = true;
      stopAutoPush.current?.();
      stopAutoPush.current = null;
    };
  }, []);

  const logout = async (): Promise<void> => {
    stopAutoPush.current?.();
    stopAutoPush.current = null;
    try {
      await accountApiService.logout();
    } finally {
      // Данные аккаунта не должны достаться следующему человеку в этом браузере.
      accountSync.onSignedOut();
      try {
        sessionStorage.removeItem(SYNC_FLAG);
      } catch {
        // noop
      }
      setEmail(null);
      setOpen(false);
    }
  };

  const itemClass =
    "flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-left text-[14.5px] text-foreground hover:bg-panel-raised";
  const iconClass = "h-[17px] w-[17px] text-faint";

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Личный кабинет"
        aria-haspopup="menu"
        aria-expanded={open}
        title={email ?? "Личный кабинет"}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full bg-ink text-[14px] font-semibold text-white transition-opacity hover:opacity-85",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2",
        )}
      >
        {email !== null ? email.charAt(0).toUpperCase() : <User className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Личный кабинет"
          className="absolute right-0 top-11 z-30 w-64 rounded-card border border-border bg-panel p-1.5 shadow-card-hover"
        >
          <div className="px-3 pb-2 pt-1.5">
            <p className="truncate text-[14.5px] font-semibold text-foreground">{email ?? "Вы не вошли"}</p>
            {email === null && loginEnabled && (
              <p className="mt-0.5 text-[12.5px] text-faint">Войдите, чтобы данные были на любом устройстве</p>
            )}
          </div>
          <div className="border-t border-border pt-1.5">
            <Link href="/account" role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
              <UserCircle className={iconClass} strokeWidth={1.75} aria-hidden /> Личный кабинет
            </Link>
            <Link href="/billing" role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
              <CreditCard className={iconClass} strokeWidth={1.75} aria-hidden /> Оплата и тарифы
            </Link>
            {email === null && loginEnabled && (
              <Link href="/login" role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
                <LogIn className={iconClass} strokeWidth={1.75} aria-hidden /> Войти
              </Link>
            )}
            {email !== null && (
              <button type="button" role="menuitem" className={itemClass} onClick={() => void logout()}>
                <LogOut className={iconClass} strokeWidth={1.75} aria-hidden /> Выйти
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
