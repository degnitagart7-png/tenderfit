import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Главная страница сайта — промо, а не кабинет.
 *
 * Гость, пришедший из поиска или по ссылке, должен сначала увидеть, что сервис
 * делает, и только потом регистрироваться: вход и регистрация — кнопками в
 * правом верхнем углу, как у крупных агрегаторов. Кабинет живёт на своих
 * адресах (/tenders, /dashboard…) и по-прежнему закрыт защитой страниц.
 *
 * Страница — один статический файл `public/promo/index.html`: его же
 * показывают как артефакт при согласовании, и расхождений между «что
 * смотрели» и «что выложили» быть не может. Читается с диска на каждый
 * запрос, а кешируется на стороне браузера и nginx на десять минут.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const html = await readFile(join(process.cwd(), "public/promo/index.html"), "utf8");
  // Картинки в файле лежат относительными путями (так страница работает и как
  // артефакт при согласовании); с корня сайта они доступны только из /promo/.
  const body = html.replaceAll('src="img/', 'src="/promo/img/').replaceAll('href="report-example.docx"', 'href="/promo/report-example.docx"');
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}
