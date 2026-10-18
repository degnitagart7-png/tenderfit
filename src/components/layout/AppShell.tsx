"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HelpCircle,
  LayoutDashboard,
  List,
  KanbanSquare,
  Newspaper,
  Calculator,
  Building2,
  Search,
  Bell,
  CreditCard,
  Menu,
  X,
  ChevronRight,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { ExpiredScreen } from "@/components/access/ExpiredScreen";
import { TrialBanner } from "@/components/access/TrialBanner";
import { useAccessGate } from "@/components/access/useAccessGate";
import { isOpenWhenExpired } from "@/domain/access";
import { clearChunkReloadAttempts } from "@/lib/chunkReload";
import { AccountLink } from "@/components/layout/AccountLink";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { LogoMark } from "@/components/brand/LogoMark";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Метка для тура по продукту (`data-tour`). */
  tour?: string;
}

/**
 * Меню продукта.
 *
 * Пунктов мало намеренно: пользователь — занятый подрядчик, а не аналитик.
 * «Импорт закупок» вызывается ссылкой «Добавить закупку вручную» на экране закупок,
 * «Журнал заданий» — служебная страница (/admin/jobs) без ссылки в меню:
 * внутри кнопка платной синхронизации Контур.Закупок, а ролей в приложении
 * нет, поэтому оплачивать тариф чужим кликом мы не даём.
 */
const mainNav: NavItem[] = [
  // Закупки первыми: это то, за чем сюда приходят. «Сегодня» — сводка, её
  // читают после рабочих разделов, поэтому она стоит после «Сметы».
  { href: "/tenders", label: "Закупки", icon: List },
  { href: "/pipeline", label: "Мои закупки", icon: KanbanSquare },
  { href: "/estimate", label: "Смета", icon: Calculator, tour: "nav-estimate" },
  { href: "/dashboard", label: "Сегодня", icon: LayoutDashboard },
  { href: "/reports/daily", label: "Отчёты", icon: Newspaper },
];

const settingsNav: NavItem[] = [
  { href: "/settings/profile", label: "Профиль компании", icon: Building2, tour: "nav-profile" },
  { href: "/settings/search", label: "Что ищем", icon: Search },
  { href: "/settings/notifications", label: "Уведомления", icon: Bell },
  { href: "/billing", label: "Оплата и тарифы", icon: CreditCard },
];

/** Раздел владельца: в меню только у администратора (ADMIN_EMAILS); сервер всё равно проверяет сам. */
const adminNav: NavItem[] = [{ href: "/admin/users", label: "Пользователи", icon: Users }];

const crumbLabels: Record<string, string> = {
  estimate: "Смета",
  dashboard: "Сегодня",
  tenders: "Закупки",
  import: "Добавить закупку",
  pipeline: "Мои закупки",
  reports: "Отчёты",
  daily: "Отчёты",
  admin: "Служебные",
  jobs: "Журнал заданий",
  users: "Пользователи",
  settings: "Настройки",
  profile: "Профиль компании",
  search: "Что ищем",
  notifications: "Уведомления",
  billing: "Оплата и тарифы",
  account: "Личный кабинет",
};

function useCrumbs(pathname: string): string[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return ["Сегодня"];
  const trail = parts.map((p) => crumbLabels[p] ?? p);
  // «Отчёты / Отчёты» для /reports/daily — шум без смысла: повторяющиеся
  // соседние подписи схлопываем.
  return ["ТендерФит", ...trail.filter((label, i) => label !== trail[i - 1])];
}

