import Link from "next/link";

export const metadata = { title: "Страница не найдена" };

/**
 * Своя 404 вместо системного экрана Next.js: тот показывался на английском,
 * без шапки и без единой ссылки — из него нельзя было вернуться в сервис.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5 py-16">
      <div className="w-full max-w-md text-center">
        <p className="num text-[14.5px] font-medium uppercase tracking-[0.12em] text-faint">
          Ошибка 404
        </p>
        <h1 className="mt-3 text-[26px] font-semibold leading-tight tracking-tight text-foreground">
          Такой страницы нет
        </h1>
        <p className="mt-3 text-[16px] leading-relaxed text-muted-foreground">
          Возможно, ссылка устарела или в адресе опечатка. Закупка могла быть удалена из
          источника — тогда её больше нет и в сервисе.
        </p>

        <div className="mt-7 flex flex-wrap justify-center gap-2.5">
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-control bg-accent px-4 py-2.5 text-sm font-medium text-panel hover:bg-accent-strong"
          >
            На главную
          </Link>
          <Link
            href="/tenders"
            className="inline-flex items-center justify-center rounded-control border border-border bg-panel px-4 py-2.5 text-sm font-medium text-foreground hover:bg-panel-raised"
          >
            К списку закупок
          </Link>
        </div>
      </div>
    </div>
  );
}
