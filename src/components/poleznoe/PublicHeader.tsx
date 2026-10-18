import Link from "next/link";

import { LogoMark } from "@/components/brand/LogoMark";

/**
 * Шапка публичных страниц (раздел «Полезное»).
 *
 * Не AppShell: он для вошедшего пользователя, с меню кабинета и запросами к
 * API. Здесь гость из поиска: логотип ведёт на промо-страницу, рядом — вход и
 * регистрация. «Возможности» ведёт к якорю промо-страницы (#feed).
 */
export function PublicHeader() {
  return (
    <header className="pz-header">
      <div className="pz-header-in">
        <Link className="pz-brand" href="/" aria-label="ТендерФит, на главную">
          <LogoMark size={30} />
          <span>ТендерФит</span>
        </Link>
        <nav className="pz-nav" aria-label="Разделы сайта">
          <Link className="pz-nav-features" href="/#feed">
            Возможности
          </Link>
          <Link href="/poleznoe">Полезное</Link>
          <Link className="pz-nav-login" href="/login">
            Войти
          </Link>
          <Link className="pz-nav-reg" href="/login?mode=register">
            Регистрация
          </Link>
        </nav>
      </div>
    </header>
  );
}
