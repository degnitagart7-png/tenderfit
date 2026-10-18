"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button, Card, Field, Input } from "@/components/ui/primitives";
import { describeError } from "@/lib/errors";
import { accountApiService } from "@/services/accountApiService";
import { accountSync } from "@/services/accountSync";

/**
 * Личный кабинет: кто вошёл, смена пароля, ссылки на свои настройки и выход.
 *
 * Профили поиска и анкета компании живут у аккаунта: после входа они те же на
 * любом устройстве (см. accountSync).
 */
export function AccountView() {
  const router = useRouter();
  const [state, setState] = useState<{ email: string | null; loaded: boolean; isAdmin: boolean }>({
    email: null,
    loaded: false,
    isAdmin: false,
  });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void accountApiService
      .me()
      .then((me) =>
        setState({ email: me.user?.email ?? null, loaded: true, isAdmin: me.user?.access?.status === "admin" }),
      )
      .catch(() => setState({ email: null, loaded: true, isAdmin: false }));
  }, []);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await accountApiService.changePassword(current, next);
      setCurrent("");
      setNext("");
      setNote({ kind: "ok", text: "Пароль изменён." });
    } catch (error) {
      setNote({ kind: "error", text: describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await accountApiService.logout();
    } finally {
      // Данные аккаунта не должны достаться следующему человеку в этом браузере.
      accountSync.onSignedOut();
      try {
        sessionStorage.removeItem("tenderfit.accountSynced");
      } catch {
        // noop
      }
      router.push("/login");
    }
  };

  if (!state.loaded) return <p className="muted">Загрузка…</p>;

  if (state.email === null) {
    return (
      <Card title="Личный кабинет">
        <p className="text-sm text-muted-foreground">
          Войдите или зарегистрируйтесь, чтобы ваши профили поиска и анкета компании сохранялись
          в аккаунте и были на любом устройстве.
        </p>
        <div className="mt-3">
          <Link href="/login" className="text-accent-fg hover:underline">
            Войти или зарегистрироваться
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Личный кабинет</h1>

      <Card title="Аккаунт">
        <p className="text-sm text-muted-foreground">
          Почта: <strong className="text-foreground">{state.email}</strong>
        </p>
        <ul className="mt-3 space-y-1 text-sm">
          <li>
            <Link href="/settings/search" className="text-accent-fg hover:underline">
              Профили поиска — что ищете и где
            </Link>
          </li>
          <li>
            <Link href="/settings/profile" className="text-accent-fg hover:underline">
              Профиль компании — для оценки «подходит / не подходит»
            </Link>
          </li>
        </ul>
        <div className="mt-4">
          <Button variant="outline" onClick={() => void logout()}>
            Выйти
          </Button>
        </div>
      </Card>

      {state.isAdmin && (
        <Card title="Админ-панель">
          <p className="text-sm text-muted-foreground">
            Кто пользуется сервисом, как часто, где у людей ошибки и сколько они стоят в рублях.
          </p>
          <div className="mt-3">
            <Link href="/admin/users" className="text-accent-fg hover:underline">
              Админ-панель: пользователи
            </Link>
          </div>
        </Card>
      )}

      <Card title="Пароль">
        <form onSubmit={(e) => void changePassword(e)} className="grid gap-3 sm:max-w-sm" noValidate>
          <Field label="Текущий пароль" hint="Если входили по коду из письма и пароля нет — оставьте пустым">
            <Input
              type="password"
              aria-label="Текущий пароль"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="Новый пароль" hint="Не короче 8 знаков">
            <Input
              type="password"
              aria-label="Новый пароль"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy || next.trim() === ""}>
            {busy ? "Сохраняю…" : "Сменить пароль"}
          </Button>
          {note && (
            <p role="status" className={`text-sm ${note.kind === "ok" ? "text-olive-fg" : "text-brick-fg"}`}>
              {note.text}
            </p>
          )}
        </form>
      </Card>
    </div>
  );
}
