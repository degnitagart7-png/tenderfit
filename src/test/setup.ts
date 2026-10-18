import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { clearAllSharedRequests } from "@/lib/sharedRequest";

/**
 * Общие запросы клиентских сервисов (`lib/sharedRequest`) держат ответ
 * несколько секунд. Тесты подставляют разные ответы сервера на один адрес,
 * поэтому память сбрасывается после каждого теста.
 */
afterEach(() => {
  clearAllSharedRequests();
});

/**
 * jsdom не реализует Web API, нужные для якорной навигации карточки:
 * IntersectionObserver (отслеживание активного раздела) и matchMedia
 * (проверка prefers-reduced-motion перед плавной прокруткой).
 */

if (typeof globalThis.IntersectionObserver === "undefined") {
  class IntersectionObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    writable: true,
    configurable: true,
    value: IntersectionObserverStub,
  });
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
