"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Check, Eye, EyeOff, Gift, Lock, Mail, MailCheck } from "lucide-react";

import { CodeInput } from "@/components/auth/CodeInput";
import { Button, Checkbox } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { accountApiService } from "@/services/accountApiService";
import { accountSync } from "@/services/accountSync";

/**
 * Вход и регистрация — один путь: почта → код из письма → внутри.
 *
 * Раньше регистрация просила пароль дважды, галочку согласия и код, а вход и
 * регистрация жили на разных вкладках: человек выбирал вкладку, придумывал
 * пароль и только потом узнавал, что нужен ещё и код (замечание владельца
 * 16.10.2026). Теперь новому и старому клиенту одинаково: почта, код — и
 * аккаунт с пробным периодом создаётся сам (`verifyCode` заводит его на сервере).
 * Пароль не обязателен: кто его задал в кабинете, входит по ссылке «Войти с паролем».
 *
 * Без почтового сервера код не отправить — тогда остаются прежние вход и
 * регистрация по паролю: предлагать то, что не сработает, нельзя.
 *
 * После входа данные этого браузера (профили поиска, анкета компании)
 * сливаются с аккаунтом без потерь — см. accountSync.
 *
 * Ошибка показывается одним сообщением над кнопкой (role="alert"), а виноватое
 * поле подсвечивается красной рамкой: два сообщения подряд скринридер прочитал
 * бы дважды, а подсветка без текста не говорит, что исправить.
 */

type Mode = "start" | "login" | "register" | "reset";
type FieldName = "email" | "password" | "repeat" | "consent" | "code";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 8;
/** Через сколько секунд после отправки можно запросить код снова: столько же держит сервер. */
const RESEND_SECONDS = 60;

