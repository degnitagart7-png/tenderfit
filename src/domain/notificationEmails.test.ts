import { describe, expect, it } from "vitest";

import type { DigestItem, DigestResult } from "@/domain/digest";
import {
  buildAnalysisReadyEmail,
  buildDigestEmail,
  buildEstimateReadyEmail,
  digestSubject,
  shortSubject,
} from "@/domain/notificationEmails";

const BASE = "https://tender-fit.ru";

function item(over: Partial<DigestItem> = {}): DigestItem {
  return {
    id: "0373100000126000001",
    regNumber: "0373100000126000001",
    subject: "Капитальный ремонт школы",
    customer: "Администрация района",
    region: "Республика Бурятия",
    price: 12_400_000,
    currency: "RUB",
    submissionEnd: "2026-10-16T06:00:00Z",
    fitScore: 82,
    url: `${BASE}/tenders/0373100000126000001`,
    ...over,
  };
}

function digest(over: Partial<DigestResult> = {}): DigestResult {
  return { fresh: [item()], totalFresh: 1, closing: [], inWork: [], isEmpty: false, ...over };
}

describe("buildDigestEmail", () => {
  it("тема: число новых по профилю, с правильным склонением", () => {
    expect(digestSubject({ totalFresh: 1 })).toBe("ТендерФит: 1 новая закупка по вашему профилю");
    expect(digestSubject({ totalFresh: 3 })).toBe("ТендерФит: 3 новые закупки по вашему профилю");
    expect(digestSubject({ totalFresh: 12 })).toBe("ТендерФит: 12 новых закупок по вашему профилю");
  });

  it("новых нет, но есть сроки и работа — тема про сроки", () => {
    const mail = buildDigestEmail({
      digest: digest({ fresh: [], totalFresh: 0, closing: [item()], inWork: [item({ id: "2", regNumber: "2", url: `${BASE}/tenders/2` })] }),
      timeZone: "Europe/Moscow",
      baseUrl: BASE,
    });

    expect(mail.subject).toBe("ТендерФит: сроки по вашим закупкам");
    expect(mail.html).toContain("Закрываются в ближайшие 48 часов");
    expect(mail.html).toContain("В работе");
    expect(mail.html).not.toContain(">Новые<");
  });

  it("строка закупки: предмет-ссылка, заказчик · регион, НМЦК, «подача до» по поясу клиента, оценка", () => {
    const irkutsk = buildDigestEmail({ digest: digest(), timeZone: "Asia/Irkutsk", baseUrl: BASE });
    const moscow = buildDigestEmail({ digest: digest(), timeZone: "Europe/Moscow", baseUrl: BASE });

    expect(irkutsk.html).toContain(`href="${BASE}/tenders/0373100000126000001"`);
    expect(irkutsk.html).toContain("Капитальный ремонт школы");
    expect(irkutsk.html).toContain("Администрация района · Республика Бурятия");
    expect(irkutsk.html).toContain("подача до 16.10 14:00");
    expect(moscow.html).toContain("подача до 16.10 09:00");
    expect(irkutsk.html).toContain("оценка 82");
    expect(irkutsk.html).toContain("НМЦК");
    expect(irkutsk.text).toContain("подача до 16.10 14:00");
    expect(irkutsk.text).toContain(`${BASE}/tenders/0373100000126000001`);
    expect(irkutsk.text).toContain("Администрация района · Республика Бурятия");
  });

  it("внизу: «Открыть все в ленте» и «Настроить или отключить письма» — со ссылками на ленту и настройки", () => {
    const mail = buildDigestEmail({ digest: digest(), timeZone: "Europe/Moscow", baseUrl: "https://staging.example.ru" });

    expect(mail.html).toContain('href="https://staging.example.ru/tenders"');
    expect(mail.html).toContain("Открыть все в ленте");
    expect(mail.html).toContain('href="https://staging.example.ru/settings/notifications"');
    expect(mail.html).toContain("Настроить или отключить письма");
    expect(mail.text).toContain("Открыть все в ленте: https://staging.example.ru/tenders");
    expect(mail.text).toContain("Настроить или отключить письма: https://staging.example.ru/settings/notifications");
  });

  it("новых больше показанных — «…и ещё N в ленте»", () => {
    const mail = buildDigestEmail({ digest: digest({ totalFresh: 14 }), timeZone: "Europe/Moscow", baseUrl: BASE });

    expect(mail.html).toContain("…и ещё 13 в ленте");
    expect(mail.text).toContain("…и ещё 13 в ленте");
  });

  it("чужой текст экранируется: предмет, заказчик и регион не становятся разметкой", () => {
    const mail = buildDigestEmail({
      digest: digest({ fresh: [item({ subject: '<script>alert("x")</script> & «ремонт»', customer: "ООО <b>Ромашка</b>" })] }),
      timeZone: "Europe/Moscow",
      baseUrl: BASE,
    });

    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>Ромашка</b>");
    expect(mail.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; «ремонт»");
    expect(mail.html).toContain("ООО &lt;b&gt;Ромашка&lt;/b&gt;");
  });

  it("цена не указана — так и сказано; не рубли — со своей валютой", () => {
    const mail = buildDigestEmail({
      digest: digest({ fresh: [item({ price: null }), item({ id: "2", regNumber: "2", price: 5000, currency: "USD", url: `${BASE}/tenders/2` })] }),
      timeZone: "Europe/Moscow",
      baseUrl: BASE,
    });

    expect(mail.text).toContain("НМЦК не указана");
    expect(mail.text).toContain("$");
  });

  it("есть и HTML, и текстовая версия", () => {
    const mail = buildDigestEmail({ digest: digest(), timeZone: "Europe/Moscow", baseUrl: BASE });

    expect(mail.html).toContain("<!doctype html>");
    expect(mail.text).toContain("НОВЫЕ");
  });
});

describe("buildAnalysisReadyEmail", () => {
  const base = { regNumber: "0373100000126000001", subject: "Капитальный ремонт школы", baseUrl: BASE };

  it("тема «Анализ готов: <предмет>»; итог сводки, противоречия и вопросы, кнопка на вкладку анализа", () => {
    const mail = buildAnalysisReadyEmail({
      ...base,
      summary: "Участвовать можно, но нужна СРО.",
      findings: 18,
      conflicts: 2,
      questions: 3,
    });

    expect(mail.subject).toBe("Анализ готов: Капитальный ремонт школы");
    expect(mail.html).toContain("Участвовать можно, но нужна СРО.");
    expect(mail.html).toContain("противоречий: 2, вопросов заказчику: 3");
    expect(mail.html).toContain('href="https://tender-fit.ru/tenders/0373100000126000001?tab=analysis"');
    expect(mail.html).toContain("Открыть анализ");
    expect(mail.text).toContain("противоречий: 2, вопросов заказчику: 3");
    expect(mail.text).toContain("https://tender-fit.ru/tenders/0373100000126000001?tab=analysis");
  });

  it("сводки нет — «Найдено выводов: N» и без строки о противоречиях", () => {
    const mail = buildAnalysisReadyEmail({ ...base, summary: null, findings: 7, conflicts: null, questions: null });

    expect(mail.html).toContain("Найдено выводов: 7");
    expect(mail.html).not.toContain("противоречий");
    expect(mail.text).not.toContain("противоречий");
  });

  it("пустой итог сводки не печатается пустой строкой", () => {
    const mail = buildAnalysisReadyEmail({ ...base, summary: "   ", findings: 4, conflicts: 0, questions: 0 });

    expect(mail.html).toContain("Найдено выводов: 4");
  });

  it("предмет в теме — до 70 знаков с многоточием и без переводов строк; в HTML экранируется", () => {
    const long = `Выполнение работ по капитальному\nремонту здания <школы> № 5 с благоустройством прилегающей территории и заменой инженерных сетей`;
    const mail = buildAnalysisReadyEmail({ ...base, subject: long, summary: null, findings: 1, conflicts: null, questions: null });

    const title = mail.subject.slice("Анализ готов: ".length);
    expect(title.length).toBe(70);
    expect(title.endsWith("…")).toBe(true);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).toContain("&lt;школы&gt;");
    expect(mail.html).not.toContain("<школы>");
  });

  it("shortSubject: короткое не меняется", () => {
    expect(shortSubject("Ремонт")).toBe("Ремонт");
    expect(shortSubject("a".repeat(70))).toBe("a".repeat(70));
    expect(shortSubject("a".repeat(71))).toBe(`${"a".repeat(69)}…`);
  });
});

