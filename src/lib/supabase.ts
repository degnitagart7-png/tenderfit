import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Next.js кладёт ответы fetch в свой кэш данных и ключует его по URL, поэтому
 * второй вызов воркера получил закэшированные ответы PostgREST: ноль разобранных
 * фрагментов вместо трёх, пустую историю вердиктов и уже закрытую задачу как
 * «ожидающую». Итог — повторный разбор той же закупки и дубли строк
 * (21.09.2026, закупка 0573100026626000009). Очередь и результаты обязаны
 * читаться из базы, а не из кэша.
 */
const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

export function getSupabaseServerClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL is not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  client = createClient(url, key, { global: { fetch: noStoreFetch } });
  return client;
}