/** Обратный отсчёт в секундах: запуск, остаток и сброс. Таймер снимается вместе с компонентом. */
function useCountdown() {
  const [left, setLeft] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = (): void => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  };

  useEffect(() => stop, []);

  const start = (seconds: number): void => {
    stop();
    setLeft(seconds);
    timer.current = setInterval(() => {
      setLeft((prev) => {
        if (prev <= 1) {
          stop();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  return { left, start, reset: () => { stop(); setLeft(0); } };
}

/** Поле ввода с подписью, значком слева и рамкой ошибки. */
function TextField({
  label,
  hint,
  invalid,
  icon: Icon,
  trailing,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: React.ReactNode;
  invalid?: boolean;
  icon: typeof Mail;
  trailing?: React.ReactNode;
}) {
  const id = props.id ?? `f-${label}`;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <Icon
          className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-faint"
          strokeWidth={1.75}
          aria-hidden
        />
        <input
          {...props}
          id={id}
          aria-label={label}
          aria-invalid={invalid || undefined}
          className={cn(
            "input h-12 pl-11 text-[16px]",
            trailing !== undefined && "pr-12",
            invalid && "border-brick focus:border-brick focus:ring-brick/20",
          )}
        />
        {trailing}
      </div>
      {hint && <div className="mt-1.5 text-[13.5px] text-faint">{hint}</div>}
    </div>
  );
}

/** Пароль с кнопкой «показать / скрыть». */
function PasswordField({
  label,
  hint,
  invalid,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  hint?: React.ReactNode;
  invalid?: boolean;
  value: string;
  onChange: (next: string) => void;
  autoComplete: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      label={label}
      hint={hint}
      invalid={invalid}
      icon={Lock}
      type={shown ? "text" : "password"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      trailing={
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? "Скрыть пароль" : "Показать пароль"}
          aria-pressed={shown}
          className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-faint transition-colors hover:bg-panel-raised hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
        >
          {shown ? (
            <EyeOff className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          ) : (
            <Eye className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          )}
        </button>
      }
    />
  );
}

function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-control border border-brick-line bg-brick-subtle px-3 py-2.5 text-[14.5px] leading-snug text-brick-fg"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
      <span>{message}</span>
    </p>
  );
}

/** Подсказка длины пароля: становится зелёной с галочкой, когда требование выполнено. */
function PasswordHint({ password }: { password: string }) {
  const ok = password.trim().length >= MIN_PASSWORD;
  return (
    <span className={cn("inline-flex items-center gap-1.5", ok && "text-olive-fg")}>
      {ok && <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />}
      Не короче {String(MIN_PASSWORD)} знаков
    </span>
  );
}

const linkButton =
  "text-[14.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 rounded";

export function AuthForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("start");
  /** null — ещё не знаем, настроена ли почта на сервере. */
  const [codeLogin, setCodeLogin] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<FieldName | null>(null);
  const [busy, setBusy] = useState(false);
  const resend = useCountdown();

  useEffect(() => {
    void accountApiService
      .me()
      .then((state) => setCodeLogin(state.codeLoginEnabled === true))
      .catch(() => setCodeLogin(false));
  }, []);

  // Почта на сервере не настроена: код не придёт, остаётся вход по паролю.
  useEffect(() => {
    if (codeLogin === false) setMode((m) => (m === "start" ? "login" : m));
  }, [codeLogin]);

  const clearError = (): void => {
    setError(null);
    setErrorField(null);
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    clearError();
    setCodeSent(false);
    setCode("");
    resend.reset();
  };

  const finish = async () => {
    await accountSync.onSignedIn();
    onSignedIn();
  };

  const fail = (message: string, field: FieldName | null = null): void => {
    setError(message);
    setErrorField(field);
  };

  /** Выполняет обращение к серверу; отказ сервера — его словами, с подсветкой `field`. */
  const run = async (action: () => Promise<void>, field: FieldName | null = null) => {
    setBusy(true);
    clearError();
    try {
      await action();
    } catch (err) {
      fail(describeError(err), field);
    } finally {
      setBusy(false);
    }
  };

  const markSent = (): void => {
    setCodeSent(true);
    setCode("");
    resend.start(RESEND_SECONDS);
  };

  const login = (e: React.FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return fail("Введите корректный адрес почты.", "email");
    if (password === "") return fail("Введите пароль.", "password");
    void run(async () => {
      await accountApiService.login(email.trim(), password);
      await finish();
    }, "password");
  };

  const register = (e: React.FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return fail("Введите корректный адрес почты.", "email");
    if (password.trim().length < MIN_PASSWORD) {
      return fail(`Пароль — не короче ${String(MIN_PASSWORD)} знаков.`, "password");
    }
    if (password !== repeat) return fail("Пароли не совпадают.", "repeat");
    if (!consent) return fail("Нужно согласие на обработку персональных данных.", "consent");
    void run(async () => {
      await accountApiService.register(email.trim(), password, consent);
      await finish();
    }, "email");
  };

  /* Согласие на обработку данных — отдельной галочкой (решение владельца 16.10.2026). */
  const requestCode = (purpose: "login" | "reset") => (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return fail("Введите корректный адрес почты.", "email");
    if (!consent) return fail("Нужно согласие на обработку персональных данных.", "consent");
    void run(async () => {
      await accountApiService.requestCode(email.trim(), consent, purpose === "reset" ? "reset" : undefined);
      markSent();
    }, "email");
  };

  const resetPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return fail("Код состоит из шести цифр.", "code");
    if (password.trim().length < MIN_PASSWORD) {
      return fail(`Пароль — не короче ${String(MIN_PASSWORD)} знаков.`, "password");
    }
    void run(async () => {
      await accountApiService.resetPassword(email.trim(), code, password);
      await finish();
    }, "code");
  };

  /*
    Код уходит сам по шестой цифре, и Enter сразу следом отправил бы его второй раз:
    второй запрос получил бы «Код не подошёл» (код одноразовый), хотя вход уже прошёл.
    Состояние busy обновляется только со следующей отрисовкой, поэтому замок — в ref.
  */
  const verifying = useRef(false);
  const submitCode = (value: string): void => {
    if (!/^\d{6}$/.test(value)) return fail("Код состоит из шести цифр.", "code");
    if (verifying.current) return;
    verifying.current = true;
    void run(async () => {
      try {
        await accountApiService.verifyCode(email.trim(), value);
        await finish();
      } finally {
        verifying.current = false;
      }
    }, "code");
  };

  const verifyCode = (e: React.FormEvent) => {
    e.preventDefault();
    submitCode(code);
  };

  const consentBox = (
    <div>
      <Checkbox
        className={cn(
          "items-start gap-3 text-[14px] leading-snug",
          errorField === "consent" && "text-brick-fg",
        )}
        label={
          <span>
            Согласен на{" "}
            <Link href="/legal/consent" className="underline">
              обработку персональных данных
            </Link>{" "}
            и принимаю{" "}
            <Link href="/legal/privacy" className="underline">
              политику конфиденциальности
            </Link>
          </span>
        }
        checked={consent}
        onChange={(e) => {
          setConsent(e.target.checked);
          if (errorField === "consent") clearError();
        }}
        aria-invalid={errorField === "consent" || undefined}
      />
    </div>
  );

  const emailField = (
    <TextField
      label="Почта"
      icon={Mail}
      type="email"
      value={email}
      onChange={(e) => setEmail(e.target.value)}
      autoComplete="email"
      inputMode="email"
      placeholder="name@company.ru"
      invalid={errorField === "email"}
    />
  );

  /** Письмо с кодом: куда ушло, срок, поле кода и повторная отправка с отсчётом. */
  const codeBlock = (onComplete?: (value: string) => void) => (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-control border border-border bg-panel-raised px-3.5 py-3">
        <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
        <p className="text-[14.5px] leading-snug text-muted-foreground">
          Код отправлен на <strong className="break-all text-foreground">{email.trim()}</strong>. Он действует
          10 минут. Письма нет — проверьте папку «Спам».
        </p>
      </div>
      <div>
        <span className="label">Код из письма</span>
        <CodeInput
          value={code}
          onChange={(next) => {
            setCode(next);
            if (errorField === "code") clearError();
            // Шесть цифр — входим сразу: лишнее нажатие «Войти» после ввода кода никому не нужно.
            if (onComplete !== undefined && /^\d{6}$/.test(next) && !busy) onComplete(next);
          }}
          invalid={errorField === "code"}
          disabled={busy}
          autoFocus
        />
      </div>
    </div>
  );

  const resendButton = (action: () => void) => (
    <button
      type="button"
      className={cn(linkButton, "w-full text-center disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60")}
      onClick={action}
      disabled={busy || resend.left > 0}
    >
      {resend.left > 0 ? `Отправить код ещё раз через ${String(resend.left)} с` : "Отправить код ещё раз"}
    </button>
  );

  const backLink = (label: string, to: Mode) => (
    <button type="button" className={cn(linkButton, "inline-flex items-center gap-1.5 no-underline hover:underline")} onClick={() => switchTo(to)}>
      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      {label}
    </button>
  );

  return (
    <div className="space-y-5">
      {mode === "register" && (
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[19px] font-semibold tracking-tight text-foreground">Регистрация</h2>
          <button type="button" className={linkButton} onClick={() => switchTo("login")}>
            Уже есть аккаунт
          </button>
        </div>
      )}

      <div id="auth-panel" className="space-y-5">
        {mode === "start" && !codeSent && (
          <form onSubmit={requestCode("login")} className="space-y-4" noValidate>
            {emailField}
            {consentBox}
            <FormError message={error} />
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {busy ? "Отправляю код…" : "Продолжить"}
            </Button>
            <div className="text-center">
              <button
                type="button"
                className={linkButton}
                onClick={() => {
                  switchTo("login");
                  setPassword("");
                }}
              >
                Войти с паролем
              </button>
            </div>
          </form>
        )}

        {mode === "start" && codeSent && (
          <form onSubmit={verifyCode} className="space-y-4" noValidate>
            <h2 className="text-[19px] font-semibold tracking-tight text-foreground">Введите код из письма</h2>
            {codeBlock(submitCode)}
            <FormError message={error} />
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {busy ? "Проверяю…" : "Войти"}
            </Button>
            {resendButton(() => requestCode("login")())}
            <div className="text-center">
              <button
                type="button"
                className={linkButton}
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  clearError();
                  resend.reset();
                }}
              >
                Изменить почту
              </button>
            </div>
          </form>
        )}

        {mode === "login" && (
          <form onSubmit={login} className="space-y-4" noValidate>
            <h2 className="text-[19px] font-semibold tracking-tight text-foreground">Вход с паролем</h2>
            {emailField}
            <PasswordField
              label="Пароль"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              invalid={errorField === "password"}
            />
            <FormError message={error} />
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {busy ? "Вхожу…" : "Войти"}
            </Button>
            {codeLogin === true ? (
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-2">
                {backLink("Войти по коду из письма", "start")}
                <button
                  type="button"
                  className={linkButton}
                  onClick={() => {
                    switchTo("reset");
                    setPassword("");
                  }}
                >
                  Забыли пароль?
                </button>
              </div>
            ) : (
              <div className="text-center">
                <button type="button" className={linkButton} onClick={() => switchTo("register")}>
                  Создать аккаунт
                </button>
              </div>
            )}
          </form>
        )}

        {mode === "register" && !codeSent && (
          <form onSubmit={register} className="space-y-4" noValidate>
            <p className="flex items-center gap-2 rounded-control border border-olive-line bg-olive-subtle px-3 py-2 text-[14px] font-medium text-olive-fg">
              <Gift className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
              Первые 7 дней бесплатно, без карты
            </p>
            {emailField}
            <PasswordField
              label="Пароль"
              hint={<PasswordHint password={password} />}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              invalid={errorField === "password"}
            />
            <PasswordField
              label="Повторите пароль"
              value={repeat}
              onChange={setRepeat}
              autoComplete="new-password"
              invalid={errorField === "repeat"}
            />
            {consentBox}
            <FormError message={error} />
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {busy ? "Создаю аккаунт…" : "Зарегистрироваться"}
            </Button>
          </form>
        )}

        {mode === "reset" && !codeSent && (
          <form onSubmit={requestCode("reset")} className="space-y-4" noValidate>
            <div>
              <h2 className="text-[19px] font-semibold tracking-tight text-foreground">Восстановление пароля</h2>
              <p className="mt-1 text-[14.5px] text-muted-foreground">
                Пришлём код на почту, после чего вы зададите новый пароль.
              </p>
            </div>
            {emailField}
            {consentBox}
            <FormError message={error} />
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {busy ? "Отправляю…" : "Получить код"}
            </Button>
            <div className="text-center">{backLink("Вспомнил пароль", "login")}</div>
          </form>
        )}

        {mode === "reset" && codeSent && (
          <form onSubmit={resetPassword} className="space-y-4" noValidate>
            <h2 className="text-[19px] font-semibold tracking-tight text-foreground">Новый пароль</h2>
            {codeBlock()}
            <PasswordField
              label="Новый пароль"
              hint={<PasswordHint password={password} />}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              invalid={errorField === "password"}
            />
            <FormError message={error} />
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {busy ? "Сохраняю…" : "Сохранить пароль и войти"}
            </Button>
            {resendButton(() => requestCode("reset")())}
          </form>
        )}

      </div>

      <p className="text-[13px] leading-snug text-faint">
        Почта Google (gmail.com) не принимается — подойдут Яндекс, Mail.ru или рабочая почта.
      </p>
    </div>
  );
}