describe("buildEstimateReadyEmail", () => {
  it("тема «Смета готова: <предмет>», итог из отчёта и ссылка на закупку", () => {
    const mail = buildEstimateReadyEmail({ subject: "Ремонт кровли", totalRub: 15_300_000, tenderId: "0373100000126000001", baseUrl: BASE });

    expect(mail.subject).toBe("Смета готова: Ремонт кровли");
    expect(mail.html).toContain("Итого с НДС");
    expect(mail.html).toContain("15");
    expect(mail.html).toContain('href="https://tender-fit.ru/tenders/0373100000126000001?tab=analysis"');
  });

  it("суммы в отчёте нет — письмо без неё", () => {
    const mail = buildEstimateReadyEmail({ subject: "Ремонт кровли", totalRub: null, tenderId: "1", baseUrl: BASE });

    expect(mail.html).not.toContain("Итого");
    expect(mail.text).not.toContain("Итого");
  });

  it("смета без закупки — ссылка на /estimate", () => {
    const mail = buildEstimateReadyEmail({ subject: "Моя смета", totalRub: null, tenderId: null, baseUrl: BASE });

    expect(mail.html).toContain('href="https://tender-fit.ru/estimate"');
    expect(mail.html).toContain("Открыть смету");
    expect(mail.text).toContain("https://tender-fit.ru/estimate");
  });

  it("предмет экранируется", () => {
    const mail = buildEstimateReadyEmail({ subject: "<img src=x onerror=1>", totalRub: null, tenderId: null, baseUrl: BASE });

    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });
});