/** Микро-заголовок группы пунктов меню. */
function NavSection({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 mt-6 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
      {children}
    </p>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const crumbs = useCrumbs(pathname);
  const gate = useAccessGate();
  /*
    Пробный период закончился: вместо страницы — экран с тарифами. Оплата,
    кабинет и настройки открыты, чтобы человек мог выбрать тариф и увидеть свои
    данные. Пока ответ сервера не пришёл или доступ неизвестен (вход не настроен,
    сеть), страница показывается как обычно: платные ручки закрывает сервер.
  */
  const blocked = gate.access?.status === "expired" && !isOpenWhenExpired(pathname);

  // Оболочка открылась — значит, файлы сборки на месте: серия перезагрузок после выкладки закончена.
  useEffect(() => clearChunkReloadAttempts(), []);

  // Esc закрывает меню: обычное ожидание от выезжающей панели.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const isActive = (href: string): boolean =>
    pathname === href || pathname.startsWith(`${href}/`);

  /*
    Активный пункт — белая пилюля с тенью поверх глуховатой подложки сайдбара
    плюс короткая оранжевая риска слева. Приём с референса: риска отмечает
    место в списке даже боковым зрением, а цветной заливки на весь пункт
    (как было) в меню из семи строк оказывается слишком много.
  */
  const NavList = ({ items }: { items: NavItem[] }) => (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            aria-current={active ? "page" : undefined}
            data-tour={item.tour}
            className={cn(
              "relative flex items-center gap-2.5 rounded-control px-3 py-2 text-[15.5px] transition-colors",
              active
                ? "bg-panel font-medium text-foreground shadow-pill"
                : "text-muted-foreground hover:bg-panel/70 hover:text-foreground",
            )}
          >
            {active && (
              <span
                className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent"
                aria-hidden
              />
            )}
            <Icon
              className={cn(
                "h-[17px] w-[17px] shrink-0",
                active ? "text-accent" : "text-faint",
              )}
              strokeWidth={1.75}
              aria-hidden
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar — тёплая подложка, отделена линией, а не тенью. */}
      <aside
        className={cn(
          "w-[256px] shrink-0 bg-sidebar flex-col fixed inset-y-0 left-0 z-40 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          "border-r border-border",
          mobileOpen ? "flex translate-x-0" : "hidden lg:flex",
        )}
      >
        {/* Карточка рабочего пространства. Режим назван один раз — плашкой ниже. */}
        <div className="p-3">
          <div className="flex items-center gap-2.5 rounded-control border border-border bg-panel px-2.5 py-2 shadow-pill">
            <LogoMark size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold leading-tight tracking-tight text-foreground">
                ТендерФит
              </p>
            </div>
            {/* Закрытие панели: кнопка-гамбургер уходит под саму панель, и без
                крестика меню закрывалось только попаданием по затемнению. */}
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Закрыть меню"
              className="-mr-1 rounded-control p-1.5 text-muted-foreground hover:bg-panel-raised hover:text-foreground lg:hidden"
            >
              <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        </div>

        {/* Menu */}
        <div className="flex-1 overflow-y-auto px-3 pb-2">
          <NavSection>Главное</NavSection>
          <NavList items={mainNav} />
          <NavSection>Настройки</NavSection>
          <NavList items={settingsNav} />
          {gate.access?.status === "admin" && (
            <>
              <NavSection>Админ</NavSection>
              <NavList items={adminNav} />
            </>
          )}
        </div>

        {/* Тур по продукту — заново, по просьбе: сам он показывается один раз, после быстрого старта. */}
        <div className="border-t border-border px-3 py-2">
          <Link
            href="/tenders?tour=1&force=1"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-2.5 rounded-control px-3 py-2 text-[14.5px] text-muted-foreground transition-colors hover:bg-panel/70 hover:text-foreground"
          >
            <HelpCircle className="h-[17px] w-[17px] shrink-0 text-faint" strokeWidth={1.75} aria-hidden />
            Как пользоваться
          </Link>
        </div>

      </aside>

      {mobileOpen && (
        <div
          className="fixed inset-0 bg-ink/40 z-30 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 h-[62px] border-b border-border bg-background/85 px-4 backdrop-blur-sm lg:px-7 flex items-center gap-3">
          <button
            className="lg:hidden p-2 rounded-control hover:bg-panel-raised"
            onClick={() => setMobileOpen(true)}
            aria-label="Открыть меню"
          >
            <Menu
              className="h-5 w-5 text-muted-foreground"
              strokeWidth={1.75}
            />
          </button>

          {/*
            На узком экране печатается только текущий раздел: полная цепочка не
            помещалась, обрывалась на полуслове без многоточия и заезжала под
            аватар. Промежуточные звенья скрыты от скринридера вместе с
            разделителем — иначе он читал бы «слэш» подряд.
          */}
          <nav aria-label="Хлебные крошки" className="min-w-0 flex-1">
            <ol className="flex items-center gap-1 text-[14.5px] text-faint">
              {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <li
                    key={`${c}-${i}`}
                    className={cn(
                      "flex min-w-0 items-center gap-1",
                      !last && "hidden sm:flex",
                    )}
                  >
                    {i > 0 && (
                      <ChevronRight
                        className="hidden h-3.5 w-3.5 shrink-0 sm:inline"
                        strokeWidth={2}
                        aria-hidden
                      />
                    )}
                    <span
                      className={cn(
                        "truncate",
                        last && "font-semibold text-foreground",
                      )}
                    >
                      {c}
                    </span>
                  </li>
                );
              })}
            </ol>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <AccountLink />
          </div>
        </header>
        <TrialBanner access={gate.access} />
        {/* overflow-x-clip, а не hidden: hidden превращает main в scroll container
            и ломает position: sticky у дочерних элементов (якорная навигация карточки). */}
        <main className="flex-1 p-4 lg:p-7 overflow-x-clip">
          {blocked ? <ExpiredScreen email={gate.email} /> : children}
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
