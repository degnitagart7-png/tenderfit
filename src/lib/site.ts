/**
 * Канонический адрес сайта.
 *
 * Берётся из переменной окружения, чтобы превью-развёртывания не выдавали
 * canonical и sitemap с адресом продакшена; фолбэк — рабочий домен.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://tender-fit.ru";
