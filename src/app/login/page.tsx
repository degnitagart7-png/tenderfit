"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Gift, ShieldAlert, Sparkles } from "lucide-react";
import { AuthForm } from "@/components/auth/AuthForm";
import { safeNextPath } from "@/domain/loginRedirect";
import { LEGAL_PAGES, OPERATOR } from "@/lib/legal";
import { STORAGE_KEYS, readJSON } from "@/lib/storage";
import { freeSourceTitles } from "@/domain/sources";
import { joinRuList } from "@/utils/format";
import { LogoMark } from "@/components/brand/LogoMark";

/*
  Площадки называет каталог источников, а не строка от руки: перечень менялся
  трижды за две недели, и экран входа отставал от него каждый раз. Документация
  упомянута с оговоркой — файлы отдаёт не каждая площадка (см. поле `documents`
  в `src/domain/sources.ts`), а обещать разбор по документации, которой нет,
  значит обещать то, чего сервис не делает.
*/
const FREE_SOURCES_TEXT = joinRuList(freeSourceTitles());

const BENEFITS = [
  { icon: Sparkles, text: "Вердикт по пяти показателям: подходит ли закупка именно вам" },
  { icon: ShieldAlert, text: "Стоп-факторы и риски договора со ссылкой на источник" },
  { icon: FileSpreadsheet, text: "Смета по документации: считаем и проверяем" },
] as const;

/** Значок «7 дней бесплатно» — на тёмной подложке панели и в шапке телефона. */
function TrialBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-[13.5px] font-medium text-white ${className}`}
    >
      <span className="auth-pulse h-2 w-2 rounded-full bg-accent" aria-hidden />
      7 дней бесплатно, без карты
    </span>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark size={36} />
      <span className="text-lg font-semibold tracking-tight">ТендерФит</span>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  /*
    Куда после входа. Если человека привела сюда защита страниц (middleware), в
    адресе лежит `next` — туда и возвращаем, но только внутрь сайта: ссылка
    /login?next=//чужой-сайт не должна уводить вошедшего наружу (см.
    safeNextPath). Иначе решают данные аккаунта: AuthForm уже слил их с
    устройством. Анкета компании с названием — тоже признак пройденного
    онбординга: отметки нет у аккаунтов, заведённых до её синхронизации, и
    у сервера без колонки app_state, а спрашивать заново заполнившего анкету
    человека нельзя.
  */
  const goNext = (): void => {
    const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    if (next !== null) {
      router.push(next);
      return;
    }
    const onboardingDone = readJSON<boolean>(STORAGE_KEYS.onboardingDone, false);
    const profile = readJSON<{ name?: unknown } | null>(STORAGE_KEYS.profile, null);
    const hasCompany = typeof profile?.name === "string" && profile.name.trim() !== "";
    router.push(onboardingDone || hasCompany ? "/tenders" : "/onboarding");
  };

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Телефон: панель сжата до шапки — логотип и значок, без пересказа продукта. */}
      <header className="flex items-center justify-between gap-3 bg-ink px-5 py-4 text-white lg:hidden">
        <Logo />
        <TrialBadge className="px-3 py-1 text-[12.5px]" />
      </header>

      {/*
        Бренд-панель. Подложка тёмная (--ink), а не светлая: текст здесь белый, и
        на прежнем `bg-sidebar` он оказывался белым по белому. Свечение и сетка —
        статичные градиенты, без картинок: панель не должна задерживать первый
        показ формы.
      */}
      <aside className="relative hidden overflow-hidden bg-ink text-white lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div
          className="auth-glow pointer-events-none absolute -left-24 -top-24 h-[420px] w-[420px] rounded-full bg-accent/25 blur-[110px]"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse at 30% 40%, #000 20%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse at 30% 40%, #000 20%, transparent 75%)",
          }}
          aria-hidden
        />

        <div className="relative">
          <Logo />
        </div>

        <div className="auth-rise relative my-10 max-w-lg">
          <TrialBadge className="mb-6" />
          <h1 className="mb-4 text-[36px] font-semibold leading-[1.12] tracking-tight xl:text-[40px]">
            Какие закупки ваши — и почему
          </h1>
          <p className="mb-9 max-w-md text-[16px] leading-relaxed text-white/65">
            Сервис читает извещение, техзадание и проект контракта и объясняет, подходит ли закупка именно вашей
            компании, с доказательствами и рисками.
          </p>
          <ul className="space-y-4 text-[15px] text-white/90">
            {BENEFITS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/10">
                  <Icon className="h-4 w-4 text-accent" strokeWidth={2} aria-hidden />
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative max-w-md text-[13.5px] leading-relaxed text-white/45">
          Закупки из открытых источников: {FREE_SOURCES_TEXT}. Разбор идёт по извещению и документации, если
          площадка её отдаёт.
        </p>
      </aside>

      {/* Форма */}
      <main className="flex items-start justify-center px-4 py-8 sm:px-6 sm:py-12 lg:items-center lg:py-10">
        <div className="auth-rise-delayed w-full max-w-[26rem]">
          <div className="mb-6">
            <h2 className="mb-1.5 text-[28px] font-semibold tracking-tight text-foreground">Вход и регистрация</h2>
            <p className="flex items-start gap-2 text-[15px] leading-snug text-muted-foreground">
              <Gift className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
              <span>
                Введите почту — пришлём код. Нового аккаунта не нужно заводить отдельно: он создастся сам, первые 7 дней
                бесплатно, без карты.
              </span>
            </p>
          </div>

          <div className="card p-5 sm:p-7">
            <AuthForm onSignedIn={goNext} />
          </div>

          {/*
            Документы доступны до входа: решение «оставлять ли здесь данные
            компании» принимается именно на этом экране, а не после него.
          */}
          <nav aria-label="Документы" className="mt-6">
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
            <p className="mt-2 text-center text-[13px] text-faint">
              {OPERATOR.fullName} · ИНН <span className="num">{OPERATOR.inn}</span>
            </p>
          </nav>
        </div>
      </main>
    </div>
  );
}
