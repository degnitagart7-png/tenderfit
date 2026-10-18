import { NextResponse, type NextRequest } from "next/server";

import { loginUrlWithNext } from "@/domain/loginRedirect";

/**
 * Вход обязателен: страницы приложения без сессионной куки ведут на /login.
 *
 * Работает на edge-рантайме, поэтому здесь нет ни базы, ни Node-модулей: только
 * наличие куки `tf_session`. Это отсев «гостей», а не проверка прав: поддельная
 * кука пропустит на страницу, но страница — оболочка, а данные и платные
 * действия отдают ручки API, и каждая проверяет сессию и срок доступа сама
 * (`requireAccess`). Просроченная сессия ловится на стороне страницы:
 * `/api/auth/me` вернёт гостя, и оболочка отправит на вход.
 *
 * Открыты: главная (промо-страница), /demo (лента на вымышленных данных), /login, /legal/*,
 * /poleznoe/* (статьи для поиска), llms.txt и llms-full.txt (тексты для ИИ-ассистентов),
 * robots.txt, sitemap.xml, иконки, картинка превью
 * ссылки (/opengraph-image — мессенджер забирает её без куки), `_next` и весь
 * /api — у API свои правила, а воркер ходит на него по `x-worker-secret` и
 * ключу владельца, без куки.
 *
 * Имя куки продублировано, а не импортировано из authRuntime: тот тянет
 * Node-модули (crypto, dns), которые на edge не собираются.
 *
 * AUTH_DISABLED=1 снимает проверку, но только вне production: локальная
 * разработка без базы и AUTH_SECRET иначе упёрлась бы в вечный /login.
 */
const SESSION_COOKIE = "tf_session";

export function middleware(request: NextRequest): NextResponse {
  if (process.env["NODE_ENV"] !== "production" && process.env["AUTH_DISABLED"] === "1") {
    return NextResponse.next();
  }
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  const target = request.nextUrl.clone();
  const login = new URL(loginUrlWithNext(`${pathname}${search}`), request.url);
  target.pathname = login.pathname;
  target.search = login.search;
  return NextResponse.redirect(target);
}

export const config = {
  matcher: [
    /*
      Всё, кроме: главной, /demo, /api, /_next, /login, /legal, /poleznoe, служебных файлов поискового
      индекса и ИИ-ассистентов (llms.txt прописан явно, хотя его закрыло бы и правило про расширение)
      и любого пути с расширением (иконки, картинки, шрифты).
    */
    "/((?!$|api(?:/|$)|_next/|login(?:/|$)|demo(?:/|$)|legal(?:/|$)|poleznoe(?:/|$)|llms(?:-full)?\\.txt$|robots\\.txt$|sitemap\\.xml$|icon(?:\\.[a-z]+)?$|apple-icon|opengraph-image|favicon\\.ico$|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
