import { readJsonOrThrow } from "@/lib/readJson";

/** Клиент ручки пробной сводки. Сообщение ошибки — слова сервера. */

export interface TestDigestResult {
  sent: boolean;
  /** Сколько строк ушло в письме. */
  items: number;
  /** Почему письма нет. */
  reason?: string;
}

export const notificationApiService = {
  async sendTestDigest(): Promise<TestDigestResult> {
    const response = await fetch("/api/notifications/test", { method: "POST" });
    return readJsonOrThrow<TestDigestResult>(response);
  },
};
