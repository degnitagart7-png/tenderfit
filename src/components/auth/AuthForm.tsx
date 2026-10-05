"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Button, Checkbox, Field, Input } from "@/components/ui/primitives";
import { describeError } from "@/lib/errors";
import { accountApiService } from "@/services/accountApiService";
import { accountSync } from "@/services/accountSync";

/**
 * Вход и регистрация.
 *
 * Основной путь — почта и пароль: он не требует почтового сервера и работает
 * сразу. Вход по коду из письма показывается, только когда на сервере
 * настроена отправка писем: предлагать то, что не сработает, нельзя.
 *
 * После входа данные этого браузера (профили поиска, анкета компании)
 * сливаются с аккаунтом без потерь — см. accountSync.
 */

type Mode = "login" | "register" | "code" | "reset";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 8;

export function AuthForm({ onSignedIn, initialMode = "login" }: { onSignedIn: () => void; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [codeLogin, setCodeLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void accountApiService
      .me()
      .then((state) => setCodeLogin(state.codeLoginEnabled === true))
      .catch(() => setCodeLogin(false));
  }, []);

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
    setCodeSent(false);
  };

  const finish = async () => {
    await accountSync.onSignedIn();
    onSignedIn();
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const login = (e: React.FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setError("Введите корректный адрес почты.");
    if (password === "") return setError("Введите пароль.");
    void run(async () => {
      await accountApiService.login(email.trim(), password);
      await finish();
    });
  };

  const register = (e: React.FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setError("Введите корректный адрес почты.");
    if (password.trim().length < MIN_PASSWORD) return setError(`Пароль — не короче ${String(MIN_PASSWORD)} знаков.`);
    if (password !== repeat) return setError("Пароли не совпадают.");
    if (!consent) return setError("Нужно согласие на обработку персональных данных.");
    void run(async () => {
      await accountApiService.register(email.trim(), password, consent);
      await finish();
    });
  };

  const requestCode = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setError("Введите корректный адрес почты.");
    if (!consent) return setError("Нужно согласие на обработку персональных данных.");
    void run(async () => {
      await accountApiService.requestCode(email.trim(), consent);
      setCodeSent(true);
      setCode("");
    });
  };

  const resetPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError("Код состоит из шести цифр.");
    if (password.trim().length < MIN_PASSWORD) return setError(`Пароль — не короче ${String(MIN_PASSWORD)} знаков.`);
    void run(async () => {
      await accountApiService.resetPassword(email.trim(), code, password);
      await finish();
    });
  };

  const verifyCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError("Код состоит из шести цифр.");
    void run(async () => {
      await accountApiService.verifyCode(email.trim(), code);
      await finish();
    });
  };

  const consentBox = (
    <Checkbox
      label={
        <>
          Согласен на{" "}
          <Link href="/legal/consent" className="underline">
            обработку персональных данных
          </Link>{" "}
          и принимаю{" "}
          <Link href="/legal/privacy" className="underline">
            политику конфиденциальности
          </Link>
        </>
      }
      checked={consent}
      onChange={(e) => setConsent(e.target.checked)}
    />
  );

  const emailField = (
    <Field label="Почта">
      <Input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        aria-label="Почта"
        placeholder="name@company.ru"
      />
    </Field>
  );

  const errorLine = error && (
    <p className="text-sm text-brick-fg" role="alert">
      {error}
    </p>
  );

  return (
    <div className="space-y-4">
      {(mode === "login" || mode === "register") && (
        <div className="grid grid-cols-2 rounded-control border border-border p-1" role="tablist">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => switchTo(m)}
              className={`rounded-control px-3 py-1.5 text-sm ${
                mode === m ? "bg-accent-subtle text-accent-fg font-medium" : "text-muted-foreground"
              }`}
            >
              {m === "login" ? "Вход" : "Регистрация"}
            </button>
          ))}
        </div>
      )}

      {mode === "login" && (
        <form onSubmit={login} className="space-y-4" noValidate>
          {emailField}
          <Field label="Пароль">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              aria-label="Пароль"
            />
          </Field>
          {errorLine}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Вхожу…" : "Войти"}
          </Button>
          {codeLogin && (
            <div className="flex justify-between gap-3 text-sm">
              <button
                type="button"
                className="text-muted-foreground underline hover:text-foreground"
                onClick={() => switchTo("code")}
              >
                Войти по коду из письма
              </button>
              <button
                type="button"
                className="text-muted-foreground underline hover:text-foreground"
                onClick={() => {
                  switchTo("reset");
                  setPassword("");
                }}
              >
                Забыли пароль?
              </button>
            </div>
          )}
        </form>
      )}

      {mode === "register" && (
        <form onSubmit={register} className="space-y-4" noValidate>
          {emailField}
          <Field label="Пароль" hint={`Не короче ${String(MIN_PASSWORD)} знаков`}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              aria-label="Пароль"
            />
          </Field>
          <Field label="Повторите пароль">
            <Input
              type="password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
              aria-label="Повторите пароль"
            />
          </Field>
          {consentBox}
          {errorLine}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Создаю аккаунт…" : "Зарегистрироваться"}
          </Button>
        </form>
      )}

      {mode === "reset" && !codeSent && (
        <form onSubmit={requestCode} className="space-y-4" noValidate>
          <p className="text-sm text-muted-foreground">
            Пришлём код на почту, после чего вы зададите новый пароль.
          </p>
          {emailField}
          {consentBox}
          {errorLine}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Отправляю…" : "Получить код"}
          </Button>
          <button type="button" className="w-full text-sm text-muted-foreground underline" onClick={() => switchTo("login")}>
            Вспомнил пароль
          </button>
        </form>
      )}

      {mode === "reset" && codeSent && (
        <form onSubmit={resetPassword} className="space-y-4" noValidate>
          <p className="text-sm text-muted-foreground">
            Код отправлен на <strong className="text-foreground">{email.trim()}</strong>. Он действует 10 минут.
          </p>
          <Field label="Код из письма">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Код из письма"
              placeholder="000000"
            />
          </Field>
          <Field label="Новый пароль" hint={`Не короче ${String(MIN_PASSWORD)} знаков`}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              aria-label="Новый пароль"
            />
          </Field>
          {errorLine}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Сохраняю…" : "Сохранить пароль и войти"}
          </Button>
        </form>
      )}

      {mode === "code" && !codeSent && (
        <form onSubmit={requestCode} className="space-y-4" noValidate>
          {emailField}
          {consentBox}
          {errorLine}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Отправляю…" : "Получить код"}
          </Button>
          <button type="button" className="w-full text-sm text-muted-foreground underline" onClick={() => switchTo("login")}>
            Войти с паролем
          </button>
        </form>
      )}

      {mode === "code" && codeSent && (
        <form onSubmit={verifyCode} className="space-y-4" noValidate>
          <p className="text-sm text-muted-foreground">
            Код отправлен на <strong className="text-foreground">{email.trim()}</strong>. Он действует 10 минут.
          </p>
          <Field label="Код из письма">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Код из письма"
              placeholder="000000"
            />
          </Field>
          {errorLine}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Проверяю…" : "Войти"}
          </Button>
          <button type="button" className="w-full text-sm text-muted-foreground underline" onClick={() => requestCode()}>
            Отправить код ещё раз
          </button>
        </form>
      )}

      <p className="text-xs text-faint">
        Регистрация с почтой Google (gmail.com) недоступна: используйте Яндекс, Mail.ru или
        корпоративную почту.
      </p>
    </div>
  );
}
