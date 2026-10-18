import { AppShell } from "@/components/layout/AppShell";

/*
  Страницы приложения не кешируются. Собранная заранее страница отдавалась с
  «s-maxage=31536000», и после выкладки браузер или прокси мог держать старую
  версию: новые возможности ленты не появлялись, пока человек не сбросит кеш
  (замечание 05.10.2026). Данные лента всё равно грузит с сервера.
*/
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
