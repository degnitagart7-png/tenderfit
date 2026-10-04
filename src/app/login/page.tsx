"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldCheck, Sparkles, FileSearch } from "lucide-react";
import { Button, Field, Input } from "@/components/ui/primitives";
import { authRepository } from "@/repositories/authRepository";
import { LEGAL_PAGES, OPERATOR } from "@/lib/legal";
import { STORAGE_KEYS, readJSON } from "@/lib/storage";
import { freeSourceTitles } from "@/domain/sources";
import { joinRuList } from "@/utils/format";

/*
  Площадки называет каталог источников, а не строка от руки: перечень менялся
  трижды за две недели, и экран входа отставал от него каждый раз. Документация
  упомянута с оговоркой — файлы отдаёт не каждая площадка (см. поле `documents`
  в `src/domain/sources.ts`), а обещать разбор по документации, которой нет,
  значит обещать то, чего сервис не делает.
*/
const FREE_SOURCES_TEXT = joinRuList(freeSourceTitles());

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@tenderfit.local");
  const [password, setPassword] = useState("demo12345");
  const [error, setError] = useState<string | null>(null);

  const goNext = (): void => {
    const onboardingDone = readJSON<boolean>(STORAGE_KEYS.onboardingDone, false);
    router.push(onboardingDone ? "/tenders" : "/onboarding");
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError("Введите корректный email");
      return;
    }
    if (password.length < 6) {
      setError("Пароль должен быть не короче 6 символов");
      return;
    }
    setError(null);
    authRepository.login(email);
    goNext();
  };

  /** Вход без пароля: проверка учётных данных ещё не реализована. */
  const enterWithoutPassword = (): void => {
    authRepository.login(
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "user@tenderfit.local",
    );
    goNext();
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/*
        Инфо-блок о продукте. Подложка тёмная (--ink), а не светлая: текст здесь
        белый, и на прежнем `bg-sidebar` он оказывался белым по белому — блок не
        читался вообще. Тёмная панель заодно даёт контраст входной форме справа.
      */}
      <div className="hidden lg:flex flex-col justify-center bg-ink text-white p-12">
        <div className="flex items-center gap-2.5 mb-10">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent text-[14.5px] font-bold">
            ТФ
          </div>
          <span className="text-lg font-semibold tracking-tight">ТендерФит</span>
        </div>
        <h1 className="mb-4 max-w-lg text-[34px] font-semibold leading-[1.15] tracking-tight">
          Не список закупок, а решение: участвовать или нет
        </h1>
        <p className="mb-9 max-w-md text-white/60">
          Сервис анализирует извещение, техзадание и проект контракта и объясняет,
          подходит ли закупка именно вашей компании — с доказательствами и рисками.
        </p>
        <ul className="space-y-4 text-sm text-white/85">
          <li className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10">
              <Sparkles className="h-4 w-4 text-accent" strokeWidth={2} aria-hidden />
            </span>
            <span>Персональный вердикт по пяти показателям соответствия</span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10">
              <FileSearch className="h-4 w-4 text-accent" strokeWidth={2} aria-hidden />
            </span>
            <span>Стоп-факторы и риски договора — с указанием источника</span>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10">
              <ShieldCheck className="h-4 w-4 text-accent" strokeWidth={2} aria-hidden />
            </span>
            <span>Ежедневный короткий список вместо десятков комплектов документов</span>
          </li>
        </ul>
      </div>

      {/* Форма входа */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h2 className="mb-1 text-[28px] font-semibold tracking-tight text-foreground">Вход</h2>
          <p className="muted mb-6">
            Закупки — из открытых источников: {FREE_SOURCES_TEXT}. Разбор идёт по
            извещению и документации, если площадка её отдаёт.
          </p>

          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="Email" error={error && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? error : undefined}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                aria-label="Email"
              />
            </Field>
            <Field
              label="Пароль"
              error={error && password.length < 6 ? error : undefined}
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-label="Пароль"
              />
            </Field>

            {error && (
              <p className="text-sm text-brick-fg" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full">
              Войти
            </Button>
            <Button type="button" variant="outline" className="w-full" onClick={enterWithoutPassword}>
              Войти без пароля
            </Button>
          </form>

          {/*
            Честно о двух ограничениях: пароль не проверяется, а профиль
            компании живёт в этом браузере. Обещать «вход» и молчать об этом —
            значит подставлять пользователя, который зайдёт с другого устройства
            и не найдёт своих данных.
          */}
          <p className="text-xs text-faint mt-6 text-center">
            Пароль пока не проверяется: полноценная регистрация появится позже. Профиль компании
            и настройки сохраняются в этом браузере — на другом устройстве их не будет.
          </p>

          {/*
            Документы доступны до входа: решение «оставлять ли здесь данные
            компании» принимается именно на этом экране, а не после него.
          */}
          <nav aria-label="Документы" className="mt-5 border-t border-border pt-4">
            <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
              {LEGAL_PAGES.map((p) => (
                <li key={p.href}>
                  <Link
                    href={p.href}
                    className="inline-flex py-1 text-[13.5px] text-muted-foreground hover:text-foreground"
                  >
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-center text-[13.5px] text-faint">
              {OPERATOR.fullName} · ИНН <span className="num">{OPERATOR.inn}</span>
            </p>
          </nav>
        </div>
      </div>
    </div>
  );
}
